import { envSwitch } from "../env-switch.ts";

// The sandbox settings (decision 089). The sandbox is where the brain runs shell commands and
// reads or writes files: compute, files people share in Slack, small scripts. It holds no
// secrets and no repository credentials. Workers still do all repository work.

type Env = Record<string, string | undefined>;

// Eve's published sandbox image: Ubuntu with Node.js 24, Python 3, git, ripgrep, jq, and curl.
// Keep the tag in step with Eve's own default (`EVE_SANDBOX_IMAGE_TAG` in Eve's docs) when Eve
// is upgraded. `SYM_SANDBOX_IMAGE` replaces it.
export const DEFAULT_SANDBOX_IMAGE = "ghcr.io/vercel/eve:dockerfile-fc0279bf1664";

// Limits for each sandbox container. One container serves one Slack thread (one Eve session).
export const SANDBOX_LIMITS = {
  // Memory, with no extra swap. SYM_SANDBOX_MEMORY replaces it.
  memoryBytes: 1024 ** 3,
  cpus: "1",
  // Processes and threads, so a fork loop cannot exhaust the host.
  pids: 256,
  // The container is removed after this long with no sandbox call, with its files. A command
  // still running then stops, so this is also the time limit for a background command.
  idleSeconds: 30 * 60,
  // The largest file read_file or Eve reads back, a little over Slack's 25 MiB upload limit.
  readBytes: 32 * 1024 ** 2,
  // The most a command's stdout or stderr passes back to Sym. Past it the command is stopped.
  outputBytes: 8 * 1024 ** 2,
} as const;

// The sandbox's disk. The root filesystem is read-only, and the writable paths are memory-backed
// (tmpfs), which the kernel charges to the container's memory limit. So the files can never fill
// the host's disk. /workspace gets half the memory and /tmp (with $HOME) a quarter, leaving the
// rest for processes. A single file can be at most the workspace size.
export function sandboxDisk(memoryBytes: number = SANDBOX_LIMITS.memoryBytes) {
  const mib = (bytes: number) => Math.floor(bytes / 1024 ** 2);
  return {
    memory: `${mib(memoryBytes)}m`,
    workspace: `${mib(memoryBytes / 2)}m`,
    tmp: `${mib(memoryBytes / 4)}m`,
    fileBytes: mib(memoryBytes / 2) * 1024 ** 2,
  };
}

// `SYM_SANDBOX_MEMORY`, such as `2g` or `768m`, at least 256m. Anything else warns and uses 1g.
export function sandboxMemoryBytes(env: Env = process.env): number {
  const value = env.SYM_SANDBOX_MEMORY?.trim().toLowerCase();
  if (!value) return SANDBOX_LIMITS.memoryBytes;
  const match = /^(\d+)([mg])$/.exec(value);
  const bytes = match ? Number(match[1]) * 1024 ** (match[2] === "g" ? 3 : 2) : 0;
  if (bytes >= 256 * 1024 ** 2) return bytes;
  console.warn("SYM_SANDBOX_MEMORY must look like 768m or 2g, at least 256m. Using 1g.");
  return SANDBOX_LIMITS.memoryBytes;
}

// `SYM_SANDBOX=on` turns the sandbox on. Off by default, because production needs the Docker
// socket mount in compose.yaml. Off means no sandbox opens: the tools say so, and Slack files
// reach the brain as a note with their name instead of a file it can open.
export function sandboxEnabled(env: Env = process.env): boolean {
  return envSwitch(env.SYM_SANDBOX, false);
}

// `SYM_SANDBOX_NETWORK=on` lets sandbox commands reach the network. Off by default: the container
// has no network interface, so a command cannot send a shared file anywhere, reach the Docker
// host's private network, or read a cloud metadata endpoint.
export function sandboxNetwork(env: Env = process.env): boolean {
  return envSwitch(env.SYM_SANDBOX_NETWORK, false);
}

export function sandboxImage(env: Env = process.env): string {
  return env.SYM_SANDBOX_IMAGE?.trim() || DEFAULT_SANDBOX_IMAGE;
}

// Which sandbox provider this process uses. `eve dev` and `eve eval` (and so `pnpm test:e2e`)
// use just-bash, which needs no Docker. Everything else, `eve build` and `eve start` included,
// uses Sym's Docker provider. Eve sets EVE_DEV and EVE_EVALUATION itself, so a build and the
// server it produces always agree.
export function sandboxProvider(env: Env = process.env): "docker" | "just-bash" {
  return env.EVE_DEV === "1" || env.EVE_EVALUATION === "1" ? "just-bash" : "docker";
}

// Environment variable names that hold Sym's secrets. Their values must never enter the sandbox.
const SECRET_NAME =
  /(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|AUTHKEY|CREDENTIAL|DATABASE_URL)/i;
// Shorter values are too likely to match ordinary text.
const MIN_SECRET_LENGTH = 8;

// The values of Sym's secret environment variables.
export function secretValues(env: Env = process.env): string[] {
  return Object.entries(env)
    .filter(([name, value]) => SECRET_NAME.test(name) && (value?.length ?? 0) >= MIN_SECRET_LENGTH)
    .map(([, value]) => value as string);
}

// True when `text` carries one of Sym's secret values.
export function carriesSecret(text: string, env: Env = process.env): boolean {
  return secretValues(env).some((secret) => text.includes(secret));
}
