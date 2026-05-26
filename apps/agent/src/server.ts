import {
  assistantThreadContextChanged,
  assistantThreadStarted,
  normalizeSlackEvent,
  slackTurnInputToTurn,
  verifySlackSignature,
} from '@sym/adapter-slack';
import { append } from '@sym/audit';
import { mcpConfigs, oauthTokens, uuidv7, workspaces } from '@sym/db';
import { InMemoryMcpAuthStore } from '@sym/ext-mcp';
import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';

import { createAssistantContextStore } from './assistant-context.js';
import { handleAssistantThreadStarted } from './assistant.js';
import {
  buildConnectorAuthorizeUrl,
  exchangeConnectorCode,
  generatePkce,
  generateState,
} from './connector-oauth.js';
import { handleTurn } from './handle-turn.js';
import { SingleTenantError, installWorkspace } from './install.js';
import { OWNER_DECLINE_MESSAGE, checkOwnerAccess, denyReason } from './owner-gate.js';
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
import type { ConnectorOAuthConfig, SlackUserId, WorkspaceId } from '@sym/contracts';
import type { Database } from '@sym/db';

/** Module-level store for in-flight connector OAuth sessions. One-time-use by state key. */
const connectorAuthStore = new InMemoryMcpAuthStore();

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
  const assistantContext = createAssistantContextStore();

  async function processEvent(raw: RawSlackEvent, teamId: string): Promise<void> {
    const ctx = await loadWorkspaceContext(db, teamId);
    if (!ctx) {
      console.warn(`[agent] no installed/configured workspace for team ${teamId}`);
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
      try {
        await append(db, {
          workspaceId: ctx.workspaceId,
          kind: 'app.turn.denied',
          actorKind: 'slack_user',
          actorId: turn.requester,
          targetKind: 'workspace',
          targetId: ctx.workspaceId,
          payload: {
            entrySurface: turn.entrySurface,
            reason: denyReason(ctx.ownerSlackUserId),
            ...(turn.channelId !== undefined ? { channelId: turn.channelId } : {}),
          },
        });
      } catch (auditErr) {
        console.error('[agent] denied-turn audit append failed', auditErr);
      }

      if (
        turn.entrySurface === 'dm' &&
        ctx.ownerSlackUserId !== null &&
        turn.channelId !== undefined
      ) {
        try {
          await ctx.slackClient.chatPostMessage({
            channel: turn.channelId,
            text: OWNER_DECLINE_MESSAGE,
            ...(turn.threadTs !== undefined ? { thread_ts: turn.threadTs } : {}),
          });
        } catch (postErr) {
          console.warn('[agent] owner-gate decline post failed (continuing):', postErr);
        }
      } else if (ctx.ownerSlackUserId === null) {
        console.warn(
          `[agent] owner gate: no owner set for workspace ${ctx.workspaceId}; ignoring turn from ${turn.requester}`,
        );
      }
      return;
    }

    const viewedChannelId =
      turn.channelId !== undefined && turn.threadTs !== undefined
        ? assistantContext.lookup(turn.channelId, turn.threadTs)
        : undefined;
    await handleTurn(turn, {
      db,
      provider: ctx.provider,
      model: ctx.model,
      slackClient: ctx.slackClient,
      botUserId: ctx.botUserId,
      slackTeamId: ctx.slackTeamId,
      ...(viewedChannelId !== undefined ? { viewedChannelId } : {}),
      audit: (input) => append(db, input).then(() => undefined),
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

  // --- Connector OAuth (per-connector "Connect a provider" flow) ---------------
  // GET /connectors/oauth/start?slug=<slug>
  //   Validates the connector, generates PKCE + state, stores the session,
  //   and redirects the browser to the provider's authorize URL.
  //
  // GET /connectors/oauth/callback?code=<code>&state=<state>
  //   Verifies state (one-time), exchanges the code, upserts the token row,
  //   appends an audit event, and redirects back to the dashboard.

  app.get('/connectors/oauth/start', async (c) => {
    const dashBase = (config.dashboardUrl ?? '').replace(/\/$/, '');
    const errorRedirect = `${dashBase}/connectors?connect=error`;

    // Derive the connector OAuth redirect_uri from the Slack OAuth redirect_uri
    // base (same origin), so we don't need a second env var.
    if (!config.oauthRedirectUri) {
      console.error('[connector-oauth] oauthRedirectUri is not configured');
      return c.text('connector_oauth_not_configured', 503);
    }
    const callbackUri = new URL(config.oauthRedirectUri).origin + '/connectors/oauth/callback';

    const slug = c.req.query('slug');
    if (!slug) {
      return c.redirect(errorRedirect);
    }

    // Load the single-tenant workspace.
    const wsRows = await db.select().from(workspaces).limit(1);
    const ws = wsRows[0];
    if (!ws) {
      return c.redirect(errorRedirect);
    }
    const workspaceId = ws.id as WorkspaceId;
    const owner = ws.ownerSlackUserId as SlackUserId;

    // Load the connector — must be enabled + oauth mode.
    const cfgRows = await db
      .select()
      .from(mcpConfigs)
      .where(
        and(
          eq(mcpConfigs.workspaceId, workspaceId),
          eq(mcpConfigs.slug, slug),
          eq(mcpConfigs.authMode, 'oauth'),
          eq(mcpConfigs.enabled, true),
        ),
      )
      .limit(1);

    const cfg = cfgRows[0];
    if (!cfg) {
      console.warn(`[connector-oauth] no enabled oauth connector for slug="${slug}"`);
      return c.redirect(errorRedirect);
    }

    const oauthCfg = cfg.oauthConfigJson as ConnectorOAuthConfig | null;
    if (
      !oauthCfg ||
      typeof oauthCfg !== 'object' ||
      !oauthCfg.authorizeUrl ||
      !oauthCfg.clientId ||
      !oauthCfg.tokenUrl ||
      !Array.isArray(oauthCfg.scopes)
    ) {
      console.error(`[connector-oauth] invalid oauthConfigJson for slug="${slug}"`);
      return c.redirect(errorRedirect);
    }

    // Generate PKCE and state.
    const { codeVerifier, codeChallenge, codeChallengeMethod } = generatePkce();
    const state = generateState();

    // Persist the session — one-time-use, TTL 600s (10 min).
    await connectorAuthStore.set(
      state,
      { provider: slug, userId: owner, codeVerifier, createdAt: new Date().toISOString() },
      600_000,
    );

    const authorizeUrl = buildConnectorAuthorizeUrl({
      authorizeUrl: oauthCfg.authorizeUrl,
      clientId: oauthCfg.clientId,
      redirectUri: callbackUri,
      scopes: oauthCfg.scopes,
      state,
      codeChallenge,
      codeChallengeMethod,
    });

    return c.redirect(authorizeUrl);
  });

  app.get('/connectors/oauth/callback', async (c) => {
    const dashBase = (config.dashboardUrl ?? '').replace(/\/$/, '');
    const errorRedirect = `${dashBase}/connectors?connect=error`;
    const successRedirect = `${dashBase}/connectors?connect=ok`;

    const code = c.req.query('code');
    const state = c.req.query('state') ?? '';

    if (!code || !state) {
      return c.redirect(errorRedirect);
    }

    // Look up + DELETE the session (one-time use).
    const session = await connectorAuthStore.get(state);
    await connectorAuthStore.delete(state);

    if (!session) {
      console.warn('[connector-oauth] unknown or expired state in callback');
      return c.redirect(errorRedirect);
    }

    const slug = session.provider;
    const owner = session.userId as SlackUserId;
    const codeVerifier = session.codeVerifier ?? '';

    // Derive callback URI (same logic as start route).
    if (!config.oauthRedirectUri) {
      console.error('[connector-oauth] oauthRedirectUri is not configured');
      return c.redirect(errorRedirect);
    }
    const callbackUri = new URL(config.oauthRedirectUri).origin + '/connectors/oauth/callback';

    // Load the workspace.
    const wsRows = await db.select().from(workspaces).limit(1);
    const ws = wsRows[0];
    if (!ws) {
      return c.redirect(errorRedirect);
    }
    const workspaceId = ws.id as WorkspaceId;

    // Load the connector (re-validate it still exists + is oauth mode).
    const cfgRows = await db
      .select()
      .from(mcpConfigs)
      .where(
        and(
          eq(mcpConfigs.workspaceId, workspaceId),
          eq(mcpConfigs.slug, slug),
          eq(mcpConfigs.authMode, 'oauth'),
          eq(mcpConfigs.enabled, true),
        ),
      )
      .limit(1);

    const cfg = cfgRows[0];
    if (!cfg) {
      console.warn(`[connector-oauth] connector slug="${slug}" not found during callback`);
      return c.redirect(errorRedirect);
    }

    const oauthCfg = cfg.oauthConfigJson as ConnectorOAuthConfig | null;
    if (!oauthCfg?.tokenUrl || !oauthCfg.clientId) {
      console.error(`[connector-oauth] invalid oauthConfigJson for slug="${slug}" in callback`);
      return c.redirect(errorRedirect);
    }

    // Decrypt the client secret from envJson.
    let clientSecret = '';
    if (cfg.envJson) {
      try {
        const env: unknown = JSON.parse(cfg.envJson);
        if (env !== null && typeof env === 'object' && !Array.isArray(env)) {
          const s = (env as Record<string, unknown>)['clientSecret'];
          if (typeof s === 'string') clientSecret = s;
        }
      } catch {
        // envJson malformed — proceed without secret (public client)
      }
    }

    // Exchange the code for tokens.
    let tokens: Awaited<ReturnType<typeof exchangeConnectorCode>>;
    try {
      tokens = await exchangeConnectorCode({
        tokenUrl: oauthCfg.tokenUrl,
        clientId: oauthCfg.clientId,
        clientSecret,
        code,
        redirectUri: callbackUri,
        codeVerifier,
      });
    } catch (err) {
      console.error('[connector-oauth] token exchange failed:', err);
      return c.redirect(errorRedirect);
    }

    const expiresAt =
      typeof tokens.expiresIn === 'number' ? new Date(Date.now() + tokens.expiresIn * 1000) : null;
    const scopes = tokens.scope
      ? tokens.scope.split(/[\s,]+/).filter(Boolean)
      : (oauthCfg.scopes ?? []);

    // Persist in a transaction: revoke any active token → insert new active one.
    try {
      await db.transaction(async (tx) => {
        // Revoke existing active tokens for (workspace, owner, slug).
        await tx
          .update(oauthTokens)
          .set({ status: 'revoked', revokedAt: new Date(), updatedAt: new Date() })
          .where(
            and(
              eq(oauthTokens.workspaceId, workspaceId),
              eq(oauthTokens.slackUserId, owner),
              eq(oauthTokens.provider, slug),
              eq(oauthTokens.status, 'active'),
            ),
          );

        // Insert the new active token.
        await tx.insert(oauthTokens).values({
          id: uuidv7(),
          workspaceId,
          slackUserId: owner,
          provider: slug,
          accessToken: tokens.accessToken,
          ...(tokens.refreshToken !== undefined ? { refreshToken: tokens.refreshToken } : {}),
          ...(expiresAt !== null ? { expiresAt } : {}),
          scopes,
          status: 'active',
        });
      });
    } catch (err) {
      console.error('[connector-oauth] failed to persist token:', err);
      return c.redirect(errorRedirect);
    }

    // Best-effort audit — never fail the flow.
    try {
      await append(db, {
        workspaceId,
        kind: 'app.connector.connect',
        actorKind: 'slack_user',
        actorId: owner,
        targetKind: 'connector',
        targetId: slug,
        payload: { slug },
      });
    } catch (auditErr) {
      console.error('[connector-oauth] audit append failed (continuing):', auditErr);
    }

    return c.redirect(successRedirect);
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
