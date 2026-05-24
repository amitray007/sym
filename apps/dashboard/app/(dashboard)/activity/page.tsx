import { auditEvents } from '@sym/db';
import { desc } from 'drizzle-orm';

import { ActivityFeed } from '@/components/activity-feed';
import { getDb } from '@/lib/db';

export const metadata = { title: 'Activity · Sym' };

export const dynamic = 'force-dynamic';

interface SeedEvent {
  id: number;
  kind: string;
  actorKind: string;
  actorId: string;
  ts: string;
}

async function getSeedEvents(): Promise<SeedEvent[]> {
  const handle = getDb();
  if (!handle) return [];

  try {
    const rows = await handle.db
      .select({
        id: auditEvents.id,
        kind: auditEvents.kind,
        actorKind: auditEvents.actorKind,
        actorId: auditEvents.actorId,
        ts: auditEvents.ts,
      })
      .from(auditEvents)
      .orderBy(desc(auditEvents.id))
      .limit(50);

    return rows.map((r) => ({
      ...r,
      ts: r.ts.toISOString(),
    }));
  } catch {
    return [];
  }
}

export default async function ActivityPage() {
  const seedEvents = await getSeedEvents();
  return <ActivityFeed initialEvents={seedEvents} />;
}
