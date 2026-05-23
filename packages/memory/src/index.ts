/**
 * `@sym/memory` — Sym's five-scope memory subsystem.
 *
 * Public API:
 *
 * Retrieval gate (implements `RetrievalGate` from `@sym/contracts`):
 *   - `getMemories(db, req)` — the ONLY sanctioned read path for memories.
 *     Enforces scope visibility in code; never in the prompt.
 *
 * Change-policy classifier:
 *   - `classify(turn, candidate, existing, provider, repetitionCount?)`
 *   - `ClassifyResult`
 *
 * Writer (applies classifier decisions to the DB + audit):
 *   - `applyDecision(db, input, result)`
 *   - `WriteInput`, `WriteResult`
 *
 * Custom-relational consent:
 *   - `requestConsent(db, input)`   — write a pending row
 *   - `acceptConsent(db, ...)`      — subject accepts → row becomes retrievable
 *   - `rejectConsent(db, ...)`      — subject rejects → row stays invisible
 *   - `pendingForSubject(db, ...)`  — list pending rows for a subject
 *   - `RequestConsentInput`
 */

// Retrieval gate
export { getMemories } from './gate.js';

// Classifier
export { classify } from './classifier.js';
export type { ClassifyResult } from './classifier.js';

// Writer
export { applyDecision } from './writer.js';
export type { WriteInput, WriteResult } from './writer.js';

// Custom-relational consent
export { acceptConsent, pendingForSubject, rejectConsent, requestConsent } from './consent.js';
export type { RequestConsentInput } from './consent.js';
