/**
 * Receipt formatter for the audit subsystem.
 *
 * A `Receipt` (defined in @sym/contracts `domain.ts`) is a structured
 * provenance summary of a turn.  It is produced by aggregating the audit
 * events that belong to that turn.
 *
 * Aggregation rules applied by `auditEventsToReceipt`:
 *
 *   model          — extracted from the payload of the first `gen_ai.completion`
 *                    event found (payload.model string).
 *   usage          — summed across all `gen_ai.completion` events:
 *                    promptTokens, completionTokens, totalTokens.
 *   durationMs     — max(ts) – min(ts) across all events in the turn (ms).
 *   toolsInvoked   — deduplicated list of `payload.toolName` strings across
 *                    events whose kind is `app.tool.invoke` or any kind
 *                    containing `execute_tool`.
 *   onBehalfOf     — taken from the first event that has a non-null
 *                    `onBehalfOf` column value.
 *   turnId         — caller-supplied (not in every audit row).
 *
 * This function is deliberately pure / hermetic — no DB access — so it can
 * be unit-tested without infrastructure.
 */

import type { AuditActorKind, Receipt, SlackUserId, TurnId, WorkspaceId } from '@sym/contracts';

/** Minimal row shape accepted by the receipt formatter (a subset of AuditEvent). */
export interface AuditEventRow {
  id: number;
  workspaceId: WorkspaceId;
  kind: string;
  actorKind: AuditActorKind;
  actorId: string;
  onBehalfOf?: SlackUserId;
  targetKind?: string;
  targetId?: string;
  payload: Record<string, unknown>;
  ts: Date;
}

/**
 * Convert a set of audit events for a single turn into a `Receipt`.
 *
 * Callers must ensure all events belong to the same turn (filter by
 * payload.turnId before calling, or use `receiptForTurn` which does it).
 *
 * @param turnId - The canonical turn id (kernel-generated, not from audit rows).
 * @param events - The audit events for this turn (any order; sorted internally).
 */
export function auditEventsToReceipt(turnId: TurnId, events: AuditEventRow[]): Receipt {
  if (events.length === 0) {
    return {
      turnId,
      model: 'unknown',
      toolsInvoked: [],
    };
  }

  // Sort ascending so durationMs = last.ts – first.ts
  const sorted = [...events].sort((a, b) => a.ts.getTime() - b.ts.getTime());
  const firstTs = sorted[0]?.ts?.getTime() ?? 0;
  const lastTs = sorted[sorted.length - 1]?.ts?.getTime() ?? 0;
  const durationMs = lastTs - firstTs;

  let model: string | undefined;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalTokens = 0;
  let hasUsage = false;
  const toolsSet = new Set<string>();
  let onBehalfOf: SlackUserId | undefined;

  for (const ev of events) {
    const p = ev.payload;

    // model — first gen_ai.completion wins
    if (ev.kind === 'gen_ai.completion' && model === undefined) {
      if (typeof p['model'] === 'string') {
        model = p['model'];
      }
    }

    // usage — sum across gen_ai.completion events
    if (ev.kind === 'gen_ai.completion') {
      const pt = typeof p['promptTokens'] === 'number' ? p['promptTokens'] : 0;
      const ct = typeof p['completionTokens'] === 'number' ? p['completionTokens'] : 0;
      const tt = typeof p['totalTokens'] === 'number' ? p['totalTokens'] : pt + ct;
      totalPromptTokens += pt;
      totalCompletionTokens += ct;
      totalTokens += tt;
      if (pt > 0 || ct > 0 || tt > 0) hasUsage = true;
    }

    // tools — app.tool.invoke or any kind containing execute_tool
    if (ev.kind === 'app.tool.invoke' || ev.kind.includes('execute_tool')) {
      if (typeof p['toolName'] === 'string') {
        toolsSet.add(p['toolName']);
      }
    }

    // onBehalfOf — first non-null wins
    if (onBehalfOf === undefined && ev.onBehalfOf != null) {
      onBehalfOf = ev.onBehalfOf;
    }
  }

  // Build the receipt incrementally to satisfy exactOptionalPropertyTypes:
  // optional properties must be absent (not `undefined`) when not set.
  const receipt: Receipt = {
    turnId,
    model: model ?? 'unknown',
    toolsInvoked: [...toolsSet],
  };

  if (hasUsage) {
    receipt.usage = {
      promptTokens: totalPromptTokens,
      completionTokens: totalCompletionTokens,
      totalTokens,
    };
  }
  if (durationMs > 0) {
    receipt.durationMs = durationMs;
  }
  if (onBehalfOf !== undefined) {
    receipt.onBehalfOf = onBehalfOf;
  }

  return receipt;
}

/**
 * Filter a flat list of audit events to those belonging to `turnId`, then
 * build a Receipt.
 *
 * The audit event payload is expected to carry `payload.turnId` (a string)
 * for every event associated with a turn.
 */
export function receiptForTurn(turnId: TurnId, allEvents: AuditEventRow[]): Receipt {
  const turnEvents = allEvents.filter((ev) => ev.payload['turnId'] === turnId);
  return auditEventsToReceipt(turnId, turnEvents);
}
