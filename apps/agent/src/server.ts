import {
  assistantThreadStarted,
  normalizeSlackEvent,
  slackTurnInputToTurn,
  verifySlackSignature,
} from '@sym/adapter-slack';
import { append } from '@sym/audit';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';

import { handleAssistantThreadStarted } from './assistant.js';
import { handleTurn } from './handle-turn.js';
import { SingleTenantError, installWorkspace } from './install.js';
import {
  buildAuthorizeUrl,
  exchangeCode,
  isOAuthConfigured,
  signState,
  verifyState,
} from './slack-oauth.js';
import { loadWorkspaceContext } from './workspace-context.js';

import type { AgentConfig } from './config.js';
import type { RawSlackEvent } from '@sym/adapter-slack';
import type { WorkspaceId } from '@sym/contracts';
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

    // Assistant container lifecycle: greet a freshly opened panel. Not a Turn.
    const assistantStart = assistantThreadStarted(raw);
    if (assistantStart) {
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
    await handleTurn(turn, {
      db,
      provider: ctx.provider,
      model: ctx.model,
      slackClient: ctx.slackClient,
      botUserId: ctx.botUserId,
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

  // --- Slack workspace install (OAuth v2) -----------------------------------
  // Two Slack OAuth surfaces exist; this is the WORKSPACE BOT INSTALL (persists
  // the bot token), distinct from the Clerk admin sign-in Slack OAuth.

  // Kick off the install: redirect to Slack's authorize screen with a signed state.
  app.get('/slack/install', (c) => {
    if (!isOAuthConfigured(config)) {
      return c.json({ error: 'oauth_not_configured' }, 503);
    }
    const state = signState(config.slackSigningSecret);
    return c.redirect(buildAuthorizeUrl(config, state));
  });

  // OAuth callback: verify state (CSRF), exchange the code, persist the install,
  // then return the browser to the dashboard.
  app.get('/slack/oauth/callback', async (c) => {
    if (!isOAuthConfigured(config)) {
      return c.json({ error: 'oauth_not_configured' }, 503);
    }
    const code = c.req.query('code');
    const state = c.req.query('state') ?? '';
    if (!code) {
      return c.json({ error: 'missing_code' }, 400);
    }
    if (!verifyState(config.slackSigningSecret, state)) {
      return c.json({ error: 'bad_state' }, 400);
    }
    try {
      const result = await exchangeCode(config, code);
      const install = await installWorkspace(db, result);
      // Audit the install (best-effort — a failed audit must not fail the install).
      try {
        await append(db, {
          workspaceId: install.workspaceId as WorkspaceId,
          kind: 'app.install',
          actorKind: 'slack_user',
          actorId: result.installerUserId,
          targetKind: 'workspace',
          targetId: install.workspaceId,
          payload: { teamId: install.teamId, reinstalled: install.reinstalled },
        });
      } catch (auditErr) {
        console.error('[agent] install audit append failed', auditErr);
      }
      // Back to the dashboard setup wizard — the install step is now done, and
      // the wizard promotes the (allowlisted) installer to owner on this return.
      const base = (config.dashboardUrl ?? '').replace(/\/$/, '');
      return c.redirect(base ? `${base}/setup` : '/setup');
    } catch (err) {
      if (err instanceof SingleTenantError) {
        return c.json({ error: 'single_tenant', message: err.message }, 409);
      }
      console.error('[agent] install failed', err);
      return c.json({ error: 'install_failed' }, 500);
    }
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
