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
  // Memory, with no extra swap.
  memory: "1g",
  cpus: "1",
  // Processes and threads, so a fork loop cannot exhaust the host.
  pids: 256,
  // The container stops after this long with no sandbox call. Its files stay, and the next call
  // starts it again. A command still running then is stopped, so this is also the time limit
  // for a background command.
  idleSeconds: 30 * 60,
} as const;

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
