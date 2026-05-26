import type { AuditEventId, SlackUserId, WorkspaceId } from './ids.js';
import type { JsonObject } from './json.js';

export type AuditActorKind = 'slack_user' | 'admin' | 'system' | 'sandbox';

/** Well-known kinds for convention + reference. The namespace itself is open. */
export type WellKnownAuditEventKind =
  | 'app.grant.create'
  | 'app.grant.revoke'
  | 'gen_ai.completion'
  | 'messaging.slack.send'
  | 'messaging.slack.receive';

/**
 * Open namespace — `audit_events.kind` is a `text` column, not an enum.
 * Use `WellKnownAuditEventKind` where a known value is expected. Conventions
 * live in specs/logging/semantics.md.
 */
export type AuditEventKind = string;

/** An audit row. Mirrors `audit_events`. Hashes are the chain link. */
export interface AuditEvent {
  id: AuditEventId;
  workspaceId: WorkspaceId;
  kind: AuditEventKind;
  actorKind: AuditActorKind;
  actorId: string;
  onBehalfOf?: SlackUserId;
  targetKind?: string;
  targetId?: string;
  payload: JsonObject;
  ts: Date;
}

/**
 * One link in the per-workspace hash chain.
 * `thisHash = sha256(prevHash ‖ canonical_json(event-fields))`.
 */
export interface HashChainEntry {
  prevHash: Uint8Array | null;
  thisHash: Uint8Array;
}
