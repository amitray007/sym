// Connection names and token env vars (decision 045). Pure: no I/O and no Node built-ins.

// Eve accepts lowercase letters, digits, and dashes in a connection name, starting with a
// letter. Sym also keeps names short and without empty parts, so `example-tracker` works and
// `a--b` does not.
export const NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const MIN_NAME = 2;
const MAX_NAME = 31;

// Names Sym or Eve use themselves. A connection owns its name and every `<name>__` tool, so a
// connection named `owner` would take the memory tools. The others keep Sym's own words free.
const RESERVED = new Set([
  "connection",
  "connections",
  "eve",
  "job",
  "jobs",
  "memory",
  "no-reply",
  "owner",
  "playbook",
  "playbooks",
  "schedule",
  "schedules",
  "slack",
  "sym",
  "t3",
  "verifier",
  "worker",
  "workers",
]);

// Undefined for a good name, else the reason in plain words.
export function nameProblem(name: string): string | undefined {
  if (name.length < MIN_NAME || name.length > MAX_NAME || !NAME_PATTERN.test(name)) {
    return (
      `"${name.slice(0, 40)}" is not a connection name. Use ${MIN_NAME} to ${MAX_NAME} ` +
      "lowercase letters, digits, and single dashes, starting with a letter, such as example-tracker."
    );
  }
  if (RESERVED.has(name) || [...RESERVED].some((word) => name.startsWith(`${word}-`))) {
    return `"${name}" is a name Sym uses itself. Pick another name.`;
  }
  return undefined;
}

// The only env vars a connection may read. A connection can never read SLACK_BOT_TOKEN,
// DATABASE_URL, or any other secret of the deployment.
export const TOKEN_ENV_PATTERN = /^SYM_MCP_[A-Z0-9_]+_TOKEN$/;

// The env var that holds a token connection's bearer token: `example-tracker` reads
// SYM_MCP_EXAMPLE_TRACKER_TOKEN.
export function tokenEnvVar(name: string): string {
  return `SYM_MCP_${name.toUpperCase().replaceAll("-", "_")}_TOKEN`;
}

// Reads a connection token from the environment. It refuses any name outside the pattern, and
// it returns undefined for an unset or blank value.
export function readTokenEnv(
  envVar: string,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  if (!TOKEN_ENV_PATTERN.test(envVar)) {
    throw new Error(`Sym reads connection tokens only from SYM_MCP_<NAME>_TOKEN variables.`);
  }
  const value = env[envVar]?.trim();
  return value ? value : undefined;
}

// True when a usable token is set. A name outside the pattern counts as unset.
export function hasTokenEnv(
  envVar: string | null,
  env: Record<string, string | undefined> = process.env,
): boolean {
  try {
    return envVar !== null && readTokenEnv(envVar, env) !== undefined;
  } catch {
    return false;
  }
}
