import { sql } from 'drizzle-orm';

import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

interface HealthResult {
  ok: boolean;
  db: 'ok' | 'error' | 'unconfigured';
  redis: 'ok' | 'error' | 'unconfigured';
  ts: string;
}

/**
 * GET /api/health
 *
 * Checks DB (via @sym/db) and Redis reachability.
 * Returns { ok, db, redis, ts } — degrades gracefully when a dependency is down.
 */
export async function GET(): Promise<Response> {
  const result: HealthResult = {
    ok: false,
    db: 'unconfigured',
    redis: 'unconfigured',
    ts: new Date().toISOString(),
  };

  // ── DB check ──────────────────────────────────────────────────────────────
  const handle = getDb();
  if (!handle) {
    result.db = 'unconfigured';
  } else {
    try {
      await handle.db.execute(sql`SELECT 1`);
      result.db = 'ok';
    } catch {
      result.db = 'error';
    }
  }

  // ── Redis check ───────────────────────────────────────────────────────────
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    result.redis = 'unconfigured';
  } else {
    try {
      // Dynamic import so the module doesn't blow up at build time
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { default: Redis } = (await import('ioredis')) as any;
      const redis = new Redis(redisUrl, {
        connectTimeout: 2000,
        commandTimeout: 2000,
        maxRetriesPerRequest: 0,
        lazyConnect: true,
        enableOfflineQueue: false,
      });
      await redis.connect();
      await redis.ping();
      await redis.disconnect();
      result.redis = 'ok';
    } catch {
      result.redis = 'error';
    }
  }

  result.ok = result.db !== 'error' && result.redis !== 'error';

  const status = result.ok ? 200 : 503;

  return Response.json(result, { status });
}
