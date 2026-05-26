import {
  assistantThreadContextChanged,
  assistantThreadStarted,
  normalizeSlackEvent,
  slackTurnInputToTurn,
  verifySlackSignature,
} from '@sym/adapter-slack';
import { Hono } from 'hono';

import { createAssistantContextStore } from './assistant-context.js';
import { handleAssistantThreadStarted } from './assistant.js';
import { resolveConfirmation } from './confirmations.js';
import { handleTurn } from './handle-turn.js';
import { OWNER_DECLINE_MESSAGE, checkOwnerAccess } from './owner-gate.js';
import { loadWorkspaceContext } from './workspace-context.js';

import type { AgentConfig } from './config.js';
import type { RawSlackEvent } from '@sym/adapter-slack';

export interface ServerDeps {
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
  const { config } = deps;
  const app = new Hono();
  const alreadySeen = createDedup();
  const assistantContext = createAssistantContextStore();
  // Single-tenant runtime context — resolved once from env config.
  const ctx = loadWorkspaceContext(config);

  async function processEvent(raw: RawSlackEvent, teamId: string): Promise<void> {
    // Single workspace: ignore events from any other Slack team.
    if (teamId !== config.slackTeamId) {
      console.warn(`[agent] ignoring event from foreign team ${teamId}`);
      return;
    }

    // Assistant container lifecycle: track context changes before anything else.
    const ctxChanged = assistantThreadContextChanged(raw);
    if (ctxChanged) {
      assistantContext.remember(
        ctxChanged.channelId,
        ctxChanged.threadTs,
        ctxChanged.contextChannelId,
      );
      return;
    }

    // Assistant container lifecycle: greet a freshly opened panel. Not a Turn.
    const assistantStart = assistantThreadStarted(raw);
    if (assistantStart) {
      assistantContext.remember(
        assistantStart.channelId,
        assistantStart.threadTs,
        assistantStart.contextChannelId,
      );
      await handleAssistantThreadStarted(ctx.slackClient, assistantStart);
      return;
    }

    const input = normalizeSlackEvent({
      event: raw,
      workspaceId: ctx.workspaceId,
      botUserId: ctx.botUserId,
    });
    if (!input) return; // an event we don't act on
    const turn = slackTurnInputToTurn(input);

    // Single-owner gate: Sym acts only on its owner's requests. Non-owner turns
    // are dropped — silently in channels (Sym stays invisible to the rest of the
    // team), with one polite line in a DM (silence in a 1:1 just looks broken).
    if (checkOwnerAccess(turn.requester, ctx.ownerSlackUserId) === 'deny') {
      if (turn.entrySurface === 'dm' && turn.channelId !== undefined) {
        try {
          await ctx.slackClient.chatPostMessage({
            channel: turn.channelId,
            text: OWNER_DECLINE_MESSAGE,
            ...(turn.threadTs !== undefined ? { thread_ts: turn.threadTs } : {}),
          });
        } catch (postErr) {
          console.warn('[agent] owner-gate decline post failed (continuing):', postErr);
        }
      }
      return;
    }

    const viewedChannelId =
      turn.channelId !== undefined && turn.threadTs !== undefined
        ? assistantContext.lookup(turn.channelId, turn.threadTs)
        : undefined;
    await handleTurn(turn, {
      fireworks: ctx.fireworks,
      model: ctx.model,
      slackClient: ctx.slackClient,
      botUserId: ctx.botUserId,
      slackTeamId: ctx.slackTeamId,
      ...(viewedChannelId !== undefined ? { viewedChannelId } : {}),
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

  // --- Slack Interactivity (button clicks for confirmations) ----------------
  // Slack posts a `application/x-www-form-urlencoded` body with a `payload`
  // field that contains URL-encoded JSON. We verify the Slack signature EXACTLY
  // as we do for /slack/events (same signing secret, raw body, timestamp window)
  // and then owner-gate the click before resolving the confirmation.
  //
  // Interactivity Request URL: <AGENT_URL>/slack/interactivity
  // Set this in your Slack app's "Interactivity & Shortcuts" settings.
  app.post('/slack/interactivity', async (c) => {
    // Read the raw body — must happen before any parsing so we can verify the
    // Slack signature over the exact bytes Slack sent.
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

    // Parse `application/x-www-form-urlencoded` → extract `payload` field.
    let payloadJson: string;
    try {
      const params = new URLSearchParams(rawBody);
      const raw = params.get('payload');
      if (!raw) {
        return c.json({ error: 'missing_payload' }, 400);
      }
      payloadJson = raw;
    } catch {
      return c.json({ error: 'invalid_form' }, 400);
    }

    // Parse the block_actions payload.
    let payload: {
      type?: string;
      user?: { id?: string };
      team?: { id?: string };
      actions?: { action_id?: string }[];
      response_url?: string;
    };
    try {
      payload = JSON.parse(payloadJson) as typeof payload;
    } catch {
      return c.json({ error: 'invalid_payload_json' }, 400);
    }

    if (payload.type !== 'block_actions') {
      // We only handle block_actions; ACK other interaction types without error.
      return c.json({ ok: true });
    }

    const clickerId = payload.user?.id;
    const teamId = payload.team?.id;
    const actionId = payload.actions?.[0]?.action_id ?? '';
    const responseUrl = payload.response_url;

    if (!clickerId || !teamId) {
      return c.json({ error: 'missing_user_or_team' }, 400);
    }

    // ---------------------------------------------------------------------------
    // Owner gate — only the owner's click, from our workspace, resolves a
    // confirmation. Anything else is silently ACK'd (no Slack error shown).
    // ---------------------------------------------------------------------------
    if (teamId !== config.slackTeamId || clickerId !== config.ownerSlackUserId) {
      return c.json({ ok: true });
    }

    // ---------------------------------------------------------------------------
    // Parse action_id: `sym_confirm:<id>:approve|deny`
    // ---------------------------------------------------------------------------
    const match = /^sym_confirm:([^:]+):(approve|deny)$/.exec(actionId);
    if (!match) {
      // Not a sym_confirm action — ACK without processing.
      return c.json({ ok: true });
    }

    const confirmationId = match[1] ?? '';
    const verdict = match[2] ?? '';
    const approved = verdict === 'approve';

    resolveConfirmation(confirmationId, approved);

    // ACK Slack immediately (already done implicitly by returning below).
    // Best-effort: update the interactive message via response_url so the
    // buttons are replaced with a status line. Never block the ACK on this.
    if (responseUrl) {
      const statusText = approved ? 'Approved ✅' : 'Cancelled ✋';
      void fetch(responseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ replace_original: true, text: statusText }),
      }).catch((err: unknown) => {
        console.warn('[agent] interactivity response_url update failed (non-blocking):', err);
      });
    }

    return c.json({ ok: true });
  });

  app.get('/health', (c) => c.json({ ok: true }));

  return app;
}
