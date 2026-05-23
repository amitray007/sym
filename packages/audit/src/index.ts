/**
 * `@sym/audit` — hash-chained audit log, receipt formatter, and OTel wiring.
 *
 * Public API:
 *
 * Append (the ONLY sanctioned write to audit_events):
 *   - `append(db, input): Promise<AuditEvent>`
 *   - `AppendInput`, `PayloadTooLargeError`, `MAX_PAYLOAD_BYTES`
 *
 * Hash computation (exported for the verifier and external tooling):
 *   - `computeHash(prevHash, fields): Buffer`
 *   - `buildHashInput(fields): JsonValue`
 *   - `canonicalJson(value): string`
 *   - `HashableEventFields`
 *
 * Verification:
 *   - `verifyChain(db, workspaceId): Promise<VerifyResult>`
 *   - `ChainOk`, `ChainBreak`, `VerifyResult`
 *
 * Receipt formatting:
 *   - `auditEventsToReceipt(turnId, events): Receipt`
 *   - `receiptForTurn(turnId, allEvents): Receipt`
 *   - `AuditEventRow`
 *
 * SSE broadcaster:
 *   - `subscribe(cb): () => void`
 *   - `unsubscribe(cb): void`
 *   - `subscriberCount(): number`
 *   - `AuditEventListener`
 *
 * Export:
 *   - `exportChain(db, workspaceId): Promise<ExportedAuditEvent[]>`
 *   - `ExportedAuditEvent`
 *
 * OTel attribute key constants (for consumers that want to add attributes):
 *   - `AUDIT_SCOPE`, `ATTR_WORKSPACE_ID`, `ATTR_AUDIT_KIND`, etc.
 */

// Append primitive
export { append, MAX_PAYLOAD_BYTES, PayloadTooLargeError } from './append.js';
export type { AppendInput } from './append.js';

// Hash computation
export { buildHashInput, computeHash } from './hash.js';
export type { HashableEventFields } from './hash.js';

// Canonical JSON
export { canonicalJson } from './canonical-json.js';

// Verification
export { verifyChain } from './verify.js';
export type { ChainBreak, ChainOk, VerifyResult } from './verify.js';

// Receipt formatter
export { auditEventsToReceipt, receiptForTurn } from './receipt.js';
export type { AuditEventRow } from './receipt.js';

// SSE broadcaster
export { subscribe, subscriberCount, unsubscribe } from './broadcaster.js';
export type { AuditEventListener } from './broadcaster.js';

// Export tool
export { exportChain } from './export.js';
export type { ExportedAuditEvent } from './export.js';

// OTel constants
export {
  appendCounter,
  ATTR_ACTOR_ID,
  ATTR_ACTOR_KIND,
  ATTR_AUDIT_EVENT_ID,
  ATTR_AUDIT_KIND,
  ATTR_CHAIN_VALID,
  ATTR_ENDUSER_ID,
  ATTR_ERROR_TYPE,
  ATTR_MESSAGING_SYSTEM,
  ATTR_TARGET_ID,
  ATTR_TARGET_KIND,
  ATTR_WORKSPACE_ID,
  AUDIT_SCOPE,
  chainBreakCounter,
  meter,
  payloadSizeHistogram,
  tracer,
} from './otel.js';
