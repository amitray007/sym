/**
 * Hono HTTP server — mounts all Slack webhook routes plus the admin API.
 *
 * Three public surfaces: `/slack/events` (all Slack event callbacks),
 * `/slack/interactivity` (button/action payloads), and `/slack/slash`
 * (slash-command POST). An `/admin/*` loopback surface lets the `sym` CLI
 * hot-reload connectors and introspect live state without a restart.
 */

import { getConnInfo } from '@hono/node-server/conninfo';
import { Hono } from 'hono';

import { verifySlackSignature } from '@sym/adapter-slack';
import { CloudRunReconciler } from '@sym/cursor-runtime';
import {
  completeOAuth,
  getActiveConfigs,
  getConnectorTools,
  listConnectorDetails,
  loadConnectorConfigs,
  McpDispatcher,
  reconcileConnectors,
  testConnector,
} from '@sym/mcp-runtime';

import { createAssistantContextStore } from './assistant-context.js';
import { processEvent, processInteractivity, processSlashCommand } from './event-router.js';
import { formatDeniedAttempt } from './owner-gate.js';
import { cliConnectorsSummary } from './run-cli.js';
import {
  createDedup,
  escapeHtml,
  htmlPage,
  isLoopback,
  isSlackResponseUrl,
  postToResponseUrl,
  truncate,
} from './server-utils.js';
import { healthCheckTokens, loadWorkspaceContext } from './workspace-context.js';

import type { AgentConfig } from './config.js';
import type { RawSlackEvent } from '@sym/adapter-slack';
import type { SlackChannelId, SlackThreadTs, SlackUserId } from '@sym/contracts';
import type { CloudRunRecord } from '@sym/cursor-runtime';

export interface ServerDeps {
  config: AgentConfig;
}

/** Slack message for a terminal cloud run — PR link on success, else the status. */
function cloudRunTransitionText(record: CloudRunRecord): string {
  if (record.prUrl !== undefined) {
    return `✅ Cloud agent finished — PR: ${record.prUrl}`;
  }
  const detail = record.statusText !== undefined ? ` — ${record.statusText}` : '';
  if (record.status === 'error') return `❌ Cloud agent failed${detail}`;
  if (record.status === 'cancelled') return `⚠️ Cloud agent was cancelled${detail}`;
  return `Cloud agent finished${detail}`;
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

  // Cloud-agent reconciler — polls tracked runs and posts the PR (or error) back
  // into the originating thread when a run finishes. Started once at boot; only
  // when the feature is configured. The timer is unref'd so it never holds the
  // process open. Resumes any non-terminal rows from the store (R7).
  if (ctx.cursor !== undefined) {
    const cursorCtx = ctx.cursor;
    const reconciler = new CloudRunReconciler({
      client: cursorCtx.client,
      store: cursorCtx.store,
      ...(config.cursor?.pollIntervalMs !== undefined
        ? { intervalMs: config.cursor.pollIntervalMs }
        : {}),
      onTransition: async (record: CloudRunRecord) => {
        await ctx.slackClient.chatPostMessage({
          channel: record.channel as SlackChannelId,
          thread_ts: record.threadTs as SlackThreadTs,
          text: cloudRunTransitionText(record),
        });
      },
      setIntervalFn: (fn, ms) => {
        const t = setInterval(fn, ms);
        t.unref();
        return t;
      },
    });
    reconciler.start();
    console.info('[agent] cloud-agent reconciler started');
  }

  /**
   * THE single owner gate. Every Slack ingress (DM, mention, slash command,
   * button click, assistant-panel lifecycle) routes its access decision through
   * here — there is no second copy of the `requester === owner` comparison. Add
   * a new ingress and you physically cannot let a non-owner through without
   * calling this, which keeps the "Sym works for exactly one human" invariant
   * structural rather than a thing each handler remembers to re-check.
   *
   * Returns `true` for the owner. On deny it fires {@link logDeniedAttempt}
   * (fire-and-forget — name resolution hits Slack and must never delay the 3s
   * ACK) and returns `false`. The CALLER owns the surface-specific response: a
   * polite line in a DM, total silence everywhere else. Fails closed via
   * `checkOwnerAccess` (unset owner ⇒ nobody passes).
   */
  function ownerGate(requester: SlackUserId, surface: string, text?: string): boolean {
    if (requester === ctx.ownerSlackUserId) return true;
    void logDeniedAttempt(requester, surface, text);
    return false;
  }

  /**
   * Audit a non-owner attempt to reach Sym: WHO (resolved display name + id),
   * WHAT (their request text / clicked action, truncated), WHERE (surface), and
   * WHEN (ISO timestamp), plus the deny reason. One structured `console.warn`
   * line so it greps cleanly out of the deploy logs. Name resolution is
   * best-effort — a miss falls back to the raw id, never blocks, never throws.
   */
  async function logDeniedAttempt(
    requester: SlackUserId,
    surface: string,
    text?: string,
  ): Promise<void> {
    const at = new Date().toISOString();
    let name = requester as string;
    try {
      name = await ctx.nameResolver.resolveUser(requester, ctx.slackClient);
    } catch {
      // Best-effort: keep the raw id if the lookup fails for any reason.
    }
    console.warn(
      formatDeniedAttempt({
        requester,
        name,
        surface,
        at,
        ownerSlackUserId: ctx.ownerSlackUserId,
        ...(text !== undefined && text.length > 0 ? { text: truncate(text) } : {}),
      }),
    );
  }

  /**
   * Consolidated Slack signature verification — used by all three Slack ingress
   * routes (/slack/events, /slack/interactivity, /slack/commands). The raw body
   * must be read BEFORE calling this so the exact bytes Slack sent are verified.
   *
   * Returns `{ ok: false }` on failure (caller should return 401).
   * Returns `{ ok: true }` when the signature and timestamp window are valid.
   */
  function verifySlack(
    signingSecret: string,
    headers: { timestamp: string; signature: string },
    rawBody: string,
  ): { ok: boolean; reason?: string } {
    return verifySlackSignature({
      signingSecret,
      headers: {
        'x-slack-request-timestamp': headers.timestamp,
        'x-slack-signature': headers.signature,
      },
      rawBody,
    });
  }

  app.post('/slack/events', async (c) => {
    const rawBody = await c.req.text();
    const verification = verifySlack(
      config.slackSigningSecret,
      {
        timestamp: c.req.header('x-slack-request-timestamp') ?? '',
        signature: c.req.header('x-slack-signature') ?? '',
      },
      rawBody,
    );
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
    // Cap the echoed challenge at 512 chars as defense-in-depth (the request is
    // HMAC-verified, but a length cap prevents a crafted oversized challenge from
    // being reflected verbatim into a log aggregator or downstream consumer).
    if (parsed.type === 'url_verification') {
      return c.json({ challenge: (parsed.challenge ?? '').slice(0, 512) });
    }

    // Dedup Slack retries (it re-sends if it doesn't get a fast 200).
    if (parsed.event_id && alreadySeen(parsed.event_id)) {
      return c.json({ ok: true });
    }

    // ACK now; do the slow work (LLM call + reply) after responding.
    if (parsed.team_id) {
      const teamId = parsed.team_id;
      void processEvent(parsed, teamId, ctx, config, assistantContext, ownerGate).catch(
        (err: unknown) => {
          console.error('[agent] processEvent failed', err);
        },
      );
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

    const verification = verifySlack(
      config.slackSigningSecret,
      {
        timestamp: c.req.header('x-slack-request-timestamp') ?? '',
        signature: c.req.header('x-slack-signature') ?? '',
      },
      rawBody,
    );
    if (!verification.ok) {
      return c.json({ error: verification.reason }, 401);
    }

    const result = processInteractivity(rawBody, config.slackTeamId, ownerGate);

    if (result.status === 'resolved') {
      // Confirmation resolved — DELETE the prompt so it doesn't linger as a spent
      // buttons message. The decision lives on the task card (the tool's own row
      // flips to running/✓ or denied/✗ via onToolGate), not on a leftover prompt.
      if (result.responseUrl) {
        // SSRF guard: only fetch URLs on the hooks.slack.com allow-list.
        if (!isSlackResponseUrl(result.responseUrl)) {
          console.warn(
            `[agent] interactivity response_url blocked — not hooks.slack.com: ${result.responseUrl}`,
          );
        } else {
          void fetch(result.responseUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ delete_original: true }),
          }).catch((err: unknown) => {
            console.warn('[agent] interactivity prompt delete failed (non-blocking):', err);
          });
        }
      }
      return c.json({ ok: true });
    }

    return c.json(result.body, result.status);
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

    const verification = verifySlack(
      config.slackSigningSecret,
      {
        timestamp: c.req.header('x-slack-request-timestamp') ?? '',
        signature: c.req.header('x-slack-signature') ?? '',
      },
      rawBody,
    );
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
    const channelName = params.get('channel_name') ?? '';
    const command = params.get('command') ?? '';
    const text = params.get('text') ?? '';
    const triggerId = params.get('trigger_id') ?? '';
    const responseUrl = params.get('response_url') ?? '';

    // Is this a DM-style conversation (1:1 `im` or group `mpim`)? Slack tags a
    // 1:1 DM with channel_name "directmessage" and an `im` id (`D…`); a group
    // DM with "mpdm-…". This matters for the response_url fallback: a DELAYED
    // `in_channel` reply is silently dropped by Slack in DM contexts (returns
    // 200 but never renders), so there we must answer `ephemeral` instead.
    const isDm =
      channelName === 'directmessage' ||
      channelName.startsWith('mpdm') ||
      channelId.startsWith('D');

    // Foreign-workspace guard — silent-ACK so a misconfigured second install
    // doesn't get a Slack-visible error pointing back at us.
    if (teamId !== config.slackTeamId) {
      return c.body(null, 200);
    }

    // Owner gate. The slash command surface looks identical for owner and
    // non-owner — silent ACK either way, no telltale Slack error. Non-owner
    // commands simply do nothing visible (but the attempt is logged: name,
    // the command text, and time).
    if (!ownerGate(userId as SlackUserId, 'slash_command', text)) {
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
      // SSRF guard: response_url must be on the hooks.slack.com allow-list.
      if (isSlackResponseUrl(responseUrl)) {
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
      } else {
        console.warn(
          `[agent] /sym usage hint: response_url blocked — not hooks.slack.com: ${responseUrl}`,
        );
      }
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
    void processSlashCommand(
      rawEvent,
      userId as SlackUserId,
      responseUrl,
      isDm,
      ctx,
      config,
      postToResponseUrl,
    ).catch((err: unknown) => {
      console.error('[agent] processSlashCommand failed', err);
    });
    return c.body(null, 200);
  });

  // --- OAuth callback (MCP connector authorization) -------------------------
  // The authorization server redirects here after the user authorizes.
  // Shape: GET /oauth/callback/:slug?code=<authcode>&state=<state>
  //
  // Security:
  //   - `state` is verified BEFORE `code` is used (CSRF protection).
  //   - `code` and `state` are NEVER echoed into logs or the response page.
  //   - This endpoint does not require Slack signature verification because
  //     it is driven by the OAuth authorization server, not Slack.
  app.get('/oauth/callback/:slug', async (c) => {
    const slug = c.req.param('slug') ?? '';
    const code = c.req.query('code') ?? '';
    const state = c.req.query('state') ?? '';

    if (!slug || !code || !state) {
      return c.html(
        htmlPage(
          'Authorization Failed',
          '<p>Missing required parameters (slug, code, or state). ' +
            'This link may be invalid or expired.</p>',
          false,
        ),
        400,
      );
    }

    try {
      await completeOAuth(slug, code, state);
      console.info(`[oauth] connector '${slug}' successfully authorized`);
      return c.html(
        htmlPage(
          'Authorization Successful',
          `<p>Connector <strong>${escapeHtml(slug)}</strong> has been authorized. ` +
            'You can close this window and return to Slack.</p>',
          true,
        ),
        200,
      );
    } catch (err) {
      // Log the error server-side; show a minimal error to the browser.
      // Never include code/state/tokens in the response.
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error(`[oauth] completeOAuth failed for connector '${slug}':`, message);
      return c.html(
        htmlPage(
          'Authorization Failed',
          `<p>Could not complete authorization for connector <strong>${escapeHtml(slug)}</strong>. ` +
            'Please try again or contact your administrator.</p>',
          false,
        ),
        400,
      );
    }
  });

  app.get('/health', (c) => c.json({ ok: true }));

  // --- Admin control plane (loopback-only) ----------------------------------
  // The `sym` CLI (run via `docker exec` inside the container) drives the live
  // connector pool through these routes. They are bound to loopback only: a
  // request whose remote address is not 127.0.0.1 / ::1 is refused. The CLI hits
  // http://127.0.0.1:<port> directly; proxied traffic arrives with the proxy's
  // address (or X-Forwarded-For) and is rejected. No secrets cross these routes.

  /** GET /admin/status — current live connector set + tool count (read-only). */
  app.get('/admin/status', (c) => {
    if (!isLoopback(getConnInfo(c).remote.address)) {
      return c.json({ error: 'forbidden', detail: 'admin endpoints are loopback-only' }, 403);
    }
    const active = getActiveConfigs();
    return c.json({
      connectors: active.map((s) => s.name),
      totalTools: new McpDispatcher(active).list().length,
    });
  });

  /**
   * POST /admin/reload — re-read the config file and reconcile the live pool.
   * This is the seam `sym apply` calls. Validate-then-swap happens inside
   * reconcileConnectors: a connector that fails to connect leaves the previous
   * healthy one serving. Returns a per-connector status report.
   */
  app.post('/admin/reload', async (c) => {
    if (!isLoopback(getConnInfo(c).remote.address)) {
      return c.json({ error: 'forbidden', detail: 'admin endpoints are loopback-only' }, 403);
    }
    const loaded = loadConnectorConfigs();
    const result = await reconcileConnectors(loaded.mcpServers);
    console.info(
      `[admin] reload from ${loaded.source} (${loaded.path}) — ${result.totalTools} tool(s) live ` +
        `across ${result.connectors.length} connector(s)`,
    );
    console.info(`[cli] ${cliConnectorsSummary()}`);
    return c.json({ source: loaded.source, path: loaded.path, ...result });
  });

  /** GET /admin/connectors — per-connector wiring + live health (dashboard rows). */
  app.get('/admin/connectors', (c) => {
    if (!isLoopback(getConnInfo(c).remote.address)) {
      return c.json({ error: 'forbidden', detail: 'admin endpoints are loopback-only' }, 403);
    }
    return c.json({ connectors: listConnectorDetails() });
  });

  /** GET /admin/connectors/:name/tools — the tools a connector serves. */
  app.get('/admin/connectors/:name/tools', (c) => {
    if (!isLoopback(getConnInfo(c).remote.address)) {
      return c.json({ error: 'forbidden', detail: 'admin endpoints are loopback-only' }, 403);
    }
    const tools = getConnectorTools(c.req.param('name'));
    if (tools === null) {
      return c.json({ error: 'not_connected', detail: 'unknown or unconnected connector' }, 404);
    }
    return c.json({ tools });
  });

  /** POST /admin/connectors/:name/test — re-connect one connector in isolation. */
  app.post('/admin/connectors/:name/test', async (c) => {
    if (!isLoopback(getConnInfo(c).remote.address)) {
      return c.json({ error: 'forbidden', detail: 'admin endpoints are loopback-only' }, 403);
    }
    const result = await testConnector(c.req.param('name'));
    return c.json(result);
  });

  return app;
}
