import {
  assistantThreadContextChanged,
  assistantThreadStarted,
  normalizeSlackEvent,
  slackTurnInputToTurn,
} from '@sym/adapter-slack';
import { Hono } from 'hono';

import { createAssistantContextStore } from './assistant-context.js';
import { handleAssistantThreadStarted } from './assistant.js';
import { resolveConfirmation } from './confirmations.js';
import { handleTurn } from './handle-turn.js';
import { OWNER_DECLINE_MESSAGE } from './owner-gate.js';
import { slackAuth } from './slack-auth.js';
import { healthCheckTokens, loadWorkspaceContext } from './workspace-context.js';

import type { AgentConfig } from './config.js';
import type { SlackContextVariables } from './slack-auth.js';
import type { RawSlackEvent } from '@sym/adapter-slack';
import type { SlackChannelId, SlackThreadTs, SlackUserId } from '@sym/contracts';

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
 * The agent's HTTP surface.
 *
 * EVERY route mounted at `/slack/*` is wrapped by `slackAuth` middleware,
 * which centrally enforces: Slack signature verification, single-workspace
 * scoping, and the SINGLE-OWNER access gate. Route handlers below assume
 * the request has already been authenticated AND authorized — they never
 * re-check team or owner. Adding a new Slack route = mount it under
 * `/slack/*` and the gate is inherited by construction. See `slack-auth.ts`.
 *
 * Slack requires a 200 within 3s, so handlers ACK immediately and process
 * the heavy work asynchronously (the reply is delivered via chat.postMessage
 * when ready).
 */
export function createServer(deps: ServerDeps): Hono<{ Variables: SlackContextVariables }> {
  const { config } = deps;
  const app = new Hono<{ Variables: SlackContextVariables }>();
  const alreadySeen = createDedup();
  const assistantContext = createAssistantContextStore();
  // Single-tenant runtime context — resolved once from env config.
  const ctx = loadWorkspaceContext(config);
  // Fire-and-forget identity probe for the configured tokens. Surfaces
  // misconfiguration (wrong workspace, revoked token, missing user OAuth)
  // in the logs at boot without blocking server start.
  void healthCheckTokens(ctx);

  // ---------------------------------------------------------------------------
  // The one and only Slack gate. Mounted before every /slack/* route so all
  // ingress is verified + owner-checked by construction. Do not re-mount or
  // re-check downstream.
  // ---------------------------------------------------------------------------
  app.use(
    '/slack/*',
    slackAuth({
      signingSecret: config.slackSigningSecret,
      allowedTeamId: config.slackTeamId,
      allowedOwnerUserId: config.ownerSlackUserId as SlackUserId,
      botUserId: config.slackBotUserId as SlackUserId,
      postDmDecline: async (channelId, threadTs) => {
        await ctx.slackClient.chatPostMessage({
          channel: channelId as SlackChannelId,
          text: OWNER_DECLINE_MESSAGE,
          ...(threadTs !== undefined ? { thread_ts: threadTs as SlackThreadTs } : {}),
        });
      },
    }),
  );

  // ---------------------------------------------------------------------------
  // /slack/events — Events API (app_mention, DM, assistant container lifecycle)
  // ---------------------------------------------------------------------------
  async function processEvent(raw: RawSlackEvent): Promise<void> {
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

    const viewedChannelId =
      turn.channelId !== undefined && turn.threadTs !== undefined
        ? assistantContext.lookup(turn.channelId, turn.threadTs)
        : undefined;
    await handleTurn(turn, {
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
    });
  }

  app.post('/slack/events', (c) => {
    const slack = c.get('slack');
    const raw = slack.event;
    if (!raw) return c.json({ ok: true });

    // Dedup Slack retries (it re-sends if it doesn't get a fast 200).
    if (raw.event_id && alreadySeen(raw.event_id)) {
      return c.json({ ok: true });
    }

    // ACK now; do the slow work (LLM call + reply) after responding.
    void processEvent(raw).catch((err: unknown) => {
      console.error('[agent] processEvent failed', err);
    });
    return c.json({ ok: true });
  });

  // ---------------------------------------------------------------------------
  // /slack/interactivity — button clicks for confirmations
  // ---------------------------------------------------------------------------
  app.post('/slack/interactivity', (c) => {
    const slack = c.get('slack');
    const payload = slack.interactivity;
    if (!payload) return c.json({ ok: true });

    if (payload.type !== 'block_actions') {
      // We only handle block_actions; ACK other interaction types without error.
      return c.json({ ok: true });
    }

    const actionId = payload.actions?.[0]?.action_id ?? '';
    const responseUrl = payload.response_url;

    // Parse action_id: `sym_confirm:<id>:approve|deny`
    const match = /^sym_confirm:([^:]+):(approve|deny)$/.exec(actionId);
    if (!match) {
      // Not a sym_confirm action — ACK without processing.
      return c.json({ ok: true });
    }

    const confirmationId = match[1] ?? '';
    const verdict = match[2] ?? '';
    const approved = verdict === 'approve';

    resolveConfirmation(confirmationId, approved);

    // ACK Slack immediately. Best-effort: update the interactive message via
    // response_url so the buttons are replaced with a status line. Never
    // block the ACK on this.
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

  // ---------------------------------------------------------------------------
  // /slack/commands — slash commands (e.g. /sym ...). Inherits the owner
  // gate from the middleware above. No slash commands are wired yet; this
  // ACKs cleanly so adding one is a matter of dispatch logic, not auth.
  // ---------------------------------------------------------------------------
  app.post('/slack/commands', (c) => {
    const slack = c.get('slack');
    const cmd = slack.slash;
    if (!cmd) return c.json({ ok: true });
    // TODO: dispatch by `cmd.command` when slash commands are introduced.
    // For now: silent ACK (Slack shows nothing to the user).
    console.log(`[agent] slash command received (no handler yet): ${cmd.command}`);
    return c.json({ ok: true });
  });

  app.get('/health', (c) => c.json({ ok: true }));

  return app;
}
