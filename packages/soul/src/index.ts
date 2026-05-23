/**
 * `@sym/soul` — Soul cascade, tone-rewrite stage, and soul editor data API.
 *
 * ## L0 default
 *   - `L0_CONTENT_MD` — built-in global posture constant (never stored in DB).
 *
 * ## Cascade resolver
 *   - `resolveCascade(db, options): Promise<SoulCascade>`
 *   - `clearCascadeCache(): void` (for tests / forced invalidation)
 *   - `ResolveCascadeOptions`
 *
 * ## Tone-rewrite stage
 *   - `applyTone(draft, cascade, provider, model, signal?): Promise<ToneRewriteResult>`
 *
 * ## Substance-diff guard
 *   - `checkSubstanceDiff(original, rewritten): SubstanceDiffResult`
 *   - `SubstanceDiffResult`
 *
 * ## Soul editor data API (L1/L2/L3 CRUD)
 *   - `getSoulLayer(db, options): Promise<SoulLayerRow | null>`
 *   - `listSoulLayers(db, workspaceId): Promise<SoulLayerRow[]>`
 *   - `upsertSoulLayer(db, options): Promise<SoulLayerRow>`
 *   - `disableSoulLayer(db, options): Promise<void>`
 *   - `toSoulLayer(row): SoulLayer`
 *   - `SoulLayerRow`, `GetSoulLayerOptions`, `UpsertSoulLayerOptions`,
 *     `DeleteSoulLayerOptions`
 */

// L0 constant
export { L0_CONTENT_MD } from './l0.js';

// Cascade resolver
export { clearCascadeCache, resolveCascade } from './cascade.js';
export type { ResolveCascadeOptions } from './cascade.js';

// Tone-rewrite stage
export { applyTone } from './tone-rewrite.js';

// Substance-diff guard
export { checkSubstanceDiff } from './substance-diff.js';
export type { SubstanceDiffResult } from './substance-diff.js';

// Soul editor data API
export {
  disableSoulLayer,
  getSoulLayer,
  listSoulLayers,
  toSoulLayer,
  upsertSoulLayer,
} from './editor.js';
export type {
  DeleteSoulLayerOptions,
  GetSoulLayerOptions,
  SoulLayerRow,
  UpsertSoulLayerOptions,
} from './editor.js';
