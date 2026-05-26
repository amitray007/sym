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
    <div className="p-6 space-y-5 animate-fade-in">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-ink-primary font-medium text-sm">Audit Log</h1>
          <p className="text-ink-secondary text-xs mt-0.5">Hash-chained append-only event log</p>
        </div>
        <span className="badge">{events.length} events</span>
      </div>

      <div className="card overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border">
              <th className="text-left px-4 py-2.5 text-ink-tertiary font-medium font-mono text-[10px] uppercase tracking-wider">
                Event
              </th>
              <th className="text-left px-4 py-2.5 text-ink-tertiary font-medium font-mono text-[10px] uppercase tracking-wider">
                Actor
              </th>
              <th className="text-right px-4 py-2.5 text-ink-tertiary font-medium font-mono text-[10px] uppercase tracking-wider">
                When
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {events.map((ev) => (
              <tr key={ev.id} className="hover:bg-surface-3/60 transition-colors">
                <td className="px-4 py-2.5">
                  <span className="font-mono text-ink-primary text-xs">{ev.kind}</span>
                </td>
                <td className="px-4 py-2.5 text-ink-secondary">
                  <span className="badge mr-1.5">{ev.actorKind}</span>
                  <span className="font-mono text-ink-tertiary text-[10px]">{ev.actorId}</span>
                </td>
                <td className="px-4 py-2.5 text-ink-tertiary text-right font-mono tabular-nums">
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
