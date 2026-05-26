'use client';

import { Activity } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/utils';

interface ActivityEvent {
  id: number;
  kind: string;
  actorKind: string;
  actorId: string;
  ts: string;
}

function kindCategory(kind: string): string {
  if (kind.startsWith('gen_ai')) return 'inference';
  if (kind.startsWith('messaging')) return 'messaging';
  if (kind.startsWith('app.')) return 'app';
  return 'system';
}

// Category → badge modifier class (no dead sandbox/memory branches)
const CATEGORY_BADGE: Record<string, string> = {
  inference: 'badge-success',
  messaging: 'badge-warning',
  app: '',
  system: '',
};

interface ActivityFeedProps {
  initialEvents: ActivityEvent[];
}

export function ActivityFeed({ initialEvents }: ActivityFeedProps) {
  const [events, setEvents] = useState<ActivityEvent[]>(initialEvents);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  // Seed cursor captured once at mount (a ref, so the connect-once effect has
  // no reactive dependency). New events arrive via the functional setState.
  const seedCursorRef = useRef<number | undefined>(initialEvents[0]?.id);

  useEffect(() => {
    const lastId = seedCursorRef.current;
    const url = lastId ? `/api/activity?cursor=${lastId}` : '/api/activity';

    const es = new EventSource(url);
    esRef.current = es;

    es.onopen = () => {
      setConnected(true);
      setError(null);
    };

    es.onmessage = (e: MessageEvent<string>) => {
      try {
        const parsed = JSON.parse(e.data) as ActivityEvent;
        setEvents((prev) => {
          // Deduplicate by id
          if (prev.some((ev) => ev.id === parsed.id)) return prev;
          return [parsed, ...prev].slice(0, 200);
        });
      } catch {
        // ignore parse errors
      }
    };

    es.onerror = () => {
      setConnected(false);
      setError('Stream interrupted — reconnecting…');
    };

    return () => {
      es.close();
    };
  }, []);

  return (
    <div className="p-6 space-y-5 animate-fade-in">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-ink-primary font-medium text-sm">Activity</h1>
          <p className="text-ink-secondary text-xs mt-0.5">Real-time audit event stream</p>
        </div>

        {/* Live indicator — accent dot + label */}
        <div className="flex items-center gap-1.5">
          <span
            className={cn(
              'w-1.5 h-1.5 rounded-full flex-shrink-0',
              connected ? 'bg-accent' : 'bg-ink-muted',
            )}
          />
          <span className="text-[10px] font-mono text-ink-tertiary">
            {connected ? 'live' : 'connecting'}
          </span>
        </div>
      </div>

      {error && (
        <div className="px-3 py-2 rounded bg-warning/10 border border-warning/20">
          <span className="text-warning text-xs font-mono">{error}</span>
        </div>
      )}

      {/* Feed */}
      <div className="space-y-px">
        {events.length === 0 ? (
          <div className="card p-10 flex flex-col items-center gap-3">
            <Activity className="w-6 h-6 text-ink-muted" />
            <p className="text-ink-secondary text-xs text-center">
              No events yet. Activity will appear here as Sym runs.
            </p>
          </div>
        ) : (
          events.map((ev) => {
            const category = kindCategory(ev.kind);
            const badgeMod = CATEGORY_BADGE[category] ?? '';
            const relTime = formatRelativeTime(new Date(ev.ts));

            return (
              <div
                key={ev.id}
                className="flex items-center gap-3 px-4 py-2 rounded hover:bg-surface-3 transition-colors"
              >
                {/* Category tag */}
                <span className={cn('badge flex-shrink-0', badgeMod)}>{category}</span>

                {/* Event kind */}
                <span className="flex-1 text-ink-primary text-xs font-mono truncate min-w-0">
                  {ev.kind}
                </span>

                {/* Actor */}
                <span className="text-ink-tertiary text-[10px] font-mono flex-shrink-0 hidden sm:block">
                  {ev.actorKind}
                  <span className="text-ink-muted mx-1">·</span>
                  <span className="truncate max-w-[80px] inline-block align-bottom">
                    {ev.actorId}
                  </span>
                </span>

                {/* Time */}
                <span className="text-ink-muted text-[10px] font-mono flex-shrink-0 tabular-nums">
                  {relTime}
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffMin < 60) return `${diffMin}m ago`;
  return `${Math.floor(diffMin / 60)}h ago`;
}
