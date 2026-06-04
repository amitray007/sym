/**
 * Tests for the config-store helpers (loadConfigFile, writeConfigFile,
 * upsertConnector, removeConnector).
 *
 * Real-wire on the filesystem: writes actual JSON files to a temp dir and
 * exercises the full read/write/validate cycle.  No mocks.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  loadConfigFile,
  removeConnector,
  upsertConnector,
  writeConfigFile,
} from '../src/cli/config-store.js';

import type { SymConfigFile } from '../src/cli/config-store.js';
import type { ConnectorConfig } from '@sym/mcp-runtime';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** A fully-valid stdio connector that parseConnectorArray will accept. */
const ECHO: ConnectorConfig = {
  name: 'echo',
  transport: { kind: 'stdio', command: 'node', args: ['x.mjs'] },
  trust: true,
};

/** A second valid connector for multi-entry tests. */
const OTHER: ConnectorConfig = {
  name: 'other',
  transport: { kind: 'stdio', command: 'node', args: ['other.mjs'] },
};

let dir: string;
let cfgPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sym-config-store-'));
  cfgPath = join(dir, '.sym', 'config.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// loadConfigFile
// ---------------------------------------------------------------------------

describe('loadConfigFile', () => {
  it('returns empty config when the file is absent', () => {
    const cfg = loadConfigFile(cfgPath);
    expect(cfg).toEqual({ version: 1, mcpServers: [] });
  });

  it('loads and round-trips a valid stdio connector', () => {
    writeConfigFile(cfgPath, { version: 1, mcpServers: [ECHO] });
    const cfg = loadConfigFile(cfgPath);
    expect(cfg.version).toBe(1);
    expect(cfg.mcpServers).toHaveLength(1);
    expect(cfg.mcpServers[0]?.name).toBe('echo');
    expect(cfg.mcpServers[0]?.transport).toEqual({
      kind: 'stdio',
      command: 'node',
      args: ['x.mjs'],
    });
    expect(cfg.mcpServers[0]?.trust).toBe(true);
  });

  it('defaults version to 1 when the field is absent', () => {
    // Write raw JSON without a version field
    mkdirSync(join(dir, '.sym'), { recursive: true });
    writeFileSync(cfgPath, JSON.stringify({ mcpServers: [ECHO] }), 'utf8');
    const cfg = loadConfigFile(cfgPath);
    expect(cfg.version).toBe(1);
  });

  it('throws on malformed JSON', () => {
    mkdirSync(join(dir, '.sym'), { recursive: true });
    writeFileSync(cfgPath, '{ not valid json', 'utf8');
    expect(() => loadConfigFile(cfgPath)).toThrow(/not valid JSON/);
  });

  it('throws when the top-level value is a JSON array', () => {
    mkdirSync(join(dir, '.sym'), { recursive: true });
    writeFileSync(cfgPath, JSON.stringify([ECHO]), 'utf8');
    expect(() => loadConfigFile(cfgPath)).toThrow(/must be a JSON object/);
  });

  it('throws when the top-level value is null', () => {
    mkdirSync(join(dir, '.sym'), { recursive: true });
    writeFileSync(cfgPath, 'null', 'utf8');
    expect(() => loadConfigFile(cfgPath)).toThrow(/must be a JSON object/);
  });

  it('skips invalid entries inside a valid file (fail-open per entry)', () => {
    mkdirSync(join(dir, '.sym'), { recursive: true });
    writeFileSync(
      cfgPath,
      JSON.stringify({ version: 1, mcpServers: [ECHO, { missing: 'transport' }] }),
      'utf8',
    );
    const cfg = loadConfigFile(cfgPath);
    // Only ECHO survives; the malformed entry is silently dropped
    expect(cfg.mcpServers.map((s) => s.name)).toEqual(['echo']);
  });
});

// ---------------------------------------------------------------------------
// writeConfigFile
// ---------------------------------------------------------------------------

describe('writeConfigFile', () => {
  it('creates parent directories and writes pretty JSON with a trailing newline', () => {
    writeConfigFile(cfgPath, { version: 1, mcpServers: [ECHO] });
    expect(existsSync(cfgPath)).toBe(true);
    const raw = readFileSync(cfgPath, 'utf8');
    // Pretty-printed (2 spaces) and trailing newline
    expect(raw).toMatch(/^\{/);
    expect(raw.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(raw) as SymConfigFile;
    expect(parsed.version).toBe(1);
    expect(parsed.mcpServers[0]?.name).toBe('echo');
  });

  it('throws when given a connector with no transport (parseConnectorArray drops it)', () => {
    const bad = { name: 'x' } as unknown as ConnectorConfig;
    expect(() => writeConfigFile(cfgPath, { version: 1, mcpServers: [bad] })).toThrow(
      /invalid.*refusing to write|connector.*invalid/i,
    );
  });

  it('throws when a connector is missing required transport fields', () => {
    // transport object present but missing command for stdio
    const bad = {
      name: 'x',
      transport: { kind: 'stdio' },
    } as unknown as ConnectorConfig;
    expect(() => writeConfigFile(cfgPath, { version: 1, mcpServers: [bad] })).toThrow(
      /invalid.*refusing to write|connector.*invalid/i,
    );
  });
});

// ---------------------------------------------------------------------------
// upsertConnector (pure)
// ---------------------------------------------------------------------------

describe('upsertConnector', () => {
  it('appends a new connector when the name is not present', () => {
    const base: SymConfigFile = { version: 1, mcpServers: [] };
    const next = upsertConnector(base, ECHO);
    expect(next.mcpServers).toHaveLength(1);
    expect(next.mcpServers[0]?.name).toBe('echo');
    // original is untouched
    expect(base.mcpServers).toHaveLength(0);
  });

  it('replaces an existing connector with the same name', () => {
    const base: SymConfigFile = { version: 1, mcpServers: [ECHO] };
    const updated: ConnectorConfig = {
      name: 'echo',
      transport: { kind: 'stdio', command: 'node', args: ['new.mjs'] },
    };
    const next = upsertConnector(base, updated);
    expect(next.mcpServers).toHaveLength(1);
    expect(next.mcpServers[0]?.transport).toEqual({
      kind: 'stdio',
      command: 'node',
      args: ['new.mjs'],
    });
  });

  it('does not mutate the input config', () => {
    const base: SymConfigFile = { version: 1, mcpServers: [ECHO] };
    upsertConnector(base, OTHER);
    expect(base.mcpServers).toHaveLength(1);
  });

  it('preserves order: replacement stays in-place, append goes last', () => {
    const base: SymConfigFile = { version: 1, mcpServers: [ECHO, OTHER] };
    const updatedEcho: ConnectorConfig = {
      name: 'echo',
      transport: { kind: 'stdio', command: 'node', args: ['updated.mjs'] },
    };
    const next = upsertConnector(base, updatedEcho);
    expect(next.mcpServers.map((s) => s.name)).toEqual(['echo', 'other']);
  });
});

// ---------------------------------------------------------------------------
// removeConnector (pure)
// ---------------------------------------------------------------------------

describe('removeConnector', () => {
  it('removes an existing connector and returns removed: true', () => {
    const base: SymConfigFile = { version: 1, mcpServers: [ECHO, OTHER] };
    const { next, removed } = removeConnector(base, 'echo');
    expect(removed).toBe(true);
    expect(next.mcpServers.map((s) => s.name)).toEqual(['other']);
  });

  it('returns removed: false when the name is not present', () => {
    const base: SymConfigFile = { version: 1, mcpServers: [ECHO] };
    const { next, removed } = removeConnector(base, 'nonexistent');
    expect(removed).toBe(false);
    expect(next.mcpServers).toHaveLength(1);
  });

  it('returns the same object reference when nothing was removed', () => {
    const base: SymConfigFile = { version: 1, mcpServers: [ECHO] };
    const { next } = removeConnector(base, 'nonexistent');
    // Not mutated — same ref is acceptable here since nothing changed
    expect(next).toBe(base);
  });

  it('does not mutate the input config', () => {
    const base: SymConfigFile = { version: 1, mcpServers: [ECHO, OTHER] };
    removeConnector(base, 'echo');
    expect(base.mcpServers).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Round-trip: write then load
// ---------------------------------------------------------------------------

describe('round-trip (writeConfigFile → loadConfigFile)', () => {
  it('preserves all fields of a valid stdio connector', () => {
    const connector: ConnectorConfig = {
      name: 'echo',
      transport: { kind: 'stdio', command: 'node', args: ['x.mjs'] },
      trust: true,
    };
    writeConfigFile(cfgPath, { version: 1, mcpServers: [connector] });
    const loaded = loadConfigFile(cfgPath);
    expect(loaded.mcpServers[0]).toEqual(connector);
  });

  it('preserves version across write/load', () => {
    writeConfigFile(cfgPath, { version: 2, mcpServers: [ECHO] });
    const loaded = loadConfigFile(cfgPath);
    expect(loaded.version).toBe(2);
  });
});
