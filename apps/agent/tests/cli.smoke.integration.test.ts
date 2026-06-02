/**
 * CLI smoke tests — spawn the `sym` CLI as a real subprocess and verify
 * that the operator surface boots without error.
 *
 * These are integration tests (real subprocess) — they live in the
 * *.integration.test.ts namespace and are run via `pnpm test:integration`.
 *
 * Coverage:
 *   - `sym --help` exits 0 and prints the help surface
 *   - `sym -h` exits 0 (alias)
 *   - `sym help` exits 0 (alias)
 *   - Help output contains expected command names from the help text
 *   - `sym` with unknown command exits 1 (not a crash)
 */

import { execFile } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

// Path to the CLI entry-point, relative to this test file.
const AGENT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI_PATH = join(AGENT_ROOT, 'src/cli/index.ts');

/**
 * Spawn the sym CLI via tsx (TypeScript runner). Returns { stdout, stderr, code }.
 * Does NOT throw on non-zero exit so we can assert exit codes in tests.
 */
async function spawnSym(
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  // Use the tsx binary from the agent's node_modules (it's a dev dep there).
  const tsxBin = join(AGENT_ROOT, 'node_modules/.bin/tsx');
  try {
    const { stdout, stderr } = await execFileAsync(tsxBin, [CLI_PATH, ...args], {
      timeout: timeoutMs,
      env: {
        ...process.env,
        // Prevent the CLI from trying to contact a running agent
        // (sym status / sym apply contact localhost; we don't want that here).
        AGENT_PORT: '0',
        // Redirect config path to a temp location so we don't touch the real one.
        SYM_CONFIG_PATH: '/tmp/sym-smoke-test-config-' + String(process.pid) + '.json',
      },
    });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    // execFile rejects on non-zero exit; extract what we need.
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      code: e.code ?? 1,
    };
  }
}

// ---------------------------------------------------------------------------
// Smoke tests
// ---------------------------------------------------------------------------

describe('sym CLI smoke tests (real subprocess)', () => {
  it('exits 0 for --help and prints the help surface', async () => {
    const { stdout, stderr, code } = await spawnSym(['--help']);
    expect(code).toBe(0);
    // The help text should contain the primary command names
    const output = stdout + stderr;
    expect(output).toContain('sym');
    expect(output).toMatch(/status|connector|tools/i);
  });

  it('exits 0 for -h (alias for --help)', async () => {
    const { stdout, stderr, code } = await spawnSym(['-h']);
    expect(code).toBe(0);
    const output = stdout + stderr;
    expect(output).toContain('sym');
  });

  it('exits 0 for the help subcommand', async () => {
    const { stdout, stderr, code } = await spawnSym(['help']);
    expect(code).toBe(0);
    const output = stdout + stderr;
    expect(output).toContain('sym');
    // Help must mention the main verbs
    expect(output).toMatch(/status/i);
    expect(output).toMatch(/connector|connectors/i);
  });

  it('help output contains expected command names', async () => {
    const { stdout, code } = await spawnSym(['--help']);
    expect(code).toBe(0);
    // The HELP constant includes these verbs — pin them so a rename is caught.
    expect(stdout).toMatch(/sym\s+status/i);
    expect(stdout).toMatch(/connector/i);
    expect(stdout).toMatch(/tools/i);
    expect(stdout).toMatch(/secret/i);
    expect(stdout).toMatch(/apply/i);
  });

  it('exits 1 for an unknown command (not a crash/unhandled rejection)', async () => {
    const { stdout, stderr, code } = await spawnSym(['definitely-not-a-real-command-xyz']);
    expect(code).toBe(1);
    const output = stdout + stderr;
    // Should print an error message, not a stack trace / uncaught exception
    expect(output).toMatch(/unknown command/i);
  });
});
