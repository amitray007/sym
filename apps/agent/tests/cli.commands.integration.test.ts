/**
 * `sym` read commands — real-wire end to end, as a REAL SUBPROCESS.
 *
 * Drives the actual `sym` CLI (spawned via tsx) against a live in-process agent
 * (loopback socket + real stdio echo MCP server) and asserts the dense / --json
 * output that the operator AND the agent (via run_cli) consume.
 *
 * Why a subprocess (not in-process `main()` + a console.log spy): the agent runs
 * in THIS process and logs to console during reconcile/admin handling. An
 * in-process `vi.spyOn(console,'log')` captures those server logs too, so they
 * race into the captured CLI output and corrupt `JSON.parse` (this flake bit CI
 * twice — Z13-04). Running the CLI in its own process isolates its stdout: the
 * child inherits SYM_CONFIG_PATH + SYM_ADMIN_URL and talks to the server over
 * HTTP, exactly like the operator's shell does.
 */

import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import * as nodeUrl from 'node:url';
import { promisify } from 'node:util';

import { serve } from '@hono/node-server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { _resetPoolForTesting } from '../src/mcp/dispatcher.js';
import { createServer } from '../src/server.js';

import type { AgentConfig } from '../src/config.js';
import type { ConnectorConfig } from '../src/mcp/config.js';
import type { Server } from 'node:http';

const execFileAsync = promisify(execFile);

const AGENT_ROOT = nodePath.join(nodePath.dirname(nodeUrl.fileURLToPath(import.meta.url)), '..');
const CLI_PATH = nodePath.join(AGENT_ROOT, 'src/cli/index.ts');
const TSX_BIN = nodePath.join(AGENT_ROOT, 'node_modules/.bin/tsx');

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
let adminUrl: string;
const saved = { cfg: process.env['SYM_CONFIG_PATH'], admin: process.env['SYM_ADMIN_URL'] };

/**
 * Run a `sym` command as a real subprocess against the live test server.
 * The child inherits SYM_CONFIG_PATH + SYM_ADMIN_URL (set in beforeEach) and so
 * reaches the same config file + loopback admin server the operator would.
 * Returns [exitCode, stdout]. Never throws on non-zero exit.
 */
async function run(...args: string[]): Promise<[number, string]> {
  try {
    const { stdout } = await execFileAsync(TSX_BIN, [CLI_PATH, ...args], {
      timeout: 20_000,
      env: {
        ...process.env,
        SYM_CONFIG_PATH: nodePath.join(dir, 'config.json'),
        SYM_ADMIN_URL: adminUrl,
      },
    });
    return [0, stdout];
  } catch (err) {
    const e = err as { stdout?: string; code?: number };
    return [e.code ?? 1, e.stdout ?? ''];
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
  adminUrl = `http://127.0.0.1:${addr.port}`;
  process.env['SYM_ADMIN_URL'] = adminUrl;

  // Bring echo live in the server's pool (setup — done directly, not via a CLI
  // subprocess: the commands under test are the read commands below).
  const res = await fetch(`${adminUrl}/admin/reload`, { method: 'POST' });
  if (!res.ok) throw new Error(`admin reload failed: ${res.status}`);
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

describe('sym read commands (real subprocess wire)', () => {
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

  it('connector ls --json lists MCP + CLI connectors with live health', async () => {
    const [code, out] = await run('connector', 'ls', '--json');
    expect(code).toBe(0);
    const data = JSON.parse(out) as {
      connectors: { name: string; kind: string; health?: string }[];
    };
    const echo = data.connectors.find((c) => c.name === 'echo');
    expect(echo?.kind).toBe('mcp');
    expect(echo?.health).toBe('connected');
  });

  it('the merged `sym mcp`/`sym cli` verbs are gone (redirect to connector)', async () => {
    const [code] = await run('mcp', 'ls');
    expect(code).toBe(1); // deprecation redirect → non-zero
  });
});
