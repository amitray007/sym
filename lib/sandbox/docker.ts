import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join, relative } from "node:path";
import { Readable, Writable } from "node:stream";
import {
  defineSandboxProvider,
  SANDBOX_AGENT_ENV,
  type SandboxConnection,
  type SandboxPrepareContext,
  type SandboxSessionContext,
  type SandboxSessionEndOptions,
  SandboxSessionGoneError,
} from "eve/sandbox/provider";
import { DEFAULT_SANDBOX_IMAGE, SANDBOX_LIMITS } from "./config.ts";

// Sym's Docker sandbox provider (decision 089), built on Eve's documented custom provider API
// (`defineSandboxProvider`). It differs from Eve's own Docker provider in three ways:
//
// - It builds no template image during `eve build`. A Dockerfile `RUN eve build` step has no
//   Docker daemon, so Eve's provider would record nothing to start from. Each session container
//   starts straight from the base image, which the first session pulls.
// - Each container gets memory, CPU, and process limits, drops every Linux capability, cannot
//   gain privileges (so `sudo` does nothing), and has no network unless the owner turns it on.
// - A container stops after a stretch with no sandbox call. Its files stay for the next call.
//
// It talks to Docker through the `docker` CLI, so DOCKER_HOST can point it at another host.
// The CLI runs with a reduced environment, and each container gets only SANDBOX_ENV: none of
// Sym's own variables or secrets reach a sandbox.

// The only environment a sandbox container gets. AI_AGENT tells agent-aware CLIs to skip prompts.
export const SANDBOX_ENV: Readonly<Record<string, string>> = { ...SANDBOX_AGENT_ENV };

// The workspace root, as on Eve's built-in providers. The image must give its default user a
// writable /workspace, as Eve's image does.
const WORKSPACE = "/workspace";
// A command touches this file, and the container stops after SANDBOX_LIMITS.idleSeconds without
// a touch.
const ACTIVE_FILE = "/tmp/.sym-sandbox-active";
const RESOURCES_DIR = "/tmp/.sym-sandbox-resources";
const LABEL = "sym.sandbox";

export interface DockerResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutBytes: Uint8Array;
}

export interface DockerStream {
  stdin?: WritableStream<Uint8Array>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  wait(): Promise<{ exitCode: number }>;
  kill(): Promise<void>;
}

// The `docker` CLI, injectable so tests can record calls without Docker.
export interface DockerCli {
  run(
    args: string[],
    options?: { signal?: AbortSignal; stdin?: Uint8Array },
  ): Promise<DockerResult>;
  stream(args: string[], options?: { signal?: AbortSignal; stdin?: boolean }): DockerStream;
}

export interface SymDockerOptions {
  // The base image. Default: Eve's published sandbox image.
  readonly image?: string;
  // True lets commands reach the network. Default: no network.
  readonly network?: boolean;
  // Seconds without a sandbox call before the container stops. Default: SANDBOX_LIMITS.
  readonly idleSeconds?: number;
}

// What `eve build` records: where the agent's skill and workspace files are, relative to Eve's
// sandbox cache directory, or null when there are none.
interface Artifact {
  [key: string]: number | string | null;
  version: 1;
  resources: string | null;
}

interface State {
  [key: string]: number | string;
  version: 1;
  container: string;
}

export const SymDockerSandbox = defineSandboxProvider({
  name: "sym-docker",
  stateProtocolVersion: 1,
  environment: (options: SymDockerOptions) => dockerLifecycle(options),
});

// Variables the docker CLI itself may need. Everything else, Sym's secrets included, stays out
// of the CLI's environment.
export function dockerCliEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([name]) =>
        ["PATH", "HOME", "TMPDIR", "XDG_RUNTIME_DIR"].includes(name) || name.startsWith("DOCKER_"),
    ),
  );
}

// The container's name, from the session that owns it.
export function containerName(sessionId: string): string {
  const hash = createHash("sha256").update(`sym-sandbox:${sessionId}`).digest("hex");
  return `sym-sbx-${hash.slice(0, 32)}`;
}

// The main process: it keeps the container up until no command has run for the idle limit.
export function keepaliveScript(idleSeconds: number = SANDBOX_LIMITS.idleSeconds): string {
  return [
    `f=${ACTIVE_FILE}`,
    `touch "$f"`,
    "while :; do",
    `  [ -e "$f" ] || touch "$f"`,
    `  [ $(( $(date +%s) - $(stat -c %Y "$f") )) -lt ${idleSeconds} ] || exit 0`,
    "  sleep 15",
    "done",
  ].join("\n");
}

// `docker run` arguments for a new session container.
export function runArgs(
  name: string,
  sessionId: string,
  options: { image: string; network: boolean; idleSeconds?: number },
): string[] {
  const args = [
    "run",
    "--detach",
    "--name",
    name,
    "--label",
    `${LABEL}=1`,
    "--label",
    `${LABEL}.session=${sessionId}`,
    // Reaps the zombies that background commands leave.
    "--init",
    "--memory",
    SANDBOX_LIMITS.memory,
    "--memory-swap",
    SANDBOX_LIMITS.memory,
    "--cpus",
    SANDBOX_LIMITS.cpus,
    "--pids-limit",
    String(SANDBOX_LIMITS.pids),
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--network",
    options.network ? "bridge" : "none",
    "--workdir",
    WORKSPACE,
  ];
  // NAME=value always: a bare NAME would copy the value from the CLI's own environment.
  for (const [key, value] of Object.entries(SANDBOX_ENV)) args.push("--env", `${key}=${value}`);
  args.push("--entrypoint", "/bin/sh", options.image, "-c", keepaliveScript(options.idleSeconds));
  return args;
}

export function dockerLifecycle(options: SymDockerOptions, cli: DockerCli = createDockerCli()) {
  const image = options.image ?? DEFAULT_SANDBOX_IMAGE;
  const network = options.network ?? false;
  const idleSeconds = options.idleSeconds ?? SANDBOX_LIMITS.idleSeconds;
  let daemon: Promise<void> | undefined;

  function ensureDaemon(): Promise<void> {
    daemon ??= checkDaemon(cli).catch((error: unknown) => {
      daemon = undefined;
      throw error;
    });
    return daemon;
  }

  async function status(name: string): Promise<"running" | "stopped" | "missing"> {
    const result = await cli.run(["container", "inspect", "--format", "{{.State.Running}}", name]);
    if (result.exitCode === 0) return result.stdout.trim() === "true" ? "running" : "stopped";
    if (/no such (container|object)/i.test(result.stderr)) return "missing";
    throw dockerError(result, `inspect sandbox container ${name}`);
  }

  // Starts a stopped container, or resets a running one's idle clock, so it cannot stop between
  // this check and the turn's first command.
  async function wake(name: string, current: "running" | "stopped"): Promise<void> {
    if (current === "running") {
      await cli.run(["exec", name, "touch", ACTIVE_FILE]);
      return;
    }
    const result = await cli.run(["start", name]);
    if (result.exitCode !== 0) throw dockerError(result, `start sandbox container ${name}`);
  }

  async function create(ctx: SandboxSessionContext, name: string, artifact: Artifact) {
    const present = await cli.run(["image", "inspect", "--format", "{{.Id}}", image]);
    if (present.exitCode !== 0) {
      const pulled = await cli.run(["pull", image]);
      if (pulled.exitCode !== 0) throw dockerError(pulled, `pull sandbox image ${image}`);
    }
    const started = await cli.run(runArgs(name, ctx.session.id, { image, network, idleSeconds }));
    if (started.exitCode !== 0) {
      // Another step of the same session created it first.
      if (/is already in use/i.test(started.stderr)) return;
      throw dockerError(started, `start sandbox container ${name}`);
    }
    const check = await cli.run([
      "exec",
      name,
      "bash",
      "-c",
      `mkdir -p ${WORKSPACE} && test -w ${WORKSPACE}`,
    ]);
    if (check.exitCode !== 0) {
      await cli.run(["rm", "--force", name]);
      throw new Error(
        `The sandbox image ${image} must provide bash and a ${WORKSPACE} its user can write.`,
      );
    }
    if (artifact.resources !== null) await copyResources(ctx, name, artifact.resources);
  }

  // Copies the agent's skill and workspace files, recorded by `eve build`, into a new container.
  // `docker cp` reads them on Sym's side, so this works when Docker runs on another host.
  async function copyResources(ctx: SandboxSessionContext, name: string, resources: string) {
    const source = isAbsolute(resources) ? resources : join(ctx.storagePath, resources);
    const copied = await cli.run(["cp", `${source}/.`, `${name}:${RESOURCES_DIR}`]);
    if (copied.exitCode !== 0) throw dockerError(copied, "copy skills into the sandbox");
    const placed = await cli.run([
      "exec",
      name,
      "bash",
      "-c",
      [
        "set -e",
        `src=${RESOURCES_DIR}`,
        `if [ -d "$src/workspace" ]; then cp -R "$src/workspace/." ${WORKSPACE}/; fi`,
        'if [ -d "$src/skills" ]; then mkdir -p "$HOME/.agents/skills"; cp -R "$src/skills/." "$HOME/.agents/skills/"; fi',
      ].join("\n"),
    ]);
    if (placed.exitCode !== 0) throw dockerError(placed, "place skills in the sandbox");
  }

  return {
    // Nothing to build: record where the skill and workspace files are, if any.
    async prepare(ctx: SandboxPrepareContext): Promise<Artifact> {
      const directory = await ctx.resourcesDirectory();
      return {
        version: 1,
        resources: directory === undefined ? null : relative(ctx.storagePath, directory),
      };
    },
    async start(ctx: SandboxSessionContext, _options: undefined, artifact: Readonly<Artifact>) {
      await ensureDaemon();
      const name = containerName(ctx.session.id);
      const current = await status(name);
      if (current === "missing") await create(ctx, name, artifact);
      else await wake(name, current);
      const state: State = { version: 1, container: name };
      return { connection: dockerConnection(cli, name), state };
    },
    async resume(
      _ctx: SandboxSessionContext,
      _artifact: Readonly<Artifact>,
      state: Readonly<State>,
    ) {
      if (state.version !== 1 || typeof state.container !== "string") {
        throw new SandboxSessionGoneError("The sandbox state is not one Sym recognizes.");
      }
      await ensureDaemon();
      const current = await status(state.container);
      if (current === "missing") {
        throw new SandboxSessionGoneError(`Sandbox container ${state.container} no longer exists.`);
      }
      await wake(state.container, current);
      return dockerConnection(cli, state.container);
    },
    async onSessionEnd(
      ctx: SandboxSessionContext,
      state: Readonly<State> | null,
      { signal }: SandboxSessionEndOptions,
    ) {
      const name = state?.container ?? containerName(ctx.session.id);
      const remove = async () => {
        await ensureDaemon();
        const removed = await cli.run(["rm", "--force", name], signal ? { signal } : {});
        if (removed.exitCode !== 0 && !/no such container/i.test(removed.stderr)) {
          throw dockerError(removed, `remove sandbox container ${name}`);
        }
      };
      // A session that never recorded a sandbox almost never has one. Without Docker, as with
      // the sandbox off, its cleanup is a quiet no-op instead of a retried failure.
      if (state === null) await remove().catch(() => undefined);
      else await remove();
    },
  };
}

async function checkDaemon(cli: DockerCli): Promise<void> {
  const result = await cli.run(["version", "--format", "{{.Server.Version}}"]);
  if (result.exitCode !== 0) {
    throw new Error(`Docker is not reachable from Sym: ${firstLine(result.stderr)}`);
  }
}

// Stops a spawned command and every process under it. The command's shell wrote its PID to $1.
const KILL_TREE = [
  'target=$(cat "$1" 2>/dev/null) || exit 0',
  '[ -n "$target" ] || exit 0',
  "kill_tree() {",
  "  local dir ppid",
  "  for dir in /proc/[0-9]*; do",
  "    ppid=$(sed -n 's/^PPid:[[:space:]]*//p' \"$dir/status\" 2>/dev/null)",
  '    [ "$ppid" = "$1" ] && kill_tree "$(basename "$dir")"',
  "  done",
  '  kill -9 "$1" 2>/dev/null',
  "}",
  'kill_tree "$target"',
  'rm -f "$1"',
].join("\n");

// The byte-level connection Eve builds its sandbox session from. Paths and scripts travel as
// separate arguments, never spliced into a shell string.
export function dockerConnection(cli: DockerCli, name: string): SandboxConnection<object> {
  return {
    workspaceRoot: WORKSPACE,
    async spawn({ command, env, workingDirectory, signal, stdin }) {
      const pidFile = `/tmp/.sym-sandbox-${randomUUID()}.pid`;
      const args = ["exec", ...(stdin ? ["--interactive"] : []), "--workdir", workingDirectory];
      for (const [key, value] of Object.entries(env)) args.push("--env", `${key}=${value}`);
      const script = `touch ${ACTIVE_FILE} 2>/dev/null; echo "$$" > "$1"; bash -lc "$2"; status=$?; rm -f "$1"; exit $status`;
      args.push(name, "bash", "-c", script, "sym-sandbox", pidFile, command);
      const killTree = () =>
        cli
          .run(["exec", name, "bash", "-c", KILL_TREE, "sym-kill", pidFile])
          .then(() => undefined)
          .catch(() => undefined);
      const child = cli.stream(args, {
        ...(signal ? { signal } : {}),
        ...(stdin ? { stdin: true } : {}),
      });
      signal?.addEventListener("abort", () => void killTree(), { once: true });
      return {
        ...(child.stdin ? { stdin: child.stdin } : {}),
        stdout: child.stdout,
        stderr: child.stderr,
        wait: () => child.wait(),
        async kill() {
          await killTree();
          await child.kill();
        },
      };
    },
    async readFile({ path, signal }) {
      const result = await cli.run(
        [
          "exec",
          name,
          "bash",
          "-c",
          'if [ -e "$1" ]; then exec cat -- "$1"; else exit 43; fi',
          "sym-read",
          path,
        ],
        signal ? { signal } : {},
      );
      if (result.exitCode === 43) return null;
      if (result.exitCode !== 0) throw dockerError(result, `read ${path} in the sandbox`);
      return result.stdoutBytes;
    },
    async writeFiles({ files, signal }) {
      for (const file of files) {
        const result = await cli.run(
          [
            "exec",
            "--interactive",
            name,
            "bash",
            "-c",
            `touch ${ACTIVE_FILE} 2>/dev/null; mkdir -p -- "$(dirname -- "$1")" && cat > "$1"`,
            "sym-write",
            file.path,
          ],
          { stdin: file.content, ...(signal ? { signal } : {}) },
        );
        if (result.exitCode !== 0) throw dockerError(result, `write ${file.path} in the sandbox`);
      }
    },
    async removePath({ path, force, recursive, signal }) {
      const flags = `${recursive ? "r" : ""}${force ? "f" : ""}`;
      const result = await cli.run(
        ["exec", name, "rm", ...(flags ? [`-${flags}`] : []), "--", path],
        signal ? { signal } : {},
      );
      if (result.exitCode !== 0) throw dockerError(result, `remove ${path} in the sandbox`);
    },
    async stop() {
      await cli.run(["stop", "--time", "0", name]).catch(() => undefined);
    },
  };
}

function dockerError(result: DockerResult, action: string): Error {
  return new Error(`Could not ${action}: ${firstLine(result.stderr) || `exit ${result.exitCode}`}`);
}

function firstLine(text: string): string {
  return text.split("\n", 1)[0]?.trim() ?? "";
}

function dockerExecutable(): string {
  return process.env.EVE_DOCKER_PATH?.trim() || "docker";
}

// The real CLI. A missing binary reads as "Docker is not installed", not a crash.
export function createDockerCli(): DockerCli {
  return {
    run(args, options = {}) {
      return new Promise((resolve, reject) => {
        const child = spawn(dockerExecutable(), args, {
          env: dockerCliEnv(),
          stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
          ...(options.signal ? { signal: options.signal } : {}),
        });
        const out: Buffer[] = [];
        const err: Buffer[] = [];
        child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
        child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
        child.on("error", (error: NodeJS.ErrnoException) => reject(adaptSpawnError(error)));
        child.on("close", (code) => {
          const stdout = Buffer.concat(out);
          resolve({
            exitCode: code ?? 1,
            stdout: stdout.toString("utf8"),
            stderr: Buffer.concat(err).toString("utf8"),
            stdoutBytes: new Uint8Array(stdout),
          });
        });
        if (options.stdin !== undefined) child.stdin?.end(Buffer.from(options.stdin));
      });
    },
    stream(args, options = {}) {
      const child = spawn(dockerExecutable(), args, {
        env: dockerCliEnv(),
        stdio: ["pipe", "pipe", "pipe"],
        ...(options.signal ? { signal: options.signal } : {}),
      });
      if (options.stdin !== true) child.stdin.end();
      const exited = new Promise<number>((resolve, reject) => {
        child.on("error", (error: NodeJS.ErrnoException) => reject(adaptSpawnError(error)));
        child.on("close", (code) => resolve(code ?? 1));
      });
      exited.catch(() => undefined);
      return {
        ...(options.stdin === true
          ? { stdin: Writable.toWeb(child.stdin) as WritableStream<Uint8Array> }
          : {}),
        stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
        stderr: Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>,
        wait: async () => ({ exitCode: await exited }),
        async kill() {
          child.kill("SIGKILL");
          await exited.catch(() => undefined);
        },
      };
    },
  };
}

function adaptSpawnError(error: NodeJS.ErrnoException): Error {
  if (error.code === "ENOENT") {
    return new Error("The docker CLI is not installed where Sym runs.", { cause: error });
  }
  return error;
}
