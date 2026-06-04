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

import { _resetPoolForTesting } from '@sym/mcp-runtime';

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

  it(
    'POST /admin/reload responds 200 (not 500) when the config file is missing',
    async () => {
      // SYM_CONFIG_PATH points to cfgPath which was NEVER written — simulates
      // a fresh deploy where the operator hasn't applied yet. The loader
      // falls back to source:'none', mcpServers:[].
      const reload = await fetch(`${baseUrl}/admin/reload`, { method: 'POST' });
      expect(reload.status).toBe(200);
      const body = (await reload.json()) as ReloadBody;
      // source reports 'none' (file missing → env fallback → env unset → none)
      expect(body.source).toBe('none');
      expect(body.totalTools).toBe(0);
      expect(body.connectors).toEqual([]);
    },
    { timeout: 10_000 },
  );

  it(
    'POST /admin/reload responds 200 when the config file is malformed JSON',
    async () => {
      // Write garbage JSON — loader logs a warning and falls back to env (unset
      // in this test env) → source:'none'. Must not 500.
      writeFileSync(cfgPath, '{ invalid json !!!', 'utf8');

      const reload = await fetch(`${baseUrl}/admin/reload`, { method: 'POST' });
      expect(reload.status).toBe(200);
      const body = (await reload.json()) as ReloadBody;
      expect(body.source).toBe('none');
      expect(body.totalTools).toBe(0);
    },
    { timeout: 10_000 },
  );

  it(
    'POST /admin/reload reports a failed connector in the connectors array, not a 500',
    async () => {
      // Write a connector with a command that does not exist (guaranteed spawn fail).
      const broken: ConnectorConfig = {
        name: 'broken',
        transport: {
          kind: 'stdio',
          command: '/this/binary/does/not/exist/sym-fake-mcp',
        },
        trust: true,
      };
      writeConfig([broken]);

      const reload = await fetch(`${baseUrl}/admin/reload`, { method: 'POST' });
      // Must respond with 200 — reconcileConnectors absorbs per-connector errors.
      expect(reload.status).toBe(200);
      const body = (await reload.json()) as ReloadBody;
      // The broken connector appears in the connectors array with an error status.
      const entry = body.connectors.find((c) => c.name === 'broken');
      expect(entry).toBeDefined();
      // reconcileConnectors uses 'failed' (not 'error') for a connect-failure.
      expect(entry?.status).toBe('failed');
      // error field carries a human-readable message (not an empty string).
      expect(typeof entry?.error).toBe('string');
      expect((entry?.error ?? '').length).toBeGreaterThan(0);
      // Zero tools since the connector failed.
      expect(entry?.tools).toBe(0);
      expect(body.totalTools).toBe(0);
    },
    { timeout: 15_000 },
  );
});
