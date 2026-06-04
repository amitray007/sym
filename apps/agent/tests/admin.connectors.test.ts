/**
 * Per-connector admin routes — real-wire (loopback socket + real stdio echo
 * server). Covers GET /admin/connectors, GET /admin/connectors/:name/tools, and
 * POST /admin/connectors/:name/test — the data plane behind the TUI dashboard +
 * detail screens — driven through the admin-client the TUI uses.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import * as nodeUrl from 'node:url';

import { serve } from '@hono/node-server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { _resetPoolForTesting } from '@sym/mcp-runtime';

import {
  applyReload,
  fetchConnectors,
  fetchConnectorTools,
  testConnector,
} from '../src/cli/admin-client.js';
import { createServer } from '../src/server.js';

import type { AgentConfig } from '../src/config.js';
import type { ConnectorConfig } from '@sym/mcp-runtime';
import type { Server } from 'node:http';

const FIXTURE_PATH = nodePath.resolve(
  nodePath.dirname(nodeUrl.fileURLToPath(import.meta.url)),
  'fixtures',
  'echo-mcp-server.mjs',
);

const ECHO: ConnectorConfig = {
  name: 'echo',
  transport: { kind: 'stdio', command: 'node', args: [FIXTURE_PATH] },
  trust: true,
};

const config: AgentConfig = {
  port: 0,
  slackSigningSecret: 'test-signing-secret',
  slackBotToken: 'xoxb-test',
  slackBotUserId: 'UBOT',
  slackTeamId: 'T-TEST',
  ownerSlackUserId: 'UOWNER',
  fireworksApiKey: 'fw-key',
  fireworksModel: 'test-model',
  fireworksBaseUrl: 'http://fake.fireworks',
  behavior: { taskCardThreshold: 1, taskCardAfter: 'delete', ownerPostMarker: true },
  mcpServers: [],
  mcpConfigSource: 'none',
};

let dir: string;
let cfgPath: string;
let server: Server;
let baseUrl: string;
const savedConfigPath = process.env['SYM_CONFIG_PATH'];

beforeEach(async () => {
  _resetPoolForTesting();
  dir = mkdtempSync(nodePath.join(tmpdir(), 'sym-conn-'));
  cfgPath = nodePath.join(dir, 'config.json');
  process.env['SYM_CONFIG_PATH'] = cfgPath;
  writeFileSync(cfgPath, JSON.stringify({ version: 1, mcpServers: [ECHO] }), 'utf8');

  const app = createServer({ config });
  server = await new Promise<Server>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () =>
      resolve(s as unknown as Server),
    );
  });
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no server address');
  baseUrl = `http://127.0.0.1:${addr.port}`;
  await applyReload(baseUrl); // bring the echo connector live
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  _resetPoolForTesting();
  rmSync(dir, { recursive: true, force: true });
  if (savedConfigPath === undefined) delete process.env['SYM_CONFIG_PATH'];
  else process.env['SYM_CONFIG_PATH'] = savedConfigPath;
});

describe('per-connector admin routes (real loopback socket)', () => {
  it('GET /admin/connectors returns wiring + live health', async () => {
    const connectors = await fetchConnectors(baseUrl);
    const echo = connectors.find((d) => d.name === 'echo');
    expect(echo).toBeDefined();
    expect(echo?.transport).toBe('stdio');
    expect(echo?.auth).toBe('none');
    expect(echo?.trust).toBe(true);
    expect(echo?.ok).toBe(true);
    expect(echo?.tools).toBeGreaterThan(0);
  });

  it('GET /admin/connectors/:name/tools lists the served tools', async () => {
    const tools = await fetchConnectorTools('echo', baseUrl);
    const names = tools.map((t) => t.name);
    expect(names).toContain('get_env');
    expect(names).toContain('read_cred_file');
    // Tool names are prefix-stripped (no "echo__").
    expect(names.every((n) => !n.includes('__'))).toBe(true);
  });

  it('GET tools for an unknown connector rejects (404 → friendly error)', async () => {
    await expect(fetchConnectorTools('nope', baseUrl)).rejects.toThrow(/HTTP 404/);
  });

  it('POST /admin/connectors/:name/test re-connects one connector in isolation', async () => {
    const result = await testConnector('echo', baseUrl);
    expect(['connected', 'reconnected']).toContain(result.status.status);
    expect(result.status.tools).toBeGreaterThan(0);
    expect(result.tools.map((t) => t.name)).toContain('get_env');
  });

  it('testing an unknown connector reports failed, not a thrown error', async () => {
    const result = await testConnector('ghost', baseUrl);
    expect(result.status.status).toBe('failed');
    expect(result.status.error).toMatch(/unknown connector/);
  });
});
