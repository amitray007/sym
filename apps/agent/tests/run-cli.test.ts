/**
 * run_cli — allowlisted CLI execution (no shell).
 *
 * Real-wire: spawns actual `node` subprocesses to verify stdout capture, exit
 * codes, truncation, and timeout. Plus the allowlist boundary (the safety model).
 */

import { describe, expect, it } from 'vitest';

import { parseAllowlist, runCli } from '../src/run-cli.js';

describe('parseAllowlist', () => {
  it('parses comma-separated bare names', () => {
    const a = parseAllowlist('gog, gcloud ,gh');
    expect(a).not.toBe('*');
    if (a !== '*') expect([...a].sort()).toEqual(['gcloud', 'gh', 'gog']);
  });
  it('treats "*" as unrestricted', () => {
    expect(parseAllowlist('*')).toBe('*');
  });
  it('falls back to the default allowlist when unset', () => {
    const a = parseAllowlist(undefined);
    if (a !== '*') expect(a.has('gcloud')).toBe(true);
  });
});

describe('runCli', () => {
  const NODE = new Set<string>(['node']);

  it('rejects a binary not in the allowlist (never runs it)', async () => {
    const r = await runCli(['rm', '-rf', '/'], { allowlist: NODE });
    expect(r.ok).toBe(false);
    expect(r.code).toBeNull();
    expect(r.error).toMatch(/not in the CLI allowlist/);
  });

  it('rejects a path-y binary (bare names only)', async () => {
    const r = await runCli(['/usr/bin/node', '--version'], { allowlist: '*' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/bare command name/);
  });

  it('runs an allowlisted binary and captures stdout (real subprocess)', async () => {
    const r = await runCli(['node', '--version'], { allowlist: NODE });
    expect(r.ok).toBe(true);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^v\d+\./);
  });

  it('reports a non-zero exit code', async () => {
    const r = await runCli(['node', '-e', 'process.exit(3)'], { allowlist: NODE });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(3);
    expect(r.timedOut).toBe(false);
  });

  it('truncates output to maxChars', async () => {
    const r = await runCli(['node', '-e', 'process.stdout.write("x".repeat(1000))'], {
      allowlist: NODE,
      maxChars: 100,
    });
    expect(r.stdout.length).toBeLessThan(200);
    expect(r.stdout).toMatch(/truncated/);
  });

  it('kills and flags a command that exceeds the timeout', async () => {
    const r = await runCli(['node', '-e', 'setTimeout(() => {}, 5000)'], {
      allowlist: NODE,
      timeoutMs: 200,
    });
    expect(r.timedOut).toBe(true);
    expect(r.ok).toBe(false);
  });
});
