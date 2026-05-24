import { auditEvents } from '@sym/db';
import { Shield } from 'lucide-react';

import { PlaceholderSection } from '@/components/placeholder-section';
import { getDb } from '@/lib/db';
import { formatRelativeTime } from '@/lib/utils';

export const metadata = { title: 'Audit Log · Sym' };

export const dynamic = 'force-dynamic';

interface AuditRow {
  id: number;
  kind: string;
  actorKind: string;
  actorId: string;
  ts: Date;
}

async function getRecentAuditEvents(): Promise<AuditRow[]> {
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
      .orderBy(auditEvents.id)
      .limit(50);

    return rows.reverse();
  } catch {
    return [];
  }
}

export default async function AuditPage() {
  const events = await getRecentAuditEvents();

  if (events.length === 0) {
    return (
      <PlaceholderSection
        icon={Shield}
        title="Audit Log"
        description="Every action Sym takes is recorded here — completions, tool calls, memory writes, and admin changes. The log is hash-chained for tamper evidence."
        comingSoon="No events yet — audit trail populates as Sym is used"
      />
    );
  }

  return (
    <div className="p-6 space-y-4 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-ink-primary font-semibold text-sm">Audit Log</h2>
          <p className="text-ink-tertiary text-xs mt-0.5">Hash-chained append-only event log</p>
        </div>
        <span className="badge-accent">{events.length} events</span>
      </div>

      <div className="card overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border bg-surface-4/50">
              <th className="text-left px-4 py-2.5 text-ink-tertiary font-medium tracking-wide">
                Event
              </th>
              <th className="text-left px-4 py-2.5 text-ink-tertiary font-medium tracking-wide">
                Actor
              </th>
              <th className="text-right px-4 py-2.5 text-ink-tertiary font-medium tracking-wide">
                When
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {events.map((ev) => (
              <tr key={ev.id} className="hover:bg-surface-4/30 transition-colors">
                <td className="px-4 py-2.5">
                  <span className="font-mono text-accent-400">{ev.kind}</span>
                </td>
                <td className="px-4 py-2.5 text-ink-secondary">
                  <span className="badge bg-surface-5 border border-border text-ink-tertiary mr-1.5">
                    {ev.actorKind}
                  </span>
                  {ev.actorId}
                </td>
                <td className="px-4 py-2.5 text-ink-tertiary text-right font-mono">
                  {formatRelativeTime(new Date(ev.ts))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
