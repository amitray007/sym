import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
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
import { DEFAULT_SANDBOX_IMAGE, SANDBOX_LIMITS, sandboxDisk } from "./config.ts";

// Sym's Docker sandbox provider (decision 089), built on Eve's documented custom provider API
// (`defineSandboxProvider`). It differs from Eve's own Docker provider:
//
// - It builds no template image during `eve build`. A Dockerfile `RUN eve build` step has no
//   Docker daemon, so Eve's provider would record nothing to start from. Each session container
//   starts straight from the base image, which the first session pulls.
// - Each container gets memory, CPU, process, and file size limits, drops every Linux capability,
//   cannot gain privileges (so `sudo` does nothing), and has no network unless the owner turns
//   it on. Its root filesystem is read-only, and its writable paths are memory-backed, so it
//   cannot fill the host's disk.
// - It is removed, with its files, after a stretch with no sandbox call. Sym, not the sandbox,
//   keeps that clock: only root in the container can touch the activity file.
// - Every output Sym buffers is capped, and every call that can stall has a timeout.
//
// It talks to Docker through the `docker` CLI, so DOCKER_HOST can point it at another host.
// The CLI runs with a reduced environment, and each container gets only SANDBOX_ENV: none of
// Sym's own variables or secrets reach a sandbox.

const WORKSPACE = "/workspace";
// $HOME lives on the /tmp tmpfs, because the root filesystem is read-only.
const HOME = "/tmp/home";
// Root-owned and mode 0755, so the sandbox's user can read but not change what is in it.
const CONTROL_DIR = "/run/sym";
const ACTIVE_FILE = `${CONTROL_DIR}/active`;
const READY_FILE = `${CONTROL_DIR}/ready`;
const LABEL = "sym.sandbox";

// The only environment a sandbox container gets. AI_AGENT tells agent-aware CLIs to skip prompts.
export const SANDBOX_ENV: Readonly<Record<string, string>> = { ...SANDBOX_AGENT_ENV, HOME };

// Timeouts for docker calls, in milliseconds.
const CALL_TIMEOUT = 60_000;
const PULL_TIMEOUT = 15 * 60_000;
// How long start() waits for another caller to finish setting up a container.
const READY_WAIT = 30_000;

export interface DockerResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutBytes: Uint8Array;
  // Set when Sym stopped the call: its output passed `maxBytes`, or it ran past `timeoutMs`.
  killed?: "overflow" | "timeout";
}

export interface DockerRunOptions {
  signal?: AbortSignal;
  stdin?: Uint8Array;
  // The most stdout Sym keeps. Past it the call is stopped. Default 1 MiB.
  maxBytes?: number;
  timeoutMs?: number;
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
  run(args: string[], options?: DockerRunOptions): Promise<DockerResult>;
  stream(args: string[], options?: { signal?: AbortSignal; stdin?: boolean }): DockerStream;
}

export interface SymDockerOptions {
  // The base image. Default: Eve's published sandbox image.
  readonly image?: string;
  // True lets commands reach the network. Default: no network.
  readonly network?: boolean;
  // The container's memory, which also bounds its files. Default: SANDBOX_LIMITS.
  readonly memoryBytes?: number;
  // Seconds without a sandbox call before the container is removed. Default: SANDBOX_LIMITS.
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
  stateProtocolVersion: 2,
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

// The main process: it keeps the container up until Sym has not touched the activity file for
// the idle limit. Then it exits and Docker removes the container (`--rm`).
export function keepaliveScript(idleSeconds: number = SANDBOX_LIMITS.idleSeconds): string {
  return [
    'mkdir -p "$HOME"',
    "start=$(date +%s)",
    "while :; do",
    `  last=$(stat -c %Y ${ACTIVE_FILE} 2>/dev/null || echo "$start")`,
    `  [ $(( $(date +%s) - last )) -lt ${idleSeconds} ] || exit 0`,
    "  sleep 15",
    "done",
  ].join("\n");
}

// `docker run` arguments for a new session container.
export function runArgs(
  name: string,
  sessionId: string,
  options: { image: string; network: boolean; memoryBytes?: number; idleSeconds?: number },
): string[] {
  const disk = sandboxDisk(options.memoryBytes);
  const args = [
    "run",
    "--detach",
    // Gone when it stops: its files live in memory and would be gone anyway.
    "--rm",
    "--name",
    name,
    "--label",
    `${LABEL}=1`,
    "--label",
    `${LABEL}.session=${sessionId}`,
    // Reaps the zombies that background commands leave.
    "--init",
    "--memory",
    disk.memory,
    "--memory-swap",
    disk.memory,
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
    // Nothing writes to the image's layer, so nothing reaches the host's disk.
    "--read-only",
    "--tmpfs",
    `${WORKSPACE}:rw,exec,nosuid,nodev,size=${disk.workspace},mode=1777`,
    "--tmpfs",
    `/tmp:rw,exec,nosuid,nodev,size=${disk.tmp},mode=1777`,
    "--tmpfs",
    `${CONTROL_DIR}:rw,noexec,nosuid,nodev,size=1m,mode=0755`,
    "--ulimit",
    `fsize=${disk.fileBytes}:${disk.fileBytes}`,
    "--workdir",
    WORKSPACE,
  ];
  // NAME=value always: a bare NAME would copy the value from the CLI's own environment.
  for (const [key, value] of Object.entries(SANDBOX_ENV)) args.push("--env", `${key}=${value}`);
  args.push("--entrypoint", "/bin/sh", options.image, "-c", keepaliveScript(options.idleSeconds));
  return args;
}

// `readyWaitMs` is how long start() waits for another process's setup; tests shorten it.
export function dockerLifecycle(
  options: SymDockerOptions,
  cli: DockerCli = createDockerCli(),
  { readyWaitMs = READY_WAIT }: { readyWaitMs?: number } = {},
) {
  const image = options.image ?? DEFAULT_SANDBOX_IMAGE;
  const network = options.network ?? false;
  const memoryBytes = options.memoryBytes ?? SANDBOX_LIMITS.memoryBytes;
  const idleSeconds = options.idleSeconds ?? SANDBOX_LIMITS.idleSeconds;
  const fileBytes = sandboxDisk(memoryBytes).fileBytes;
  let daemon: Promise<void> | undefined;
  // One setup at a time per container in this process. Concurrent callers wait for it.
  const pending = new Map<string, Promise<void>>();

  function ensureDaemon(): Promise<void> {
    daemon ??= checkDaemon(cli).catch((error: unknown) => {
      daemon = undefined;
      throw error;
    });
    return daemon;
  }

  async function status(name: string): Promise<"running" | "stopped" | "missing"> {
    const result = await cli.run(["container", "inspect", "--format", "{{.State.Running}}", name], {
      timeoutMs: CALL_TIMEOUT,
    });
    if (result.exitCode === 0) return result.stdout.trim() === "true" ? "running" : "stopped";
    if (/no such (container|object)/i.test(result.stderr)) return "missing";
    throw dockerError(result, `inspect sandbox container ${name}`);
  }

  const asRoot = (name: string, ...command: string[]) =>
    cli.run(["exec", "--user", "root", name, ...command], { timeoutMs: CALL_TIMEOUT });

  async function isReady(name: string): Promise<boolean> {
    return (await asRoot(name, "test", "-e", READY_FILE)).exitCode === 0;
  }

  async function remove(name: string, signal?: AbortSignal) {
    const removed = await cli.run(["rm", "--force", name], {
      timeoutMs: CALL_TIMEOUT,
      ...(signal ? { signal } : {}),
    });
    if (removed.exitCode !== 0 && !/no such container/i.test(removed.stderr)) {
      throw dockerError(removed, `remove sandbox container ${name}`);
    }
  }

  // Waits for another process to finish setting up `name`. False when it does not in time.
  async function waitReady(name: string): Promise<boolean> {
    const deadline = Date.now() + readyWaitMs;
    do {
      if ((await status(name)) !== "running") return false;
      if (await isReady(name)) return true;
      await new Promise((resolve) => setTimeout(resolve, Math.min(500, readyWaitMs)));
    } while (Date.now() < deadline);
    return false;
  }

  async function create(ctx: SandboxSessionContext, name: string, artifact: Artifact) {
    const present = await cli.run(["image", "inspect", "--format", "{{.Id}}", image], {
      timeoutMs: CALL_TIMEOUT,
    });
    if (present.exitCode !== 0) {
      const pulled = await cli.run(["pull", image], { timeoutMs: PULL_TIMEOUT });
      if (pulled.exitCode !== 0) throw dockerError(pulled, `pull sandbox image ${image}`);
    }
    const started = await cli.run(
      runArgs(name, ctx.session.id, { image, network, memoryBytes, idleSeconds }),
      { timeoutMs: CALL_TIMEOUT },
    );
    if (started.exitCode !== 0) {
      // Another process created it first: wait for its setup, or replace a broken one.
      if (/is already in use/i.test(started.stderr)) {
        if (await waitReady(name)) return;
        await remove(name);
        return create(ctx, name, artifact);
      }
      throw dockerError(started, `start sandbox container ${name}`);
    }
    try {
      await initialize(ctx, name, artifact);
    } catch (error) {
      // A half-set-up container would look usable to the next start(). Remove it.
      await remove(name).catch(() => undefined);
      throw error;
    }
  }

  // Sets up a new container, then writes the ready marker. Only a ready container is used.
  async function initialize(ctx: SandboxSessionContext, name: string, artifact: Artifact) {
    await asRoot(name, "touch", ACTIVE_FILE);
    const check = await cli.run(
      ["exec", name, "bash", "-c", `mkdir -p "$HOME" && test -w ${WORKSPACE} && test -w "$HOME"`],
      { timeoutMs: CALL_TIMEOUT },
    );
    if (check.exitCode !== 0) {
      throw new Error(`The sandbox image ${image} must provide bash for its default user.`);
    }
    if (artifact.resources !== null) await copyResources(ctx, name, artifact.resources);
    const ready = await asRoot(name, "touch", READY_FILE);
    if (ready.exitCode !== 0) throw dockerError(ready, "mark the sandbox ready");
  }

  // Copies the agent's skill and workspace files, recorded by `eve build`, into a new container.
  // They travel through `docker exec`, so this works when Docker runs on another host.
  async function copyResources(ctx: SandboxSessionContext, name: string, resources: string) {
    const source = isAbsolute(resources) ? resources : join(ctx.storagePath, resources);
    const files: { path: string; content: Uint8Array }[] = [];
    for (const [part, target] of [
      ["workspace", WORKSPACE],
      ["skills", `${HOME}/.agents/skills`],
    ] as const) {
      const root = join(source, part);
      const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const full = join(entry.parentPath, entry.name);
        files.push({ path: `${target}/${relative(root, full)}`, content: await readFile(full) });
      }
    }
    await dockerConnection(cli, name, { fileBytes }).writeFiles({ files });
  }

  async function setUp(ctx: SandboxSessionContext, name: string, artifact: Artifact) {
    const current = await status(name);
    if (current === "running") {
      if (await isReady(name)) return;
      if (await waitReady(name)) return;
    }
    // Stopped, half set up, or missing: a fresh container.
    if (current !== "missing") await remove(name);
    await create(ctx, name, artifact);
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
      let setup = pending.get(name);
      if (!setup) {
        setup = setUp(ctx, name, artifact).finally(() => pending.delete(name));
        pending.set(name, setup);
      }
      await setup;
      await asRoot(name, "touch", ACTIVE_FILE);
      const state: State = { version: 1, container: name };
      return { connection: dockerConnection(cli, name, { fileBytes }), state };
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
      await pending.get(state.container)?.catch(() => undefined);
      const current = await status(state.container);
      // Its files lived in memory, so a stopped container has nothing left to resume.
      if (current !== "running" || !(await isReady(state.container))) {
        if (current !== "missing") await remove(state.container);
        throw new SandboxSessionGoneError(
          `Sandbox container ${state.container} is gone, with its files.`,
        );
      }
      await asRoot(state.container, "touch", ACTIVE_FILE);
      return dockerConnection(cli, state.container, { fileBytes });
    },
    async onSessionEnd(
      ctx: SandboxSessionContext,
      state: Readonly<State> | null,
      { signal }: SandboxSessionEndOptions,
    ) {
      const name = state?.container ?? containerName(ctx.session.id);
      const end = async () => {
        await ensureDaemon();
        await remove(name, signal);
      };
      // A session that never recorded a sandbox almost never has one. Without Docker, as with
      // the sandbox off, its cleanup is a quiet no-op instead of a retried failure.
      if (state === null) await end().catch(() => undefined);
      else await end();
    },
  };
}

async function checkDaemon(cli: DockerCli): Promise<void> {
  const result = await cli.run(["version", "--format", "{{.Server.Version}}"], {
    timeoutMs: CALL_TIMEOUT,
  });
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

// A regular file of at most $2 bytes goes to stdout. Anything else exits with a code Sym reads.
const READ_SCRIPT = [
  'p="$1"',
  '[ -e "$p" ] || exit 43',
  '[ -f "$p" ] || { echo "it is not a regular file" >&2; exit 44; }',
  'size=$(stat -L -c %s -- "$p") || exit 1',
  '[ "$size" -le "$2" ] || { echo "it is larger than $2 bytes" >&2; exit 45; }',
  // A file that grows after the check still stops at the limit.
  'exec head -c "$(( $2 + 1 ))" -- "$p"',
].join("\n");

// The byte-level connection Eve builds its sandbox session from. Paths and scripts travel as
// separate arguments, never spliced into a shell string.
export function dockerConnection(
  cli: DockerCli,
  name: string,
  limits: { fileBytes?: number; readBytes?: number; outputBytes?: number } = {},
): SandboxConnection<object> {
  const fileBytes = limits.fileBytes ?? sandboxDisk().fileBytes;
  const readBytes = limits.readBytes ?? SANDBOX_LIMITS.readBytes;
  const outputBytes = limits.outputBytes ?? SANDBOX_LIMITS.outputBytes;
  // Sym keeps the idle clock: the sandbox's user cannot touch this file.
  const touch = () =>
    cli
      .run(["exec", "--user", "root", name, "touch", ACTIVE_FILE], { timeoutMs: CALL_TIMEOUT })
      .catch(() => undefined);
  return {
    workspaceRoot: WORKSPACE,
    async spawn({ command, env, workingDirectory, signal, stdin }) {
      await touch();
      const pidFile = `/tmp/.sym-sandbox-${randomUUID()}.pid`;
      const args = ["exec", ...(stdin ? ["--interactive"] : []), "--workdir", workingDirectory];
      for (const [key, value] of Object.entries(env)) args.push("--env", `${key}=${value}`);
      // ulimit -f counts 1 KiB blocks.
      const script = `ulimit -f ${Math.floor(fileBytes / 1024)}; echo "$$" > "$1"; bash -lc "$2"; status=$?; rm -f "$1"; exit $status`;
      args.push(name, "bash", "-c", script, "sym-sandbox", pidFile, command);
      const killTree = () =>
        cli
          .run(["exec", name, "bash", "-c", KILL_TREE, "sym-kill", pidFile], {
            timeoutMs: CALL_TIMEOUT,
          })
          .then(() => undefined)
          .catch(() => undefined);
      const child = cli.stream(args, {
        ...(signal ? { signal } : {}),
        ...(stdin ? { stdin: true } : {}),
      });
      signal?.addEventListener("abort", () => void killTree(), { once: true });
      // Output past the cap stops the command, so `cat /dev/zero` cannot fill Sym's memory.
      let stopped = false;
      const overflow = () => {
        if (stopped) return;
        stopped = true;
        void killTree().then(() => child.kill());
      };
      return {
        ...(child.stdin ? { stdin: child.stdin } : {}),
        stdout: capStream(child.stdout, outputBytes, overflow),
        stderr: capStream(child.stderr, outputBytes, overflow),
        wait: () => child.wait(),
        async kill() {
          await killTree();
          await child.kill();
        },
      };
    },
    async readFile({ path, signal }) {
      await touch();
      const result = await cli.run(
        ["exec", name, "bash", "-c", READ_SCRIPT, "sym-read", path, String(readBytes)],
        { maxBytes: readBytes, timeoutMs: CALL_TIMEOUT, ...(signal ? { signal } : {}) },
      );
      if (result.exitCode === 43 && !result.killed) return null;
      if (result.killed === "overflow") {
        throw new Error(
          `Could not read ${path} in the sandbox: it is larger than ${readBytes} bytes`,
        );
      }
      if (result.exitCode !== 0 || result.killed) {
        throw dockerError(result, `read ${path} in the sandbox`);
      }
      return result.stdoutBytes;
    },
    async writeFiles({ files, signal }) {
      await touch();
      for (const file of files) {
        const result = await cli.run(
          [
            "exec",
            "--interactive",
            name,
            "bash",
            "-c",
            'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"',
            "sym-write",
            file.path,
          ],
          { stdin: file.content, timeoutMs: CALL_TIMEOUT, ...(signal ? { signal } : {}) },
        );
        if (result.exitCode !== 0 || result.killed) {
          throw dockerError(result, `write ${file.path} in the sandbox`);
        }
      }
    },
    async removePath({ path, force, recursive, signal }) {
      const flags = `${recursive ? "r" : ""}${force ? "f" : ""}`;
      const result = await cli.run(
        ["exec", name, "rm", ...(flags ? [`-${flags}`] : []), "--", path],
        { timeoutMs: CALL_TIMEOUT, ...(signal ? { signal } : {}) },
      );
      if (result.exitCode !== 0 || result.killed) {
        throw dockerError(result, `remove ${path} in the sandbox`);
      }
    },
    async stop() {
      await cli
        .run(["stop", "--time", "0", name], { timeoutMs: CALL_TIMEOUT })
        .catch(() => undefined);
    },
  };
}

// Passes at most `limit` bytes, then a note, then ends the stream and calls `onOverflow`.
export function capStream(
  source: ReadableStream<Uint8Array>,
  limit: number,
  onOverflow: () => void,
): ReadableStream<Uint8Array> {
  let seen = 0;
  return source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (seen + chunk.byteLength <= limit) {
          seen += chunk.byteLength;
          controller.enqueue(chunk);
          return;
        }
        controller.enqueue(chunk.subarray(0, limit - seen));
        seen = limit;
        controller.enqueue(
          new TextEncoder().encode(`\n[Sym stopped the command: output passed ${limit} bytes]\n`),
        );
        onOverflow();
        controller.terminate();
      },
    }),
  );
}

function dockerError(result: DockerResult, action: string): Error {
  const reason =
    result.killed === "timeout"
      ? "it took too long"
      : firstLine(result.stderr) || `exit ${result.exitCode}`;
  return new Error(`Could not ${action}: ${reason}`);
}

function firstLine(text: string): string {
  return text.split("\n", 1)[0]?.trim() ?? "";
}

function dockerExecutable(): string {
  return process.env.EVE_DOCKER_PATH?.trim() || "docker";
}

// The most stderr Sym keeps from one call.
const STDERR_BYTES = 64 * 1024;

// The real CLI. A missing binary reads as "Docker is not installed", not a crash. An early exit
// that breaks stdin, an output past `maxBytes`, and a call past `timeoutMs` settle the call;
// none of them throws out of an event handler.
export function createDockerCli(): DockerCli {
  return {
    run(args, options = {}) {
      const maxBytes = options.maxBytes ?? 1024 * 1024;
      return new Promise((resolve, reject) => {
        const child = spawn(dockerExecutable(), args, {
          env: dockerCliEnv(),
          stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
          ...(options.signal ? { signal: options.signal } : {}),
        });
        const out: Buffer[] = [];
        const err: Buffer[] = [];
        let outBytes = 0;
        let errBytes = 0;
        let killed: DockerResult["killed"];
        const stop = (reason: NonNullable<DockerResult["killed"]>) => {
          killed ??= reason;
          child.kill("SIGKILL");
        };
        const timer =
          options.timeoutMs === undefined
            ? undefined
            : setTimeout(() => stop("timeout"), options.timeoutMs);
        child.stdout?.on("data", (chunk: Buffer) => {
          if (killed) return;
          outBytes += chunk.byteLength;
          if (outBytes > maxBytes) return stop("overflow");
          out.push(chunk);
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          if (errBytes >= STDERR_BYTES) return;
          errBytes += chunk.byteLength;
          err.push(chunk);
        });
        // EPIPE when docker exits before reading all of stdin. The exit code says what happened.
        child.stdin?.on("error", () => undefined);
        child.on("error", (error: NodeJS.ErrnoException) => {
          clearTimeout(timer);
          reject(adaptSpawnError(error));
        });
        let settled = false;
        const finish = (code: number | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const stdout = Buffer.concat(out);
          resolve({
            exitCode: code ?? 1,
            stdout: stdout.toString("utf8"),
            stderr: Buffer.concat(err).toString("utf8").slice(0, STDERR_BYTES),
            stdoutBytes: new Uint8Array(stdout),
            ...(killed ? { killed } : {}),
          });
        };
        child.on("close", finish);
        // A stopped call settles when its process exits, even if a leftover child process still
        // holds the output pipes open.
        child.on("exit", (code) => {
          if (!killed) return;
          child.stdout?.destroy();
          child.stderr?.destroy();
          finish(code);
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
      // A broken stdin reaches the writer through the web stream; it must not crash Sym.
      child.stdin.on("error", () => undefined);
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
