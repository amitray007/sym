/**
 * Reconcilable pool — real-wire tests (NO SDK mocks).
 *
 * Spawns the real stdio echo MCP server and drives reconcileConnectors() through
 * the full lifecycle: add → unchanged (no churn) → change (reconnect) →
 * validate-then-swap (failed edit keeps the previous healthy connection) →
 * remove. This is the engine behind POST /admin/reload / `sym apply`.
 */

import * as nodePath from 'node:path';
import * as nodeUrl from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  McpDispatcher,
  _resetPoolForTesting,
  getActiveConfigs,
  reconcileConnectors,
} from '../src/mcp/dispatcher.js';

import type { ConnectorConfig } from '../src/mcp/config.js';
import type {
  ConversationId,
  JsonObject,
  SlackChannelId,
  SlackUserId,
  ToolRuntimeContext,
  TurnId,
  WorkspaceId,
} from '@sym/contracts';

const FIXTURE_PATH = nodePath.resolve(
  nodePath.dirname(nodeUrl.fileURLToPath(import.meta.url)),
  'fixtures',
  'echo-mcp-server.mjs',
);

function echoConfig(overrides: Partial<ConnectorConfig> = {}): ConnectorConfig {
  return {
    name: 'echo',
    transport: { kind: 'stdio', command: 'node', args: [FIXTURE_PATH] },
    trust: true,
    ...overrides,
  };
}

function makeCtx(): ToolRuntimeContext {
  return {
    workspaceId: 'ws_test' as WorkspaceId,
    conversationId: 'ws_test:C1' as ConversationId,
    channelId: 'C1' as SlackChannelId,
    requester: 'U_test' as SlackUserId,
    turnId: 'turn_test' as TurnId,
  };
}

describe('reconcileConnectors — live pool reload', () => {
  beforeEach(() => _resetPoolForTesting());
  afterEach(() => _resetPoolForTesting());

  it(
    'adds a connector from an empty pool (status: connected) and serves its tools',
    async () => {
      const before = await reconcileConnectors([]);
      expect(before.connectors).toEqual([]);
      expect(before.totalTools).toBe(0);

      const after = await reconcileConnectors([echoConfig()]);
      const echo = after.connectors.find((c) => c.name === 'echo');
      expect(echo?.status).toBe('connected');
      expect(echo?.tools).toBeGreaterThan(0);
      expect(getActiveConfigs().map((c) => c.name)).toEqual(['echo']);

      // The live dispatcher serves the connector's tools.
      const tools = new McpDispatcher(getActiveConfigs()).list();
      expect(tools.some((t) => t.name === 'echo__get_env')).toBe(true);
    },
    { timeout: 30_000 },
  );

  it(
    'leaves an unchanged connector untouched (status: unchanged, no reconnect)',
    async () => {
      await reconcileConnectors([echoConfig()]);
      const again = await reconcileConnectors([echoConfig()]);
      const echo = again.connectors.find((c) => c.name === 'echo');
      expect(echo?.status).toBe('unchanged');
      expect(echo?.tools).toBeGreaterThan(0);
    },
    { timeout: 30_000 },
  );

  it(
    'reconnects when the config changes (status: reconnected)',
    async () => {
      await reconcileConnectors([echoConfig()]);
      // Same name, different config (extra arg) → must reconnect, not "unchanged".
      const changed = echoConfig({
        transport: { kind: 'stdio', command: 'node', args: [FIXTURE_PATH, '--v2'] },
      });
      const result = await reconcileConnectors([changed]);
      const echo = result.connectors.find((c) => c.name === 'echo');
      expect(echo?.status).toBe('reconnected');
      expect(echo?.tools).toBeGreaterThan(0);
    },
    { timeout: 30_000 },
  );

  it(
    'validate-then-swap: a failed edit keeps the previous healthy connection serving',
    async () => {
      const good = await reconcileConnectors([echoConfig()]);
      const goodTools = good.connectors.find((c) => c.name === 'echo')?.tools ?? 0;
      expect(goodTools).toBeGreaterThan(0);

      // Changed config that cannot connect (nonexistent binary).
      const broken = echoConfig({
        transport: { kind: 'stdio', command: 'this-binary-does-not-exist-xyz', args: [] },
      });
      const result = await reconcileConnectors([broken]);
      const echo = result.connectors.find((c) => c.name === 'echo');
      expect(echo?.status).toBe('failed-kept-previous');
      // Surface never regressed — the previous healthy tools are still counted…
      expect(echo?.tools).toBe(goodTools);
      // …and the live dispatcher still actually dispatches through the old client.
      const dispatch = await new McpDispatcher(getActiveConfigs()).dispatch(
        { id: 'c1', name: 'echo__get_env', arguments: { name: 'PATH' } as JsonObject },
        makeCtx(),
      );
      expect(dispatch.ok).toBe(true);
    },
    { timeout: 30_000 },
  );

  it(
    'records a hard failure (status: failed) when nothing was serving the name before',
    async () => {
      const result = await reconcileConnectors([
        echoConfig({
          name: 'broken',
          transport: { kind: 'stdio', command: 'this-binary-does-not-exist-xyz', args: [] },
        }),
      ]);
      const broken = result.connectors.find((c) => c.name === 'broken');
      expect(broken?.status).toBe('failed');
      expect(broken?.tools).toBe(0);
      expect(broken?.error).toBeDefined();
    },
    { timeout: 30_000 },
  );

  it(
    'removes a connector dropped from the config (status: removed) and stops serving it',
    async () => {
      await reconcileConnectors([echoConfig()]);
      const result = await reconcileConnectors([]);
      const echo = result.connectors.find((c) => c.name === 'echo');
      expect(echo?.status).toBe('removed');
      expect(getActiveConfigs()).toEqual([]);
      expect(new McpDispatcher(getActiveConfigs()).list()).toEqual([]);
    },
    { timeout: 30_000 },
  );
});
