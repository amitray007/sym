/**
 * `sym` read commands — real-wire end to end. Drives the CLI's main() against a
 * live agent (loopback socket + real stdio echo server) and asserts the dense /
 * --json output that the operator AND the agent (via run_cli) consume.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import * as nodeUrl from 'node:url';

import { serve } from '@hono/node-server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { main } from '../src/cli/index.js';
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
let server: Server;
let logs: string[];
const saved = { cfg: process.env['SYM_CONFIG_PATH'], admin: process.env['SYM_ADMIN_URL'] };

/** Run a sym command, returning [exitCode, combinedStdout]. */
async function run(...args: string[]): Promise<[number, string]> {
  logs = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    logs.push(a.map(String).join(' '));
  });
  try {
    const code = await main(args);
    return [code, logs.join('\n')];
  } finally {
    spy.mockRestore();
  }
}

beforeEach(async () => {
  _resetPoolForTesting();
  dir = mkdtempSync(nodePath.join(tmpdir(), 'sym-cmd-'));
  const cfgPath = nodePath.join(dir, 'config.json');
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
  process.env['SYM_ADMIN_URL'] = `http://127.0.0.1:${addr.port}`;
  await run('apply'); // bring echo live
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  _resetPoolForTesting();
  rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of [
    ['SYM_CONFIG_PATH', saved.cfg],
    ['SYM_ADMIN_URL', saved.admin],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('sym read commands (real wire)', () => {
  it('status --json reports agent health + per-connector detail', async () => {
    const [code, out] = await run('status', '--json');
    expect(code).toBe(0);
    const data = JSON.parse(out) as {
      reachable: boolean;
      totalTools: number;
      connectors: { name: string; ok: boolean; tools: number }[];
    };
    expect(data.reachable).toBe(true);
    expect(data.totalTools).toBeGreaterThan(0);
    const echo = data.connectors.find((c) => c.name === 'echo');
    expect(echo?.ok).toBe(true);
    expect(echo?.tools).toBeGreaterThan(0);
  });

  it('status (text) renders a dense connector table', async () => {
    const [code, out] = await run('status');
    expect(code).toBe(0);
    expect(out).toContain('agent: up');
    expect(out).toContain('echo');
    expect(out).toContain('connected');
    expect(out).toMatch(/NAME\s+TRANSPORT\s+AUTH/);
  });

  it('tools (catalog) lists every connector tool with descriptions', async () => {
    const [code, out] = await run('tools');
    expect(code).toBe(0);
    expect(out).toContain('echo');
    expect(out).toContain('get_env');
    expect(out).toContain('read_cred_file');
  });

  it('tools <name> --json returns that connector tools', async () => {
    const [code, out] = await run('tools', 'echo', '--json');
    expect(code).toBe(0);
    const data = JSON.parse(out) as { connector: string; tools: { name: string }[] };
    expect(data.connector).toBe('echo');
    expect(data.tools.map((t) => t.name)).toContain('get_env');
  });

  it('show <name> includes config, health, and tools', async () => {
    const [code, out] = await run('show', 'echo', '--json');
    expect(code).toBe(0);
    const data = JSON.parse(out) as {
      name: string;
      config: ConnectorConfig | null;
      health: { ok: boolean } | null;
      tools: { name: string }[];
    };
    expect(data.name).toBe('echo');
    expect(data.config?.transport.kind).toBe('stdio');
    expect(data.health?.ok).toBe(true);
    expect(data.tools.map((t) => t.name)).toContain('get_env');
  });

  it('mcp ls --json merges config wiring with live health', async () => {
    const [code, out] = await run('mcp', 'ls', '--json');
    expect(code).toBe(0);
    const data = JSON.parse(out) as {
      connectors: { name: string; live: { ok: boolean } | null }[];
    };
    const echo = data.connectors.find((c) => c.name === 'echo');
    expect(echo?.live?.ok).toBe(true);
  });
});
