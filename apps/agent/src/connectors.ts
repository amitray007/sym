/**
 * Connector wiring for the agent turn loop.
 *
 * Exports:
 *  - `compositeDispatcher` — merges builtin + MCP tool dispatchers; routes
 *    `mcp__*` calls to the MCP registry and all others to the builtin dispatcher.
 *  - `loadConnectorRegistry` — loads the workspace's enabled HTTP connectors,
 *    resolves per-user auth for each one, and returns a connected
 *    `McpToolRegistry` (or `null` when no connectors are configured or reachable).
 *  - `buildConnectorConfigs` — extracted pure(-ish) helper; testable separately.
 *
 * Design principles:
 *  - Best-effort: a broken or unauthed connector never fails the turn.
 *  - Per-user: auth headers are resolved for the requesting Slack user, so each
 *    turn only sees connectors the requester has access to.
 *  - Fast path: when no enabled HTTP connectors exist for the workspace, we skip
 *    all connect work and return `null` immediately.
 */

import { append } from '@sym/audit';
import { mcpConfigs } from '@sym/db';
import { HttpMcpTransport, McpToolRegistry } from '@sym/ext-mcp';
import { and, eq } from 'drizzle-orm';

import { resolveConnectorAuth } from './connector-auth.js';

import type { AppendInput } from '@sym/audit';
import type {
  SlackUserId,
  ToolCall,
  ToolDescriptor,
  ToolDispatcher,
  ToolResult,
  ToolRuntimeContext,
  WorkspaceId,
} from '@sym/contracts';
import type { Database } from '@sym/db';
import type { AuditDb, AuditFn, McpServerConfig, TransportFactory } from '@sym/ext-mcp';

// ---------------------------------------------------------------------------
// compositeDispatcher
// ---------------------------------------------------------------------------

/**
 * Merge a builtin dispatcher and an optional MCP dispatcher into one.
 *
 * Routing:
 *  - `mcp__<slug>__<tool>` → MCP dispatcher (when non-null)
 *  - everything else       → builtin dispatcher
 *
 * `list()` returns builtin tools first, then MCP tools.
 */
export function compositeDispatcher(
  builtin: ToolDispatcher,
  mcp: ToolDispatcher | null,
): ToolDispatcher {
  return {
    list(): ToolDescriptor[] {
      return [...builtin.list(), ...(mcp !== null ? mcp.list() : [])];
    },

    dispatch(call: ToolCall, ctx: ToolRuntimeContext): Promise<ToolResult> {
      if (mcp !== null && call.name.startsWith('mcp__')) {
        return mcp.dispatch(call, ctx);
      }
      return builtin.dispatch(call, ctx);
    },
  };
}

// ---------------------------------------------------------------------------
// loadConnectorRegistry
// ---------------------------------------------------------------------------

export interface LoadConnectorRegistryDeps {
  db: Database;
  workspaceId: WorkspaceId;
  requester: SlackUserId;
  /** Optional audit sink — best-effort; a failure must never block connector wiring. */
  audit?: (input: AppendInput) => Promise<void>;
}

/**
 * Build `McpServerConfig` entries for each HTTP connector the requester can access.
 *
 * Extracted so it can be unit-tested independently of McpToolRegistry.connect().
 * Returns only connectors whose auth resolved to `none` or `token`; connectors
 * with `needs_auth` or `unknown` are silently skipped.
 */
export async function buildConnectorConfigs(
  deps: LoadConnectorRegistryDeps,
): Promise<McpServerConfig[]> {
  const { db, workspaceId, requester } = deps;

  const rows = await db
    .select()
    .from(mcpConfigs)
    .where(
      and(
        eq(mcpConfigs.workspaceId, workspaceId),
        eq(mcpConfigs.enabled, true),
        eq(mcpConfigs.transport, 'http'),
      ),
    );

  const configs: McpServerConfig[] = [];

  for (const row of rows) {
    const auth = await resolveConnectorAuth({
      db,
      workspaceId,
      slug: row.slug,
      requester,
    });

    if (auth.kind === 'needs_auth' || auth.kind === 'unknown') {
      // Connector not accessible for this user this turn — skip silently.
      continue;
    }

    const base: McpServerConfig = {
      id: row.id,
      workspaceId: row.workspaceId,
      name: row.name,
      slug: row.slug,
      transport: 'http',
      ...(row.url !== null ? { url: row.url } : {}),
    };

    if (auth.kind === 'token') {
      configs.push({ ...base, headers: { [auth.header]: auth.value } });
    } else {
      // auth.kind === 'none' — open server, no auth header needed
      configs.push(base);
    }
  }

  return configs;
}

/**
 * Load the workspace's enabled HTTP connectors, resolve per-user auth, connect
 * an `McpToolRegistry`, and return it — or `null` when no connectors are
 * available (fast path) or all connectors failed to connect.
 *
 * All failures are caught: a broken MCP server never blocks the turn.
 */
export async function loadConnectorRegistry(
  deps: LoadConnectorRegistryDeps,
): Promise<McpToolRegistry | null> {
  let configs: McpServerConfig[];
  try {
    configs = await buildConnectorConfigs(deps);
  } catch (err) {
    console.warn('[agent] buildConnectorConfigs failed (no connectors this turn):', err);
    return null;
  }

  if (configs.length === 0) {
    return null;
  }

  // Wire the audit function: delegates to `@sym/audit` `append` (which owns the
  // chain). When no audit sink is configured, use a no-op that satisfies the type.
  const auditFn: AuditFn = (auditDb: AuditDb, input: AppendInput) => {
    return append(auditDb as unknown as Database, input);
  };

  const transportFactory: TransportFactory = (cfg: McpServerConfig) =>
    new HttpMcpTransport({
      url: cfg.url!,
      ...(cfg.headers !== undefined ? { headers: cfg.headers } : {}),
    });

  const registry = new McpToolRegistry(deps.db as unknown as AuditDb, auditFn, transportFactory);

  try {
    await registry.connect(configs);
    return registry;
  } catch (err) {
    console.warn('[agent] McpToolRegistry.connect failed (no connectors this turn):', err);
    await registry.close().catch(() => {
      /* ignore close errors on an already-failed registry */
    });
    return null;
  }
}
