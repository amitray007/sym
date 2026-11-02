import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxSessionContext } from "eve/sandbox/provider";
import { afterAll, describe, expect, it } from "vitest";
import {
  capStream,
  containerName,
  type DockerCli,
  type DockerResult,
  dockerConnection,
  dockerLifecycle,
} from "../lib/sandbox/docker.ts";

// Sym's Docker provider lifecycle (decision 089) against a fake Docker that keeps containers:
// setup that fails part way, a half-set-up container, concurrent starts, resume, and the caps
// on what Sym reads back.

const ok = (stdout = ""): DockerResult => ({
  exitCode: 0,
  stdout,
  stderr: "",
  stdoutBytes: new TextEncoder().encode(stdout),
});
const failed = (stderr: string, exitCode = 1): DockerResult => ({
  exitCode,
  stdout: "",
  stderr,
  stdoutBytes: new Uint8Array(),
});

// A fake Docker daemon: containers by name, each running and maybe ready.
function fakeDocker(options: { failWrites?: number } = {}) {
  const containers = new Map<string, { ready: boolean }>();
  const calls: string[][] = [];
  let failWrites = options.failWrites ?? 0;
  const cli: DockerCli = {
    async run(args) {
      calls.push(args);
      const name = args.find((arg) => arg.startsWith("sym-sbx-")) ?? "";
      switch (args[0]) {
        case "version":
          return ok("29.0.0");
        case "container":
          return containers.has(name) ? ok("true") : failed("Error: No such container");
        case "run":
          // Let a concurrent caller run while this one is between calls.
          await new Promise((resolve) => setTimeout(resolve, 5));
          if (containers.has(name)) return failed("Conflict. The container name is already in use");
          containers.set(name, { ready: false });
          return ok("id");
        case "rm":
          containers.delete(name);
          return ok();
        case "exec": {
          const box = containers.get(name);
          if (!box) return failed("Error: No such container");
          if (args.includes("test") && args.includes("/run/sym/ready")) {
            return box.ready ? ok() : failed("", 1);
          }
          if (args.includes("touch") && args.includes("/run/sym/ready")) box.ready = true;
          if (args.includes("sym-write") && failWrites > 0) {
            failWrites--;
            return failed("write failed: broken pipe");
          }
          return ok();
        }
        default:
          return ok();
      }
    },
    stream() {
      throw new Error("not used");
    },
  };
  return { cli, calls, containers };
}

const resources = mkdtempSync(join(tmpdir(), "sym-sandbox-resources-"));
mkdirSync(join(resources, "sym-docker", "skills", "notes"), { recursive: true });
writeFileSync(join(resources, "sym-docker", "skills", "notes", "SKILL.md"), "# Notes\n");

afterAll(() => rmSync(resources, { recursive: true, force: true }));

const ctx = (id = "session-1"): SandboxSessionContext => ({
  session: { id } as SandboxSessionContext["session"],
  kind: "session",
  storagePath: resources,
  resolveProjectPath: (path) => path,
});
const withSkills = { version: 1 as const, resources: "sym-docker" };
const plain = { version: 1 as const, resources: null };
const runs = (calls: string[][]) => calls.filter((args) => args[0] === "run").length;

describe("Sym's Docker provider lifecycle", () => {
  it("sets up a new container, copies skill files, and marks it ready", async () => {
    const docker = fakeDocker();
    await dockerLifecycle({}, docker.cli).start(ctx(), undefined, withSkills);
    const name = containerName("session-1");
    expect(docker.containers.get(name)).toEqual({ ready: true });
    expect(docker.calls).toContainEqual(
      expect.arrayContaining(["sym-write", "/tmp/home/.agents/skills/notes/SKILL.md"]),
    );
  });

  it("removes a container whose setup failed, and sets up a fresh one on the next start", async () => {
    const docker = fakeDocker({ failWrites: 1 });
    const lifecycle = dockerLifecycle({}, docker.cli);
    await expect(lifecycle.start(ctx(), undefined, withSkills)).rejects.toThrow(/broken pipe/);
    expect(docker.containers.size).toBe(0);

    await lifecycle.start(ctx(), undefined, withSkills);
    expect(docker.containers.get(containerName("session-1"))).toEqual({ ready: true });
    expect(runs(docker.calls)).toBe(2);
  });

  it("replaces a half-set-up container left by an earlier crash", async () => {
    const docker = fakeDocker();
    docker.containers.set(containerName("session-1"), { ready: false });
    await dockerLifecycle({}, docker.cli, { readyWaitMs: 20 }).start(ctx(), undefined, plain);
    expect(docker.calls).toContainEqual(["rm", "--force", containerName("session-1")]);
    expect(docker.containers.get(containerName("session-1"))).toEqual({ ready: true });
  });

  it("gives concurrent starts one container, set up once", async () => {
    const docker = fakeDocker();
    const lifecycle = dockerLifecycle({}, docker.cli);
    const [a, b] = await Promise.all([
      lifecycle.start(ctx(), undefined, withSkills),
      lifecycle.start(ctx(), undefined, withSkills),
    ]);
    expect(a.state).toEqual(b.state);
    expect(runs(docker.calls)).toBe(1);
  });

  it("waits for another process's setup instead of replacing it", async () => {
    const docker = fakeDocker();
    const name = containerName("session-1");
    docker.containers.set(name, { ready: false });
    setTimeout(() => docker.containers.set(name, { ready: true }), 30);
    await dockerLifecycle({}, docker.cli, { readyWaitMs: 2000 }).start(ctx(), undefined, plain);
    expect(runs(docker.calls)).toBe(0);
    expect(docker.calls.some((args) => args[0] === "rm")).toBe(false);
  });

  it("resumes a ready container and resets its idle clock as root", async () => {
    const docker = fakeDocker();
    const lifecycle = dockerLifecycle({}, docker.cli);
    const { state } = await lifecycle.start(ctx(), undefined, plain);
    docker.calls.length = 0;
    await lifecycle.resume(ctx(), plain, state);
    expect(docker.calls).toContainEqual([
      "exec",
      "--user",
      "root",
      state.container,
      "touch",
      "/run/sym/active",
    ]);
  });

  it("reports a removed or half-set-up container as gone, with its files", async () => {
    const docker = fakeDocker();
    const lifecycle = dockerLifecycle({}, docker.cli);
    const state = { version: 1 as const, container: containerName("session-1") };
    await expect(lifecycle.resume(ctx(), plain, state)).rejects.toThrow(/gone, with its files/);
    docker.containers.set(state.container, { ready: false });
    await expect(lifecycle.resume(ctx(), plain, state)).rejects.toThrow(/gone/);
    expect(docker.containers.size).toBe(0);
  });
});

describe("what Sym reads back from a sandbox", () => {
  it("refuses a file that is not regular or is too large", async () => {
    const answer = (args: string[]): DockerResult =>
      args.includes("/dev/zero")
        ? failed("it is not a regular file", 44)
        : { ...ok(), killed: "overflow" };
    const calls: { args: string[]; maxBytes?: number }[] = [];
    const cli: DockerCli = {
      async run(args, options) {
        calls.push({ args, ...(options?.maxBytes ? { maxBytes: options.maxBytes } : {}) });
        return answer(args);
      },
      stream() {
        throw new Error("not used");
      },
    };
    const connection = dockerConnection(cli, "sym-sbx-a", { readBytes: 1000 });
    await expect(connection.readFile({ path: "/dev/zero" })).rejects.toThrow(/not a regular file/);
    await expect(connection.readFile({ path: "/workspace/big" })).rejects.toThrow(
      /larger than 1000 bytes/,
    );
    const read = calls.find((call) => call.args.includes("sym-read"));
    expect(read?.maxBytes).toBe(1000);
    expect(read?.args.at(-1)).toBe("1000");
  });

  it("stops a command whose output passes the cap", async () => {
    let killed = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(400).fill(65));
      },
    });
    const text = await new Response(capStream(source, 1000, () => killed++)).text();
    expect(text.startsWith("A".repeat(1000))).toBe(true);
    expect(text).toContain("Sym stopped the command: output passed 1000 bytes");
    expect(killed).toBe(1);
  });

  it("caps a spawned command's stdout and kills it", async () => {
    const calls: string[][] = [];
    let streamKilled = false;
    const cli: DockerCli = {
      async run(args) {
        calls.push(args);
        return ok();
      },
      stream() {
        return {
          stdout: new ReadableStream({
            pull: (controller) => controller.enqueue(new Uint8Array(512).fill(66)),
          }),
          stderr: new ReadableStream({ start: (controller) => controller.close() }),
          wait: async () => ({ exitCode: 137 }),
          kill: async () => {
            streamKilled = true;
          },
        };
      },
    };
    const child = await dockerConnection(cli, "sym-sbx-a", { outputBytes: 2048 }).spawn({
      command: "cat /dev/zero",
      env: {},
      workingDirectory: "/workspace",
    });
    const out = await new Response(child.stdout).text();
    expect(out.length).toBeLessThan(2200);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(streamKilled).toBe(true);
    expect(calls.some((args) => args.includes("sym-kill"))).toBe(true);
  });
});
