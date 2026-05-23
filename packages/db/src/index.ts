/**
 * `@sym/db` public API. Every stream imports the schema + a client from here.
 *
 * NOTE (Sp2): branded IDs (`WorkspaceId`, …) are not yet applied to columns —
 * Sp3 (`@sym/contracts`) layers them in via `.$type<>()` with zero migration
 * impact. Secret columns are passthrough until Sp4 wires libsodium.
 */

export * from './schema/index.js';

export { createDb } from './client.js';
export type { Database, DbHandle, Schema, SqlClient } from './client.js';

export { uuidv7 } from './uuid.js';
export { encryptedText } from './columns/encrypted-text.js';
export { bytea } from './columns/bytea.js';
