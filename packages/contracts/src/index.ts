/**
 * `@sym/contracts` — the canonical type surface every Sym package imports.
 * Pure types, zero runtime. The lever that lets the S1–S8 streams be built in
 * parallel without colliding: lock the interface here, implement on either side.
 */

export type * from './brand.js';
export type * from './json.js';
export type * from './ids.js';
export type * from './slack.js';
export type * from './domain.js';
export type * from './provider.js';
export type * from './tools.js';
export type * from './audit.js';
export type * from './errors.js';
