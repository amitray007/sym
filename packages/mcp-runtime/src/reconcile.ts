/**
 * mcp/reconcile.ts — Live connector pool reconciliation.
 *
 * `reconcileConnectors` is the heart of live reload — it validates and
 * swaps in new connector configs without restarting the agent process. Called
 * by POST /admin/connectors/reload (the `sym apply` seam).
 *
 * Strategy per connector:
 *   - removed (in pool, absent from `next`)   → close + drop
 *   - unchanged (same config, already healthy) → leave the live client untouched
 *     (no needless reconnect, no SSE/subprocess churn, no 0-tool window)
 *   - new / changed / previously-down          → connect a FRESH client; commit it
 *     only if healthy. If it fails AND a healthy client was already serving this
 *     name, keep the old one (the surface never regresses); otherwise record the
 *     failure (0 tools, fail-open).
 *
 * Never throws — a bad edit yields a status report, not a crash, and leaves
 * every still-healthy connector serving.
 */

import { configsEqual, connectServer, getActiveConfigs, pool, setActiveConfigs } from './pool.js';

import type { ConnectorConfig } from './config.js';

// ---------------------------------------------------------------------------
// Reconcile result types
// ---------------------------------------------------------------------------

/** Per-connector outcome of a reconcile pass. */
export interface ConnectorStatus {
  name: string;
  /**
   *  connected            — newly connected, healthy
   *  reconnected          — config changed (or was down) → reconnected, healthy
   *  unchanged            — identical config + already healthy → left untouched
   *  failed               — could not connect; nothing was serving it before
   *  failed-kept-previous — could not connect; the previous healthy connection
   *                         is retained so the live surface never regresses
   *  removed              — dropped from config; its client was closed
   */
  status: 'connected' | 'reconnected' | 'unchanged' | 'failed' | 'failed-kept-previous' | 'removed';
  /** Tools currently served for this connector (after reconcile). */
  tools: number;
  /** Failure reason / authorize URL when the connect attempt failed. */
  error?: string;
}

export interface ReconcileResult {
  connectors: ConnectorStatus[];
  /** Total tools live across all healthy connectors after reconcile. */
  totalTools: number;
}

// ---------------------------------------------------------------------------
// reconcileConnectors
// ---------------------------------------------------------------------------

/**
 * Reconcile the live connector pool to `next` — the heart of live reload.
 *
 * Validate-then-swap, per connector:
 *   - removed (in pool, absent from `next`)   → close + drop
 *   - unchanged (same config, already healthy) → leave the live client untouched
 *     (no needless reconnect, no SSE/subprocess churn, no 0-tool window)
 *   - new / changed / previously-down          → connect a FRESH client; commit it
 *     only if healthy. If it fails AND a healthy client was already serving this
 *     name, keep the old one (the surface never regresses); otherwise record the
 *     failure (0 tools, fail-open).
 *
 * Never throws — a bad edit yields a status report, not a crash, and leaves
 * every still-healthy connector serving.
 */
export async function reconcileConnectors(next: ConnectorConfig[]): Promise<ReconcileResult> {
  const currentActiveConfigs = getActiveConfigs();
  const prevByName = new Map(currentActiveConfigs.map((c) => [c.name, c]));
  const nextByName = new Map(next.map((c) => [c.name, c]));
  const connectors: ConnectorStatus[] = [];

  // 1) Remove connectors no longer in the config.
  for (const name of [...pool.keys()]) {
    if (!nextByName.has(name)) {
      const entry = pool.get(name);
      entry?.client.close().catch(() => undefined);
      pool.delete(name);
      connectors.push({ name, status: 'removed', tools: 0 });
    }
  }

  // 2) Add / update / keep the rest.
  for (const cfg of next) {
    const existing = pool.get(cfg.name);
    const prev = prevByName.get(cfg.name);
    const unchanged = existing?.ok === true && prev !== undefined && configsEqual(prev, cfg);
    if (unchanged) {
      connectors.push({ name: cfg.name, status: 'unchanged', tools: existing.tools.length });
      continue;
    }

    const fresh = await connectServer(cfg);
    if (fresh.ok) {
      if (existing !== undefined) existing.client.close().catch(() => undefined);
      pool.set(cfg.name, fresh);
      connectors.push({
        name: cfg.name,
        status: existing !== undefined ? 'reconnected' : 'connected',
        tools: fresh.tools.length,
      });
    } else if (existing?.ok === true) {
      // New config failed to connect — keep the previous healthy client so the
      // live surface never regresses on a bad edit. Discard the failed attempt.
      fresh.client.close().catch(() => undefined);
      connectors.push({
        name: cfg.name,
        status: 'failed-kept-previous',
        tools: existing.tools.length,
        ...(fresh.error !== undefined ? { error: fresh.error } : {}),
      });
    } else {
      // Nothing was serving this name before — record the failure (fail-open).
      pool.set(cfg.name, fresh);
      connectors.push({
        name: cfg.name,
        status: 'failed',
        tools: 0,
        ...(fresh.error !== undefined ? { error: fresh.error } : {}),
      });
    }
  }

  // Update activeConfigs in the pool module via the setter.
  setActiveConfigs(next);

  const totalTools = connectors.reduce((sum, c) => sum + c.tools, 0);
  return { connectors, totalTools };
}
