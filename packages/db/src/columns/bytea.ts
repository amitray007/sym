import { customType } from 'drizzle-orm/pg-core';

/**
 * `bytea` — raw binary column. Drizzle's pg-core has no built-in bytea.
 * Used for the audit hash chain (`prev_hash`/`this_hash` = sha256 digests)
 * and serialized kernel-state checkpoint blobs.
 */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});
