'use client';

import { Activity, Circle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/utils';

interface ActivityEvent {
  id: number;
  kind: string;
  actorKind: string;
  actorId: string;
  ts: string;
}

function actorKindColor(kind: string): string {
  switch (kind) {
    case 'slack_user':
      return 'text-accent-400';
    case 'admin':
      return 'text-warning';
    case 'system':
      return 'text-ink-tertiary';
    case 'sandbox':
      return 'text-success';
    default:
      return 'text-ink-secondary';
  }
}

function kindCategory(kind: string): string {
  if (kind.startsWith('app.memory')) return 'memory';
  if (kind.startsWith('gen_ai')) return 'inference';
  if (kind.startsWith('messaging')) return 'messaging';
  if (kind.startsWith('app.lease')) return 'sandbox';
  if (kind.startsWith('app.')) return 'app';
  return 'system';
}

const CATEGORY_COLORS: Record<string, string> = {
  memory: 'bg-accent/20 text-accent-400',
  inference: 'bg-success/15 text-success',
  messaging: 'bg-warning/15 text-warning',
  sandbox: 'bg-danger/15 text-danger',
  app: 'bg-surface-6 text-ink-secondary',
  system: 'bg-surface-5 text-ink-tertiary',
};

interface ActivityFeedProps {
  initialEvents: ActivityEvent[];
}

export function ActivityFeed({ initialEvents }: ActivityFeedProps) {
  const [events, setEvents] = useState<ActivityEvent[]>(initialEvents);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const lastId = events[0]?.id;
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
  }, []); // intentionally empty: SSE connects once on mount

  return (
    <div className="p-6 space-y-4 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-ink-primary font-semibold text-sm">Live Activity</h2>
          <p className="text-ink-tertiary text-xs mt-0.5">Real-time audit event stream</p>
        </div>
        <div className="flex items-center gap-2">
          <div
            className={cn(
              'flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[10px] font-medium',
              connected
                ? 'border-success/30 bg-success/10 text-success'
                : 'border-border bg-surface-3 text-ink-tertiary',
            )}
          >
            <Circle className={cn('w-1.5 h-1.5 fill-current', connected && 'animate-pulse')} />
            {connected ? 'Live' : 'Connecting…'}
          </div>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 px-3 py-2 rounded bg-warning/10 border border-warning/20">
          <span className="text-warning text-xs">{error}</span>
        </div>
      )}

      {/* Feed */}
      <div ref={listRef} className="space-y-1.5">
        {events.length === 0 ? (
          <div className="card p-10 flex flex-col items-center gap-3">
            <Activity className="w-8 h-8 text-ink-muted" />
            <p className="text-ink-secondary text-sm text-center">
              No events yet. Activity will appear here as Sym runs.
            </p>
          </div>
        ) : (
          events.map((ev) => {
            const category = kindCategory(ev.kind);
            const categoryStyle = CATEGORY_COLORS[category] ?? CATEGORY_COLORS['system']!;
            const relTime = formatRelativeTime(new Date(ev.ts));

            return (
              <div
                key={ev.id}
                className="card px-4 py-2.5 flex items-center gap-3 hover:bg-surface-4/60 transition-colors"
              >
                {/* Event kind */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span
                      className={cn('badge text-[10px] font-mono flex-shrink-0', categoryStyle)}
                    >
                      {category}
                    </span>
                    <span className="text-ink-primary text-xs font-mono truncate">{ev.kind}</span>
                  </div>
                </div>

                {/* Actor */}
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  <span className={cn('text-[10px] font-medium', actorKindColor(ev.actorKind))}>
                    {ev.actorKind}
                  </span>
                  <span className="text-ink-muted text-[10px]">·</span>
                  <span className="text-ink-tertiary text-[10px] font-mono truncate max-w-[80px]">
                    {ev.actorId}
                  </span>
                </div>

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
