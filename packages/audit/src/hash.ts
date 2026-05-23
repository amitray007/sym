/**
 * Hash-chain computation for the audit subsystem.
 *
 * thisHash = SHA-256( prevHash ‖ UTF8( canonicalJson(eventFields) ) )
 *
 * VERIFIER SPEC — exact hashed-field list and ordering:
 *
 * The canonical-JSON object hashed for each audit event contains exactly
 * these fields, in this key order (keys are sorted lexicographically, as
 * canonicalJson requires):
 *
 *   actorId      — string
 *   actorKind    — string  ("slack_user" | "admin" | "system" | "sandbox")
 *   id           — number  (bigserial, the event's own id)
 *   kind         — string  (open-namespace event kind)
 *   onBehalfOf   — string | null   (always present; null when column is null)
 *   payload      — object/array/scalar (the event body; canonicalised, so the
 *                  jsonb round-trip stays reproducible)
 *   targetId     — string | null   (always present; null when column is null)
 *   targetKind   — string | null   (always present; null when column is null)
 *   ts           — string (ISO-8601 with milliseconds, UTC, e.g.
 *                  "2026-01-02T03:04:05.678Z")
 *   workspaceId  — string
 *
 * Absent optional fields (onBehalfOf / targetKind / targetId) are included
 * as explicit `null` so the field count is stable and collisions between
 * "missing" and "the string 'null'" are impossible.
 *
 * Concatenation: `prevHash` bytes (32 bytes, or zero bytes when null) are
 * prepended directly before the UTF-8 encoded canonical-JSON bytes.  There
 * is no separator or length prefix — the prevHash is always exactly 0 or 32
 * bytes, so it is unambiguous.
 *
 * Encoding: output is a 32-byte `Buffer` (SHA-256 digest).
 */

import { createHash } from 'node:crypto';

import { canonicalJson } from './canonical-json.js';

import type { JsonValue } from '@sym/contracts';

/** The fields extracted from an audit event row for hashing. */
export interface HashableEventFields {
  id: number;
  workspaceId: string;
  kind: string;
  actorKind: string;
  actorId: string;
  onBehalfOf: string | null;
  targetKind: string | null;
  targetId: string | null;
  ts: Date;
  /**
   * The event body. MUST be hashed — it's the content the audit log exists to
   * make tamper-evident. canonicalJson sorts its keys recursively, so the
   * jsonb round-trip (which may reorder keys) stays reproducible. To guarantee
   * append and verify hash the identical value, both pass the DB-stored payload
   * (read back via RETURNING / SELECT), not the caller's in-memory object.
   */
  payload: JsonValue;
}

/**
 * Build the canonical-JSON object for the event fields (in sorted-key order).
 * Exported for testing — lets the verifier check the exact JSON without I/O.
 */
export function buildHashInput(fields: HashableEventFields): JsonValue {
  return {
    actorId: fields.actorId,
    actorKind: fields.actorKind,
    id: fields.id,
    kind: fields.kind,
    onBehalfOf: fields.onBehalfOf ?? null,
    payload: fields.payload,
    targetId: fields.targetId ?? null,
    targetKind: fields.targetKind ?? null,
    ts: fields.ts.toISOString(),
    workspaceId: fields.workspaceId,
  };
}

/**
 * Compute `thisHash` for one audit event.
 *
 * @param prevHash - 32-byte digest of the previous event, or `null` for the
 *   first event in a workspace's chain.
 * @param fields   - The identifying columns of the event, including payload.
 * @returns A 32-byte `Buffer` containing the SHA-256 digest.
 */
export function computeHash(prevHash: Buffer | null, fields: HashableEventFields): Buffer {
  const hashObj = buildHashInput(fields);
  const jsonStr = canonicalJson(hashObj as JsonValue);
  const jsonBytes = Buffer.from(jsonStr, 'utf8');

  const h = createHash('sha256');
  if (prevHash !== null) {
    h.update(prevHash);
  }
  h.update(jsonBytes);
  return h.digest();
}
