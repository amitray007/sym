import { auditEvents } from '@sym/db';
import { desc, gt } from 'drizzle-orm';

import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * GET /api/activity
 *
 * Server-Sent Events stream of audit_events from @sym/db.
 * Query params:
 *   ?cursor=<bigint id>  — stream events with id > cursor (newer events)
 *
 * Polls the DB every 2 s for new events (long-poll style SSE).
 * Cross-process push via Redis pub/sub is a later chunk — the agent process
 * writes audit_events; this dashboard process polls. Simple and correct.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const cursorParam = searchParams.get('cursor');
  const cursorId = cursorParam ? parseInt(cursorParam, 10) : 0;

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const handle = getDb();

      // Send a ping to establish the connection
      controller.enqueue(encoder.encode(': ping\n\n'));

      if (!handle) {
        // No DB — send an empty keep-alive and close.
        controller.enqueue(encoder.encode(': no-db\n\n'));
        controller.close();
        return;
      }

      let lastId = cursorId;
      let closed = false;

      // Listen for client disconnect
      request.signal.addEventListener('abort', () => {
        closed = true;
        try {
          controller.close();
        } catch {
          // already closed
        }
      });

      // Poll loop
      while (!closed) {
        try {
          const whereClause = lastId > 0 ? gt(auditEvents.id, lastId) : undefined;

          const rows = await handle.db
            .select({
              id: auditEvents.id,
              kind: auditEvents.kind,
              actorKind: auditEvents.actorKind,
              actorId: auditEvents.actorId,
              ts: auditEvents.ts,
            })
            .from(auditEvents)
            .where(whereClause)
            .orderBy(desc(auditEvents.id))
            .limit(20);

          for (const row of rows.reverse()) {
            if (closed) break;
            const data = JSON.stringify({
              id: row.id,
              kind: row.kind,
              actorKind: row.actorKind,
              actorId: row.actorId,
              ts: row.ts.toISOString(),
            });
            controller.enqueue(encoder.encode(`data: ${data}\n\n`));
            lastId = Math.max(lastId, row.id);
          }
        } catch {
          // DB error — send a comment and continue
          if (!closed) {
            controller.enqueue(encoder.encode(': db-error\n\n'));
          }
        }

        if (!closed) {
          // Wait 2 s before polling again
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 2000);
            request.signal.addEventListener('abort', () => {
              clearTimeout(timer);
              resolve();
            });
          });
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // Disable Nginx buffering
    },
  });
}
