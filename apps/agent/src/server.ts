import {
  normalizeSlackEvent,
  slackTurnInputToTurn,
  verifySlackSignature,
} from '@sym/adapter-slack';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';

import { handleTurn } from './handle-turn.js';
import { loadWorkspaceContext } from './workspace-context.js';

import type { AgentConfig } from './config.js';
import type { RawSlackEvent } from '@sym/adapter-slack';
import type { Database } from '@sym/db';

export interface ServerDeps {
  db: Database;
  config: AgentConfig;
}

/** Bounded in-memory dedup by Slack `event_id`. Redis-backed dedup is S1's deferred piece. */
function createDedup(max = 10_000): (id: string) => boolean {
  const seen = new Set<string>();
  return (id: string): boolean => {
    if (seen.has(id)) return true;
    seen.add(id);
    if (seen.size > max) {
      // Drop the oldest half (insertion order preserved by Set).
      for (const old of [...seen].slice(0, max / 2)) seen.delete(old);
    }
    return false;
  };
}

/**
 * The agent's HTTP surface. Slack Events API (JSON) for app_mention + DM is
 * wired end-to-end here; slash commands / shortcuts arrive form-encoded and are
 * a follow-up (the adapter already normalizes their shape once parsed).
 *
 * Slack requires a 200 within 3s, so we ACK immediately and process the turn
 * asynchronously (the reply is delivered via chat.postMessage when ready).
 */
export function createServer(deps: ServerDeps): Hono {
  const { db, config } = deps;
  const app = new Hono();
  const alreadySeen = createDedup();

  async function processEvent(raw: RawSlackEvent, teamId: string): Promise<void> {
    const ctx = await loadWorkspaceContext(db, teamId);
    if (!ctx) {
      console.warn(`[agent] no installed/configured workspace for team ${teamId}`);
      return;
    }
    const input = normalizeSlackEvent({
      event: raw,
      workspaceId: ctx.workspaceId,
      botUserId: ctx.botUserId,
    });
    if (!input) return; // an event we don't act on
    const turn = slackTurnInputToTurn(input);
    await handleTurn(turn, {
      provider: ctx.provider,
      model: ctx.model,
      slackClient: ctx.slackClient,
    });
  }

  app.post('/slack/events', async (c) => {
    const rawBody = await c.req.text();
    const verification = verifySlackSignature({
      signingSecret: config.slackSigningSecret,
      headers: {
        'x-slack-request-timestamp': c.req.header('x-slack-request-timestamp') ?? '',
        'x-slack-signature': c.req.header('x-slack-signature') ?? '',
      },
      rawBody,
    });
    if (!verification.ok) {
      return c.json({ error: verification.reason }, 401);
    }

    let parsed: RawSlackEvent & { challenge?: string };
    try {
      parsed = JSON.parse(rawBody) as RawSlackEvent & { challenge?: string };
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }

    // Slack Events API endpoint verification handshake.
    if (parsed.type === 'url_verification') {
      return c.json({ challenge: parsed.challenge ?? '' });
    }

    // Dedup Slack retries (it re-sends if it doesn't get a fast 200).
    if (parsed.event_id && alreadySeen(parsed.event_id)) {
      return c.json({ ok: true });
    }

    // ACK now; do the slow work (LLM call + reply) after responding.
    if (parsed.team_id) {
      const teamId = parsed.team_id;
      void processEvent(parsed, teamId).catch((err: unknown) => {
        console.error('[agent] processEvent failed', err);
      });
    }
    return c.json({ ok: true });
  });

  app.get('/health', async (c) => {
    try {
      await db.execute(sql`SELECT 1`);
      return c.json({ ok: true });
    } catch {
      return c.json({ ok: false }, 503);
    }
  });

  return app;
}
