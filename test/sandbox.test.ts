import type { SandboxSessionContext } from "eve/sandbox/provider";
import type { ToolContext } from "eve/tools";
import { describe, expect, it, vi } from "vitest";
import bashTool from "../agent/tools/bash.ts";
import globTool from "../agent/tools/glob.ts";
import grepTool from "../agent/tools/grep.ts";
import readFileTool from "../agent/tools/read_file.ts";
import writeFileTool from "../agent/tools/write_file.ts";
import { NOT_FOR_WORKERS, WORKER_PRINCIPAL } from "../lib/callers.ts";
import { capabilityInstructions } from "../lib/capabilities.ts";
import {
  carriesSecret,
  DEFAULT_SANDBOX_IMAGE,
  sandboxEnabled,
  sandboxImage,
  sandboxNetwork,
  sandboxProvider,
} from "../lib/sandbox/config.ts";
import {
  containerName,
  type DockerCli,
  type DockerResult,
  dockerCliEnv,
  dockerConnection,
  dockerLifecycle,
  runArgs,
  SANDBOX_ENV,
} from "../lib/sandbox/docker.ts";
import { sandboxEnvironment } from "../lib/sandbox/environment.ts";
import { CARRIES_SECRET, SANDBOX_OFF } from "../lib/sandbox/tools.ts";

// The sandbox (decision 089): Eve's tools behind Sym's checks, the provider choice, and Sym's
// Docker provider against a fake docker CLI.

const SECRETS = {
  SLACK_BOT_TOKEN: "xoxb-secret-bot-token",
  SLACK_SIGNING_SECRET: "signing-secret-value",
  AI_GATEWAY_API_KEY: "gateway-key-value",
  ANTHROPIC_API_KEY: "anthropic-key-value",
  DATABASE_URL: "postgres://sym:hunter22@db:5432/sym",
  POSTGRES_PASSWORD: "postgres-password",
  SYM_API_TOKEN: "sym-api-token-value",
  SYM_MCP_EXAMPLE_TRACKER_TOKEN: "tracker-token-value",
  T3_TOKEN: "t3-token-value",
  TS_AUTHKEY: "tskey-auth-value",
};

function ok(stdout = ""): DockerResult {
  return { exitCode: 0, stdout, stderr: "", stdoutBytes: new TextEncoder().encode(stdout) };
}

function failed(stderr: string, exitCode = 1): DockerResult {
  return { exitCode, stdout: "", stderr, stdoutBytes: new Uint8Array() };
}

// A docker CLI that records each call and answers from `answer`.
function fakeCli(answer: (args: string[]) => DockerResult = () => ok()) {
  const calls: string[][] = [];
  const cli: DockerCli = {
    async run(args) {
      calls.push(args);
      return answer(args);
    },
    stream(args) {
      calls.push(args);
      return {
        stdout: new ReadableStream({ start: (c) => c.close() }),
        stderr: new ReadableStream({ start: (c) => c.close() }),
        wait: async () => ({ exitCode: 0 }),
        kill: async () => undefined,
      };
    },
  };
  return { cli, calls };
}

function sessionContext(id = "session-1"): SandboxSessionContext {
  return {
    session: { id } as SandboxSessionContext["session"],
    kind: "session",
    storagePath: "/app/.eve/sandbox-cache",
    resolveProjectPath: (path) => path,
  };
}

function toolContext(options: { principalId?: string; getSandbox?: () => Promise<unknown> } = {}) {
  const getSandbox = vi.fn(options.getSandbox ?? (async () => ({})));
  const ctx = {
    session: { auth: { current: { principalId: options.principalId ?? "slack:T1:U1" } } },
    getSandbox,
  } as unknown as ToolContext;
  return { ctx, getSandbox };
}

const TOOLS = [
  ["bash", bashTool, { command: "echo hi" }],
  ["read_file", readFileTool, { filePath: "notes.txt" }],
  ["write_file", writeFileTool, { filePath: "notes.txt", content: "hello" }],
  ["glob", globTool, { pattern: "**/*.csv" }],
  ["grep", grepTool, { pattern: "total" }],
] as const;

describe("sandbox tool slots", () => {
  it.each(TOOLS)("%s keeps Eve's schema and refuses worker threads", async (_name, tool, input) => {
    expect(tool.inputSchema).toBeDefined();
    expect(tool.description.length).toBeGreaterThan(20);
    vi.stubEnv("SYM_SANDBOX", "on");
    const { ctx, getSandbox } = toolContext({ principalId: WORKER_PRINCIPAL });
    await expect(tool.execute(input as never, ctx)).rejects.toThrow(NOT_FOR_WORKERS);
    expect(getSandbox).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it.each(TOOLS)("%s says the sandbox is off without opening one", async (_name, tool, input) => {
    vi.stubEnv("SYM_SANDBOX", "off");
    const { ctx, getSandbox } = toolContext();
    await expect(tool.execute(input as never, ctx)).rejects.toThrow(SANDBOX_OFF);
    expect(getSandbox).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it("tells the brain the sandbox is unavailable when it cannot open, and keeps the reason short", async () => {
    vi.stubEnv("SYM_SANDBOX", "on");
    const { ctx } = toolContext({
      getSandbox: async () => {
        throw new Error("Docker is not reachable from Sym: Cannot connect\nsecond line");
      },
    });
    const call = bashTool.execute({ command: "echo hi" }, ctx);
    await expect(call).rejects.toThrow(/The sandbox is not available right now/);
    await expect(call).rejects.toThrow(/Docker is not reachable from Sym: Cannot connect\)/);
    await expect(call).rejects.not.toThrow(/second line/);
    vi.unstubAllEnvs();
  });

  it("refuses input that carries one of Sym's secrets", async () => {
    vi.stubEnv("SYM_SANDBOX", "on");
    vi.stubEnv("SLACK_BOT_TOKEN", SECRETS.SLACK_BOT_TOKEN);
    const { ctx, getSandbox } = toolContext();
    await expect(
      bashTool.execute({ command: `curl -H "Bearer ${SECRETS.SLACK_BOT_TOKEN}" x` }, ctx),
    ).rejects.toThrow(CARRIES_SECRET);
    await expect(
      writeFileTool.execute({ filePath: ".env", content: `TOKEN=${SECRETS.SLACK_BOT_TOKEN}` }, ctx),
    ).rejects.toThrow(CARRIES_SECRET);
    expect(getSandbox).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it("tells bash about the repository rule", () => {
    expect(bashTool.description).toContain("Never clone a repository to change it");
  });
});

describe("sandbox settings", () => {
  it("is off unless SYM_SANDBOX turns it on, with no network by default", () => {
    expect(sandboxEnabled({})).toBe(false);
    expect(sandboxEnabled({ SYM_SANDBOX: "on" })).toBe(true);
    expect(sandboxNetwork({})).toBe(false);
    expect(sandboxNetwork({ SYM_SANDBOX_NETWORK: "on" })).toBe(true);
    expect(sandboxImage({})).toBe(DEFAULT_SANDBOX_IMAGE);
    expect(sandboxImage({ SYM_SANDBOX_IMAGE: " example/sandbox:1 " })).toBe("example/sandbox:1");
  });

  it("chooses Docker for build and start, and just-bash for eve dev and eve eval", () => {
    expect(sandboxProvider({})).toBe("docker");
    expect(sandboxProvider({ NODE_ENV: "production" })).toBe("docker");
    expect(sandboxProvider({ EVE_DEV: "1" })).toBe("just-bash");
    expect(sandboxProvider({ EVE_EVALUATION: "1" })).toBe("just-bash");
    expect(sandboxEnvironment({}).provider).toBe("sym-docker");
    expect(sandboxEnvironment({ EVE_DEV: "1" }).provider).toBe("just-bash");
  });

  it("finds secrets by variable name and ignores short or ordinary values", () => {
    const env = { ...SECRETS, SYM_PERSONA: "casual-voice", SHORT_TOKEN: "abc" };
    expect(carriesSecret(`echo ${SECRETS.T3_TOKEN}`, env)).toBe(true);
    expect(carriesSecret("psql postgres://sym:hunter22@db:5432/sym", env)).toBe(true);
    expect(carriesSecret("echo casual-voice abc", env)).toBe(false);
  });

  it("tells the brain what the sandbox can do, from the same switches", () => {
    const off = capabilityInstructions({});
    expect(off).toContain("The sandbox is off");
    const on = capabilityInstructions({ SYM_SANDBOX: "on" });
    expect(on).toContain("You have a sandbox");
    expect(on).toContain("no network");
    expect(on).toContain("Never clone a repository to change it");
    expect(capabilityInstructions({ SYM_SANDBOX: "on", SYM_SANDBOX_NETWORK: "on" })).toContain(
      "can reach the network",
    );
  });
});

describe("Sym's Docker provider", () => {
  it("passes no secret to the container or the docker CLI", () => {
    const args = runArgs("sym-sbx-x", "session-1", { image: "img", network: false });
    const text = args.join(" ");
    for (const value of Object.values(SECRETS)) expect(text).not.toContain(value);
    // Every --env is NAME=value, so nothing is copied from the CLI's environment.
    const envs = args.flatMap((arg, i) => (args[i - 1] === "--env" ? [arg] : []));
    expect(envs).toEqual(Object.entries(SANDBOX_ENV).map(([k, v]) => `${k}=${v}`));
    expect(SANDBOX_ENV).toEqual({ AI_AGENT: "eve" });

    const cliEnv = dockerCliEnv({ ...SECRETS, PATH: "/bin", HOME: "/home/node", DOCKER_HOST: "x" });
    expect(cliEnv).toEqual({ PATH: "/bin", HOME: "/home/node", DOCKER_HOST: "x" });
  });

  it("limits the container and gives it no network by default", () => {
    const args = runArgs("sym-sbx-x", "session-1", { image: "img", network: false });
    const flag = (name: string) => args[args.indexOf(name) + 1];
    expect(flag("--network")).toBe("none");
    expect(flag("--memory")).toBe("1g");
    expect(flag("--memory-swap")).toBe("1g");
    expect(flag("--cpus")).toBe("1");
    expect(flag("--pids-limit")).toBe("256");
    expect(flag("--cap-drop")).toBe("ALL");
    expect(flag("--security-opt")).toBe("no-new-privileges");
    expect(args).toContain("--init");
    expect(args).not.toContain("--privileged");
    expect(args.some((arg) => arg.includes("docker.sock"))).toBe(false);
    const networked = runArgs("n", "s", { image: "img", network: true });
    expect(networked[networked.indexOf("--network") + 1]).toBe("bridge");
  });

  it("names a container from its session alone", () => {
    expect(containerName("session-1")).toBe(containerName("session-1"));
    expect(containerName("session-1")).not.toBe(containerName("session-2"));
    expect(containerName("session-1")).toMatch(/^sym-sbx-[0-9a-f]{32}$/);
  });

  it("records no template at build time, so the build needs no Docker", async () => {
    const { cli, calls } = fakeCli();
    const lifecycle = dockerLifecycle({}, cli);
    const artifact = await lifecycle.prepare({
      resourcesDirectory: async () => undefined,
      storagePath: "/app/.eve/sandbox-cache",
    } as never);
    expect(artifact).toEqual({ version: 1, resources: null });
    expect(calls).toEqual([]);
  });

  it("pulls the image, starts a limited container, and checks the workspace on first use", async () => {
    const { cli, calls } = fakeCli((args) => {
      if (args[0] === "container") return failed("Error: No such container: x");
      if (args[0] === "image") return failed("Error: No such image");
      return ok("29.0.0");
    });
    const lifecycle = dockerLifecycle({ image: "example/sandbox:1" }, cli);
    const { state } = await lifecycle.start(sessionContext(), undefined, {
      version: 1,
      resources: null,
    });
    expect(state).toEqual({ version: 1, container: containerName("session-1") });
    expect(calls.map((args) => args[0])).toEqual([
      "version",
      "container",
      "image",
      "pull",
      "run",
      "exec",
    ]);
    expect(calls[3]).toEqual(["pull", "example/sandbox:1"]);
    expect(calls[4]).toContain("example/sandbox:1");
  });

  it("copies recorded skill files into a new container", async () => {
    const { cli, calls } = fakeCli((args) =>
      args[0] === "container" ? failed("No such container") : ok(),
    );
    await dockerLifecycle({}, cli).start(sessionContext(), undefined, {
      version: 1,
      resources: "sym-docker/resources/abc",
    });
    const cp = calls.find((args) => args[0] === "cp");
    expect(cp?.[1]).toBe("/app/.eve/sandbox-cache/sym-docker/resources/abc/.");
  });

  it("restarts a stopped container and reports a removed one as gone", async () => {
    let running = "false";
    const { cli, calls } = fakeCli((args) => (args[0] === "container" ? ok(running) : ok()));
    const lifecycle = dockerLifecycle({}, cli);
    const state = { version: 1 as const, container: "sym-sbx-a" };
    await lifecycle.resume(sessionContext(), { version: 1, resources: null }, state);
    expect(calls).toContainEqual(["start", "sym-sbx-a"]);

    running = "true";
    calls.length = 0;
    await lifecycle.resume(sessionContext(), { version: 1, resources: null }, state);
    expect(calls.some((args) => args[0] === "start")).toBe(false);
    // A running container's idle clock restarts, so it cannot stop before the turn's command.
    expect(calls).toContainEqual(["exec", "sym-sbx-a", "touch", "/tmp/.sym-sandbox-active"]);

    const gone = dockerLifecycle(
      {},
      fakeCli((args) => (args[0] === "container" ? failed("No such container") : ok())).cli,
    );
    await expect(
      gone.resume(sessionContext(), { version: 1, resources: null }, state),
    ).rejects.toThrow(/no longer exists/);
  });

  it("fails with a clear reason when Docker is missing, and tries again next time", async () => {
    let up = false;
    const { cli } = fakeCli((args) =>
      args[0] === "version" && !up ? failed("Cannot connect to the Docker daemon") : ok("true"),
    );
    const lifecycle = dockerLifecycle({}, cli);
    const artifact = { version: 1 as const, resources: null };
    await expect(lifecycle.start(sessionContext(), undefined, artifact)).rejects.toThrow(
      "Docker is not reachable from Sym: Cannot connect to the Docker daemon",
    );
    up = true;
    await expect(lifecycle.start(sessionContext(), undefined, artifact)).resolves.toBeDefined();
  });

  it("removes the session's container when the session ends", async () => {
    const { cli, calls } = fakeCli((args) =>
      args[0] === "rm" ? failed("Error: No such container: x") : ok(),
    );
    await dockerLifecycle({}, cli).onSessionEnd(sessionContext(), null, { reason: "completed" });
    expect(calls.at(-1)).toEqual(["rm", "--force", containerName("session-1")]);
  });

  it("ends a session that never had a sandbox quietly when Docker is missing", async () => {
    const { cli } = fakeCli(() => failed("Cannot connect to the Docker daemon"));
    const lifecycle = dockerLifecycle({}, cli);
    await expect(
      lifecycle.onSessionEnd(sessionContext(), null, { reason: "completed" }),
    ).resolves.toBeUndefined();
    await expect(
      lifecycle.onSessionEnd(
        sessionContext(),
        { version: 1, container: "sym-sbx-a" },
        {
          reason: "completed",
        },
      ),
    ).rejects.toThrow(/Docker is not reachable/);
  });

  it("passes paths and commands as arguments, never spliced into a script", async () => {
    const { cli, calls } = fakeCli((args) => (args.includes("sym-read") ? failed("", 43) : ok()));
    const connection = dockerConnection(cli, "sym-sbx-a");
    const path = "/workspace/a'; rm -rf / #.txt";
    expect(await connection.readFile({ path })).toBeNull();
    expect(calls.at(-1)?.at(-1)).toBe(path);
    await connection.writeFiles({ files: [{ path, content: new Uint8Array([1]) }] });
    expect(calls.at(-1)?.at(-1)).toBe(path);
    await connection.spawn({
      command: "echo $HOME",
      env: { AI_AGENT: "eve" },
      workingDirectory: "/workspace",
    });
    const spawned = calls.at(-1) ?? [];
    expect(spawned.at(-1)).toBe("echo $HOME");
    expect(spawned).toContain("AI_AGENT=eve");
  });
});
