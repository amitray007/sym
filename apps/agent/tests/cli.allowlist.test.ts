/**
 * run_cli allowlist in the config file — `sym cli` helpers + the file→env→default
 * resolution shared by run_cli and the prompt catalog. Real temp files.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  loadConfigFile,
  removeCli,
  setCliAllow,
  writeConfigFile,
} from '../src/cli/config-store.js';
import { resolveAllowlist } from '../src/run-cli.js';

let dir: string;
let cfgPath: string;
const saved = { cfg: process.env['SYM_CONFIG_PATH'], allow: process.env['SYM_CLI_ALLOWLIST'] };

const BASE = { version: 1, mcpServers: [] };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sym-allow-'));
  cfgPath = join(dir, 'config.json');
  process.env['SYM_CONFIG_PATH'] = cfgPath;
  delete process.env['SYM_CLI_ALLOWLIST'];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of [
    ['SYM_CONFIG_PATH', saved.cfg],
    ['SYM_CLI_ALLOWLIST', saved.allow],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('config-store cli helpers', () => {
  it('setCliAllow dedupes, trims, drops empties', () => {
    const next = setCliAllow(BASE, [' gh ', 'jq', 'gh', '', 'sym']);
    expect(next.cli?.allow).toEqual(['gh', 'jq', 'sym']);
  });

  it('removeCli removes present entries and reports them', () => {
    const cfg = setCliAllow(BASE, ['gh', 'jq', 'sym']);
    const { next, removed } = removeCli(cfg, ['jq', 'nope']);
    expect(next.cli?.allow).toEqual(['gh', 'sym']);
    expect(removed).toEqual(['jq']);
  });

  it('round-trips both mcpServers and cli through load/write', () => {
    const cfg = setCliAllow(
      { version: 1, mcpServers: [{ name: 'echo', transport: { kind: 'stdio', command: 'x' } }] },
      ['gh', 'sym'],
    );
    writeConfigFile(cfgPath, cfg);
    const back = loadConfigFile(cfgPath);
    expect(back.mcpServers.map((s) => s.name)).toEqual(['echo']);
    expect(back.cli?.allow).toEqual(['gh', 'sym']);
  });
});

describe('resolveAllowlist (file → env → default)', () => {
  it('uses the config file cli.allow when present', () => {
    writeFileSync(
      cfgPath,
      JSON.stringify({ version: 1, mcpServers: [], cli: { allow: ['gh', 'jq'] } }),
    );
    const a = resolveAllowlist();
    expect(a).not.toBe('*');
    if (a !== '*') expect([...a].sort()).toEqual(['gh', 'jq']);
  });

  it('treats a "*" entry as wildcard', () => {
    writeFileSync(cfgPath, JSON.stringify({ version: 1, mcpServers: [], cli: { allow: ['*'] } }));
    expect(resolveAllowlist()).toBe('*');
  });

  it('falls back to SYM_CLI_ALLOWLIST when the file has no cli section', () => {
    writeFileSync(cfgPath, JSON.stringify({ version: 1, mcpServers: [] }));
    process.env['SYM_CLI_ALLOWLIST'] = 'gcloud,sym';
    const a = resolveAllowlist();
    if (a !== '*') expect([...a].sort()).toEqual(['gcloud', 'sym']);
  });

  it('falls back to the built-in default when neither file nor env is set', () => {
    const a = resolveAllowlist();
    if (a !== '*') expect(a.has('sym')).toBe(true);
  });
});
