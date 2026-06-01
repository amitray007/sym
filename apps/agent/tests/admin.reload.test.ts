/**
 * POST /admin/reload + GET /admin/status — real-wire end-to-end.
 *
 * Serves the actual agent HTTP app on a loopback socket, writes a real config
 * file, and drives the live connector pool by HTTP exactly as the `sym` CLI
 * will: write `.sym/config.json` → POST /admin/reload → tools change with no
 * restart. Also asserts the loopback guard and the file→reconcile round-trip.
 *
 * Uses the real stdio echo MCP server (spawned subprocess) — no mocks.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import * as nodeUrl from 'node:url';

import { serve } from '@hono/node-server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { _resetPoolForTesting } from '../src/mcp/dispatcher.js';
import { createServer } from '../src/server.js';

import type { AgentConfig } from '../src/config.js';
import type { ConnectorConfig } from '../src/mcp/config.js';
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

interface ReloadBody {
  source: string;
  totalTools: number;
  connectors: { name: string; status: string; tools: number; error?: string }[];
}
interface StatusBody {
  connectors: string[];
  totalTools: number;
}

function writeConfig(mcpServers: ConnectorConfig[]): void {
  writeFileSync(cfgPath, JSON.stringify({ version: 1, mcpServers }), 'utf8');
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  return (await res.json()) as T;
}

beforeEach(async () => {
  _resetPoolForTesting();
  dir = mkdtempSync(nodePath.join(tmpdir(), 'sym-admin-'));
  cfgPath = nodePath.join(dir, 'config.json');
  process.env['SYM_CONFIG_PATH'] = cfgPath;

  const app = createServer({ config });
  server = await new Promise<Server>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () =>
      resolve(s as unknown as Server),
    );
  });
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no server address');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  _resetPoolForTesting();
  rmSync(dir, { recursive: true, force: true });
  if (savedConfigPath === undefined) delete process.env['SYM_CONFIG_PATH'];
  else process.env['SYM_CONFIG_PATH'] = savedConfigPath;
});

describe('admin control plane (real loopback socket)', () => {
  it(
    'POST /admin/reload picks up a connector written to the config file (no restart)',
    async () => {
      // Boot started with zero connectors; status confirms it.
      const status0 = await getJson<StatusBody>(`${baseUrl}/admin/status`);
      expect(status0.connectors).toEqual([]);
      expect(status0.totalTools).toBe(0);

      // Operator writes the config file and applies.
      writeConfig([ECHO]);
      const reload = await fetch(`${baseUrl}/admin/reload`, { method: 'POST' });
      expect(reload.status).toBe(200);
      const body = (await reload.json()) as ReloadBody;
      expect(body.source).toBe('file');
      const echo = body.connectors.find((c) => c.name === 'echo');
      expect(echo?.status).toBe('connected');
      expect(echo?.tools).toBeGreaterThan(0);
      expect(body.totalTools).toBeGreaterThan(0);

      // Status now reflects the live connector.
      const status1 = await getJson<StatusBody>(`${baseUrl}/admin/status`);
      expect(status1.connectors).toEqual(['echo']);
      expect(status1.totalTools).toBeGreaterThan(0);
    },
    { timeout: 30_000 },
  );

  it(
    'POST /admin/reload removes a connector when the config file drops it',
    async () => {
      writeConfig([ECHO]);
      await fetch(`${baseUrl}/admin/reload`, { method: 'POST' });

      writeConfig([]);
      const body = await getJson<ReloadBody>(`${baseUrl}/admin/reload`, { method: 'POST' });
      const echo = body.connectors.find((c) => c.name === 'echo');
      expect(echo?.status).toBe('removed');
      expect(body.totalTools).toBe(0);

      const status = await getJson<StatusBody>(`${baseUrl}/admin/status`);
      expect(status.connectors).toEqual([]);
    },
    { timeout: 30_000 },
  );
});
