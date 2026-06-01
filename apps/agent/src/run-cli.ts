/**
 * run_cli — execute an allowlisted CLI by argv (no shell).
 *
 * Full freedom WITHIN a binary allowlist: the allowlist is the safety boundary,
 * and inside it the agent may run any subcommand (reads and writes) without a
 * per-command confirmation. Guardrails that always apply:
 *   - argv array, spawned directly (NO shell) → no injection, no pipes/redirects.
 *   - argv[0] must be a bare allowlisted binary name (no paths).
 *   - hard timeout + output cap; every invocation is logged for audit.
 *
 * The allowlist comes from SYM_CLI_ALLOWLIST (comma-separated bare names);
 * `*` permits any binary. Default: the CLIs we install on /data/bin.
 */

import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

import { loadCliAllow } from './mcp/source.js';

export interface RunCliResult {
  ok: boolean;
  binary: string;
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  /** Set for allowlist/spawn failures (the command never ran). */
  error?: string;
}

export type Allowlist = Set<string> | '*';

// `sym` is included so the agent can introspect its OWN connectors/tools/health
// (`sym status`, `sym tools`, `sym show <name>` — all read-only, dense output).
const DEFAULT_ALLOWLIST = 'sym,gog,gcloud,gsutil,bq,sentry-cli,gh,jq';
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_CHARS = 20_000;

/** Parse SYM_CLI_ALLOWLIST into a Set (or `'*'` for unrestricted). */
export function parseAllowlist(raw: string | undefined): Allowlist {
  const value = (raw ?? DEFAULT_ALLOWLIST).trim();
  if (value === '*') return '*';
  return new Set(
    value
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

/** Build an Allowlist from a string array (`['*']` ⇒ wildcard). */
export function allowlistFromArray(arr: string[]): Allowlist {
  if (arr.includes('*')) return '*';
  return new Set(arr.map((s) => s.trim()).filter((s) => s.length > 0));
}

/**
 * Resolve the EFFECTIVE allowlist the same way for run_cli and the prompt
 * catalog: the config file's `cli.allow` when present (sym-managed), else the
 * `SYM_CLI_ALLOWLIST` env var, else the built-in default. Read fresh so
 * `sym cli add/rm` takes effect immediately (no agent restart).
 */
export function resolveAllowlist(): Allowlist {
  const fromFile = loadCliAllow();
  if (fromFile !== undefined) return allowlistFromArray(fromFile);
  return parseAllowlist(process.env['SYM_CLI_ALLOWLIST']);
}

function isAllowed(list: Allowlist, binary: string): boolean {
  return list === '*' || list.has(binary);
}

/**
 * A system-prompt block telling the model which CLIs it can drive via `run_cli`.
 * Appended per turn (so it reflects the current allowlist) and points the model
 * at `sym status` / `sym tools` for its LIVE connector + tool set.
 */
export function buildCliCatalog(allowlist: Allowlist): string {
  const lines = [
    '## Command-line tools (run_cli)',
    '',
    'Run an allowlisted CLI by argv array (no shell — no pipes/redirects).',
  ];
  if (allowlist === '*') {
    lines.push(
      'Allowlist: * — any CLI installed on the host is runnable. Run `["<cli>","--help"]` to discover one, then the real command.',
    );
  } else {
    const names = [...allowlist].sort().join(', ');
    lines.push(names.length > 0 ? `Available CLIs: ${names}.` : '(no CLIs allowlisted)');
  }
  lines.push(
    'Run `["sym","status"]` or `["sym","tools"]` to see your CURRENT connectors + tools and their health — these change at runtime, so check rather than assume.',
  );
  return lines.join('\n');
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]` : s;
}

function fail(binary: string, error: string): RunCliResult {
  return { ok: false, binary, stdout: '', stderr: '', code: null, timedOut: false, error };
}

const HELP_TOKENS = new Set(['-h', '--help', 'help', '-v', '--version', 'version']);

/**
 * True when an argv is pure introspection (help/version) — safe to run without
 * confirmation even under SYM_CLI_CONFIRM, since `--help` short-circuits before
 * any action runs. A bare binary (argv.length <= 1) also counts (prints usage).
 */
export function isIntrospectionOnly(argv: string[]): boolean {
  if (argv.length <= 1) return true;
  return argv.slice(1).some((a) => HELP_TOKENS.has(a));
}

export async function runCli(
  argv: string[],
  opts: { allowlist?: Allowlist; timeoutMs?: number; maxChars?: number; cwd?: string } = {},
): Promise<RunCliResult> {
  const allowlist = opts.allowlist ?? resolveAllowlist();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;

  const binary = argv[0];
  if (binary === undefined || binary.length === 0) {
    return fail('', 'argv must be a non-empty array, e.g. ["gog","gmail","--help"]');
  }
  if (binary.includes('/') || binary.includes('\\')) {
    return fail(
      binary,
      'binary must be a bare command name (no path), e.g. "gcloud" not "/usr/bin/gcloud"',
    );
  }
  if (!isAllowed(allowlist, binary)) {
    const names = allowlist === '*' ? '*' : [...allowlist].join(', ');
    return fail(
      binary,
      `'${binary}' is not in the CLI allowlist (${names}). Set SYM_CLI_ALLOWLIST to permit it.`,
    );
  }

  // Audit: every command the agent runs is logged.
  console.info(`[run_cli] ${argv.join(' ')}`);

  return new Promise<RunCliResult>((resolve) => {
    const child = spawn(binary, argv.slice(1), {
      cwd: opts.cwd ?? tmpdir(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', (err: Error) => {
      clearTimeout(timer);
      resolve(fail(binary, `spawn failed: ${err.message}`));
    });
    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      resolve({
        ok: !timedOut && code === 0,
        binary,
        stdout: truncate(stdout, maxChars),
        stderr: truncate(stderr, maxChars),
        code,
        timedOut,
        ...(timedOut ? { error: `timed out after ${timeoutMs}ms` } : {}),
      });
    });
  });
}
