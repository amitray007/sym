/**
 * Dashboard DB singleton — lazily initialized from DATABASE_URL.
 * Returns null (not throws) when DATABASE_URL is absent, so typecheck +
 * build passes without a live DB.
 */

import type { DbHandle } from '@sym/db';

let handle: DbHandle | null = null;

export function getDb(): DbHandle | null {
  if (!process.env.DATABASE_URL) return null;
  if (handle) return handle;

  // Lazy require so Next build doesn't blow up at module-load time.
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
  const { createDb } = require('@sym/db') as any;
  handle = createDb(process.env.DATABASE_URL, { max: 5 }) as DbHandle;
  return handle;
}
