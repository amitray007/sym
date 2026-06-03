/**
 * mcp/introspect.ts — Per-connector introspection helpers.
 *
 * Powers the /admin/connectors routes: detail rows, per-connector tool lists,
 * and the test-connector endpoint that reconnects one connector in isolation
 * without touching the rest of the pool.
 */

import { connectServer, getActiveConfigs, MCP_TOOL_SEPARATOR, pool } from './pool.js';

import type { ConnectorConfig } from './config.js';
import type { ConnectorStatus } from './reconcile.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One MCP tool's public identity, prefix-stripped for display. */
export interface ToolInfo {
  name: string;
  description: string;
}

/** A connector's wiring + live health — one row of the /admin/connectors list. */
export interface ConnectorDetail {
  name: string;
  transport: string;
  auth: string;
  trust: boolean;
  /** Healthy (connected + listTools succeeded). */
  ok: boolean;
  /** Live tool count (0 when not ok). */
  tools: number;
  /** Failure reason / authorize URL when not ok. */
  error?: string;
}

/** Result of testing a single connector: its post-test status + live tools. */
export interface ConnectorTestResult {
  status: ConnectorStatus;
  tools: ToolInfo[];
}

// ---------------------------------------------------------------------------
// Detail helpers
// ---------------------------------------------------------------------------

/** Build a connector's detail row from its active config + live pool entry. */
function detailFor(cfg: ConnectorConfig): ConnectorDetail {
  const entry = pool.get(cfg.name);
  const ok = entry?.ok === true;
  return {
    name: cfg.name,
    transport: cfg.transport.kind,
    auth: cfg.auth?.kind ?? 'none',
    trust: cfg.trust === true,
    ok,
    tools: ok ? entry.tools.length : 0,
    ...(entry?.error !== undefined ? { error: entry.error } : {}),
  };
}

/** Every active connector's wiring + health, in config order. */
export function listConnectorDetails(): ConnectorDetail[] {
  return getActiveConfigs().map(detailFor);
}

/**
 * The tools a connector currently serves (prefix-stripped), or `null` when the
 * connector is unknown or not connected.
 */
export function getConnectorTools(name: string): ToolInfo[] | null {
  const entry = pool.get(name);
  if (entry === undefined || !entry.ok) return null;
  const prefix = `${name}${MCP_TOOL_SEPARATOR}`;
  return entry.tools.map((t) => ({
    name: t.name.startsWith(prefix) ? t.name.slice(prefix.length) : t.name,
    description: t.description ?? '',
  }));
}

// ---------------------------------------------------------------------------
// Test connector
// ---------------------------------------------------------------------------

/**
 * Re-connect ONE connector in isolation (validate-then-swap, scoped to `name`)
 * and report its status + tools. Other connectors are untouched. Returns a
 * `failed` status for an unknown name rather than throwing.
 */
export async function testConnector(name: string): Promise<ConnectorTestResult> {
  const cfg = getActiveConfigs().find((c) => c.name === name);
  if (cfg === undefined) {
    return {
      status: { name, status: 'failed', tools: 0, error: `unknown connector '${name}'` },
      tools: [],
    };
  }

  const existing = pool.get(name);
  const fresh = await connectServer(cfg);
  let status: ConnectorStatus;
  if (fresh.ok) {
    if (existing !== undefined) existing.client.close().catch(() => undefined);
    pool.set(name, fresh);
    status = {
      name,
      status: existing !== undefined ? 'reconnected' : 'connected',
      tools: fresh.tools.length,
    };
  } else if (existing?.ok === true) {
    fresh.client.close().catch(() => undefined);
    status = {
      name,
      status: 'failed-kept-previous',
      tools: existing.tools.length,
      ...(fresh.error !== undefined ? { error: fresh.error } : {}),
    };
  } else {
    pool.set(name, fresh);
    status = {
      name,
      status: 'failed',
      tools: 0,
      ...(fresh.error !== undefined ? { error: fresh.error } : {}),
    };
  }
  return { status, tools: getConnectorTools(name) ?? [] };
}
