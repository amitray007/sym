/**
 * Tests for the connector config source loader (file → env fallback).
 *
 * Real-wire on the filesystem: writes actual JSON files to a temp dir, points
 * SYM_CONFIG_PATH at them, and asserts the loader's precedence + fail-open
 * behavior. No mocks — this is the seam the `sym` control plane will write to.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConnectorConfigs } from '../src/mcp/source.js';

const STDIO = { kind: 'stdio', command: 'echo-server' };
const ENV_ONE = JSON.stringify([{ name: 'envone', transport: STDIO }]);

let dir: string;
let cfgPath: string;
const savedConfigPath = process.env['SYM_CONFIG_PATH'];
const savedServers = process.env['SYM_MCP_SERVERS'];

function writeConfig(value: unknown): void {
  writeFileSync(cfgPath, typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sym-source-'));
  cfgPath = join(dir, 'config.json');
  process.env['SYM_CONFIG_PATH'] = cfgPath;
  delete process.env['SYM_MCP_SERVERS'];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (savedConfigPath === undefined) delete process.env['SYM_CONFIG_PATH'];
  else process.env['SYM_CONFIG_PATH'] = savedConfigPath;
  if (savedServers === undefined) delete process.env['SYM_MCP_SERVERS'];
  else process.env['SYM_MCP_SERVERS'] = savedServers;
});

describe('loadConnectorConfigs', () => {
  it('loads from the config file when present (source: file)', () => {
    writeConfig({ version: 1, mcpServers: [{ name: 'filey', transport: STDIO }] });
    const loaded = loadConnectorConfigs();
    expect(loaded.source).toBe('file');
    expect(loaded.mcpServers.map((s) => s.name)).toEqual(['filey']);
    expect(loaded.path).toBe(cfgPath);
  });

  it('falls back to SYM_MCP_SERVERS when the file is absent (source: env)', () => {
    process.env['SYM_MCP_SERVERS'] = ENV_ONE;
    const loaded = loadConnectorConfigs();
    expect(loaded.source).toBe('env');
    expect(loaded.mcpServers.map((s) => s.name)).toEqual(['envone']);
  });

  it('reports source: none when neither file nor env is set', () => {
    const loaded = loadConnectorConfigs();
    expect(loaded.source).toBe('none');
    expect(loaded.mcpServers).toEqual([]);
  });

  it('the file wins over env when both are present', () => {
    process.env['SYM_MCP_SERVERS'] = ENV_ONE;
    writeConfig({ version: 1, mcpServers: [{ name: 'filewins', transport: STDIO }] });
    const loaded = loadConnectorConfigs();
    expect(loaded.source).toBe('file');
    expect(loaded.mcpServers.map((s) => s.name)).toEqual(['filewins']);
  });

  it('an empty file object yields zero connectors but still source: file', () => {
    writeConfig({ version: 1 });
    const loaded = loadConnectorConfigs();
    expect(loaded.source).toBe('file');
    expect(loaded.mcpServers).toEqual([]);
  });

  it('falls back to env when the file is malformed JSON', () => {
    writeConfig('{ not valid json');
    process.env['SYM_MCP_SERVERS'] = ENV_ONE;
    const loaded = loadConnectorConfigs();
    expect(loaded.source).toBe('env');
    expect(loaded.mcpServers.map((s) => s.name)).toEqual(['envone']);
  });

  it('falls back to env when the file is a JSON array (not an object)', () => {
    writeConfig([{ name: 'wrongshape', transport: STDIO }]);
    process.env['SYM_MCP_SERVERS'] = ENV_ONE;
    const loaded = loadConnectorConfigs();
    expect(loaded.source).toBe('env');
    expect(loaded.mcpServers.map((s) => s.name)).toEqual(['envone']);
  });

  it('skips malformed connector entries inside a valid file (fail-open per entry)', () => {
    writeConfig({
      version: 1,
      mcpServers: [{ name: 'good', transport: STDIO }, { missing: 'name' }],
    });
    const loaded = loadConnectorConfigs();
    expect(loaded.source).toBe('file');
    expect(loaded.mcpServers.map((s) => s.name)).toEqual(['good']);
  });
});
