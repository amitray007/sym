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
import { handleTurn, type HandleTurnDeps } from './handle-turn.js';
import { buildOwnerDeclineMessage, checkOwnerAccess } from './owner-gate.js';
import { healthCheckTokens, loadWorkspaceContext } from './workspace-context.js';

import type { AgentConfig } from './config.js';
import type { RawSlackEvent } from '@sym/adapter-slack';
import type { SlackThreadTs, SlackUserId, Turn } from '@sym/contracts';

export interface ServerDeps {
  config: AgentConfig;
}

/** Bounded in-memory dedup by Slack `event_id`. */
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
  // Fire-and-forget identity probe for the configured tokens. Surfaces
  // misconfiguration (wrong workspace, revoked token, missing user OAuth)
  // in the logs at boot without blocking server start.
  void healthCheckTokens(ctx);

  async function processEvent(raw: RawSlackEvent, teamId: string): Promise<void> {
    // Single workspace: ignore events from any other Slack team.
    if (teamId !== config.slackTeamId) {
      console.warn(`[agent] ignoring event from foreign team ${teamId}`);
      return;
    }

    // Assistant container lifecycle: track context changes before anything else.
    // Owner-gated — a non-owner navigating their own Sym panel must NOT cause
    // Sym to update any panel state on their behalf. Silent drop, no API calls.
    const ctxChanged = assistantThreadContextChanged(raw);
    if (ctxChanged) {
      if (ctxChanged.userId !== ctx.ownerSlackUserId) return;
      assistantContext.remember(
        ctxChanged.channelId,
        ctxChanged.threadTs,
        ctxChanged.contextChannelId,
      );
      return;
    }

    // Assistant container lifecycle: greet a freshly opened panel. Not a Turn.
    // Owner-gated — without this, a non-owner opening the Sym Assistant panel
    // would see a furnished bot (title, starter prompts, welcome message) that
    // implies Sym serves them. Their messages still get declined later, but the
    // first impression must not contradict the lock.
    const assistantStart = assistantThreadStarted(raw);
    if (assistantStart) {
      if (assistantStart.userId !== ctx.ownerSlackUserId) return;
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
            // Owner-aware so the requester gets a clickable next step
            // (mention the owner) instead of a dead-end "not for you".
            text: buildOwnerDeclineMessage(ctx.ownerSlackUserId, ctx.ownerProfile),
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
    await handleTurn(turn, buildTurnDeps(viewedChannelId));
  }

  /**
   * Build the per-turn `HandleTurnDeps` from the workspace context. Extracted
   * so every ingress route (events, slash commands, future shortcuts) hands
   * `handleTurn` the same shape — no drift between paths.
   */
  function buildTurnDeps(viewedChannelId?: string): HandleTurnDeps {
    return {
      fireworks: ctx.fireworks,
      model: ctx.model,
      slackClient: ctx.slackClient,
      ...(ctx.userSlackClient !== undefined ? { userSlackClient: ctx.userSlackClient } : {}),
      botUserId: ctx.botUserId,
      slackTeamId: ctx.slackTeamId,
      behavior: config.behavior,
      ...(viewedChannelId !== undefined ? { viewedChannelId } : {}),
      // Latest resolved owner profile (mutates onto ctx async — once boot
      // completes, every subsequent turn picks it up).
      ...(ctx.ownerProfile !== undefined ? { ownerProfile: ctx.ownerProfile } : {}),
    };
  }

  /**
   * Process a slash command turn. The flow:
   *   1. Post a visible seed message in the channel attributing the command to
   *      the owner ("`<@owner> via /sym`: <text>"). This gives us a `threadTs`
   *      so the streamed reply lands in a thread under it — full task cards +
   *      streaming + interactivity work, identical to an `app_mention` turn.
   *   2. Run the turn through `handleTurn`, threaded under the seed.
   *
   * If the seed post fails — typically `not_in_channel` for a channel Sym
   * isn't a member of — fall back to a private hint via `response_url`
   * explaining that Sym needs to be invited first. We never drop silently:
   * the owner deserves to see why their command did nothing.
   *
   * `responseUrl` is only used on the failure path; the success path is
   * indistinguishable from a normal threaded reply.
   */
  async function processSlashCommand(
    rawEvent: RawSlackEvent,
    requester: SlackUserId,
    responseUrl: string,
  ): Promise<void> {
    const input = normalizeSlackEvent({
      event: rawEvent,
      workspaceId: ctx.workspaceId,
      botUserId: ctx.botUserId,
    });
    if (!input) return;
    const turn = slackTurnInputToTurn(input);
    if (turn.channelId === undefined) return;

    // Seed the channel with a one-line attribution; its ts becomes the thread
    // root so the streamed reply renders as a normal in-thread answer.
    const seedText = turn.text && turn.text.length > 0 ? turn.text : '(no text)';
    let seedTs: SlackThreadTs;
    try {
      const result = await ctx.slackClient.chatPostMessage({
        channel: turn.channelId,
        text: `<@${requester}> via \`/sym\`: ${seedText}`,
      });
      seedTs = result.ts;
    } catch (err) {
      console.warn('[agent] /sym seed post failed — falling back to response_url:', err);
      // Most common cause is `not_in_channel`. Surface a private, actionable
      // hint to the owner via Slack's response_url (ephemeral by default).
      try {
        await fetch(responseUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            response_type: 'ephemeral',
            text:
              "I couldn't post in this channel — invite me first with `/invite @Sym`, then try `/sym` again. " +
              '(Or run it from a channel I’m already in, or from our DM.)',
          }),
        });
      } catch (postErr) {
        console.warn('[agent] /sym response_url fallback failed (continuing):', postErr);
      }
      return;
    }

    // Re-issue the turn with the seed message's ts as the thread root so
    // `streamReply` engages (task cards + streaming require a threadTs).
    const threadedTurn: Turn = { ...turn, threadTs: seedTs };
    await handleTurn(threadedTurn, buildTurnDeps());
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

  // --- Slack Slash Commands -------------------------------------------------
  // Single command for now: `/sym <anything>`. The Slack manifest declares it;
  // configure its Request URL to <AGENT_URL>/slack/commands.
  //
  // Slack posts an `application/x-www-form-urlencoded` body with fields:
  //   token, team_id, team_domain, channel_id, channel_name, user_id, user_name,
  //   command, text, trigger_id, response_url, api_app_id, …
  //
  // We sig-verify on the raw bytes (same secret as /slack/events), then gate
  // on workspace + owner. Non-owner / foreign-team commands silent-ACK so the
  // command "works" cosmetically without exposing Sym to the rest of the team.
  // The actual turn runs in the background via processSlashCommand.
  app.post('/slack/commands', async (c) => {
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

    // Parse the form-encoded payload.
    let params: URLSearchParams;
    try {
      params = new URLSearchParams(rawBody);
    } catch {
      return c.json({ error: 'invalid_form' }, 400);
    }

    const teamId = params.get('team_id') ?? '';
    const userId = params.get('user_id') ?? '';
    const channelId = params.get('channel_id') ?? '';
    const command = params.get('command') ?? '';
    const text = params.get('text') ?? '';
    const triggerId = params.get('trigger_id') ?? '';
    const responseUrl = params.get('response_url') ?? '';

    // Foreign-workspace guard — silent-ACK so a misconfigured second install
    // doesn't get a Slack-visible error pointing back at us.
    if (teamId !== config.slackTeamId) {
      return c.body(null, 200);
    }

    // Owner gate. The slash command surface looks identical for owner and
    // non-owner — silent ACK either way, no telltale Slack error. Non-owner
    // commands simply do nothing visible.
    if (checkOwnerAccess(userId as SlackUserId, ctx.ownerSlackUserId) === 'deny') {
      return c.body(null, 200);
    }

    if (!command || !channelId || !userId) {
      return c.body(null, 200);
    }

    // Dedup on trigger_id (Slack guarantees uniqueness per command invocation).
    // Slack doesn't retry slash commands the way it retries events, but the
    // same dedup keeps duplicate clicks (browser double-tap, mobile retry) safe.
    if (triggerId && alreadySeen(triggerId)) {
      return c.body(null, 200);
    }

    // Empty `/sym` with no text — nudge the owner ephemerally rather than
    // posting a blank seed in the channel.
    if (text.trim().length === 0) {
      void fetch(responseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          response_type: 'ephemeral',
          text: 'Usage: `/sym <question or instruction>` — e.g. `/sym recap #eng-platform from this morning`',
        }),
      }).catch((err: unknown) => {
        console.warn('[agent] /sym usage hint post failed:', err);
      });
      return c.body(null, 200);
    }

    // ACK now (empty 200, Slack's preferred shape for "no immediate message");
    // the real reply arrives via chat.postMessage from processSlashCommand.
    const rawEvent: RawSlackEvent = {
      type: 'slash_command',
      team_id: teamId,
      trigger_id: triggerId,
      command,
      user_id: userId,
      channel_id: channelId,
      text,
    };
    void processSlashCommand(rawEvent, userId as SlackUserId, responseUrl).catch((err: unknown) => {
      console.error('[agent] processSlashCommand failed', err);
    });
    return c.body(null, 200);
  });

  app.get('/health', (c) => c.json({ ok: true }));

  return app;
}
