import { uuidv7 as generate } from 'uuidv7';

/**
 * Time-ordered UUIDv7 primary keys (see db-schema-draft Conventions § IDs).
 * Generated in-app so IDs are globally unique, sortable, and need no DB
 * round-trip. Used as the `$defaultFn` for every `text` primary key.
 */
export function uuidv7(): string {
  return generate();
}
