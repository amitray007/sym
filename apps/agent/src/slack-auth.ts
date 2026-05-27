import { verifySlackSignature } from '@sym/adapter-slack';

import { OWNER_DECLINE_MESSAGE, checkOwnerAccess } from './owner-gate.js';

import type { RawSlackEvent } from '@sym/adapter-slack';
import type { SlackUserId } from '@sym/contracts';
import type { MiddlewareHandler } from 'hono';

/**
 * Slack ingress hardening, in one place.
 *
 * Every Slack-originated request — Events API, Interactivity, Slash commands,
 * (future) Shortcuts — flows through {@link slackAuth} before any business
 * logic. That middleware:
 *
 *   1. Verifies the Slack signing-secret HMAC (the only thing that proves the
 *      request really came from Slack and not a replay).
 *   2. Parses the body once, regardless of content-type (JSON for events,
 *      form-urlencoded for everything else — interactivity nests a JSON
 *      `payload` field; slash commands are flat form fields).
 *   3. Extracts the `{teamId, userId}` principal from whichever shape Slack
 *      sent — they're all in different places per surface.
 *   4. Short-circuits the URL-verification handshake (it has no principal).
 *   5. Applies the SINGLE-OWNER gate: deny unless team is ours AND requester
 *      is the configured owner. Denials silent-ACK with HTTP 200 (Slack
 *      retries on non-2xx). The one exception is a DM from a non-owner: we
 *      post a one-line decline so a 1:1 doesn't just look broken.
 *
 * Route handlers downstream read `c.get('slack')` for the parsed payload and
 * MUST NOT re-check ownership — the gate is the middleware's job and only
 * the middleware's job. Adding a new Slack route = mounting it under
 * `/slack/*` and reading the parsed payload off the context. The gate is
 * inherited by construction.
 */

/** Which Slack surface the request came from — drives how we read the body. */
export type SlackRequestKind =
  | 'event' // Events API JSON (app_mention, message, assistant_thread_*)
  | 'interactivity' // Block-kit button clicks, view submissions (form → JSON payload)
  | 'slash' // Slash command (flat form)
  | 'url_verification' // One-time challenge during Slack app setup
  | 'unknown'; // Anything else — silently ACKed

/**
 * Parsed Slack request, surfaced on Hono context as `c.get('slack')`.
 * Routes get the already-parsed body; they never re-parse or re-verify.
 */
export interface ParsedSlackRequest {
  kind: SlackRequestKind;
  /** Workspace id ("team_id"). Absent only for url_verification. */
  teamId?: string;
  /** Acting user id. Absent only for url_verification and a handful of
   *  surface-less events (we silent-ACK those). */
  userId?: SlackUserId;
  /** url_verification challenge token (echoed straight back). */
  challenge?: string;
  /** The parsed event_callback body — only set when `kind === 'event'`. */
  event?: RawSlackEvent;
  /** The parsed `payload` JSON — only set when `kind === 'interactivity'`. */
  interactivity?: InteractivityPayload;
  /** The flat form fields — only set when `kind === 'slash'`. */
  slash?: SlashCommand;
  /** Raw request body — kept for any handler that needs to re-hash, log, etc. */
  rawBody: string;
}

/** Slack block_actions payload (subset we read). */
export interface InteractivityPayload {
  type?: string;
  user?: { id?: string };
  team?: { id?: string };
  actions?: { action_id?: string }[];
  response_url?: string;
}

/** Slash command form payload (subset we read). */
export interface SlashCommand {
  team_id: string;
  user_id: SlackUserId;
  channel_id: string;
  command: string;
  text: string;
  trigger_id?: string;
  response_url?: string;
}

/** Augment Hono's Variables so `c.get('slack')` is typed. */
export interface SlackContextVariables {
  slack: ParsedSlackRequest;
}

export interface SlackAuthDeps {
  signingSecret: string;
  allowedTeamId: string;
  allowedOwnerUserId: SlackUserId;
  /**
   * Optional polite-decline poster for non-owner DMs. When provided and a
   * denied request is a DM message event, the middleware fires this so the
   * sender doesn't see total silence in a 1:1. Channel mentions stay silent
   * regardless — Sym is invisible to the rest of the team there.
   *
   * Failures are swallowed (logged but never block the ACK).
   */
  postDmDecline?: (channelId: string, threadTs: string | undefined) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Principal extraction — Slack puts user/team in different places per surface
// ---------------------------------------------------------------------------

/**
 * Extract {teamId, userId} from any parsed Slack payload.
 * Returns undefineds for events that genuinely don't carry a requester
 * (e.g. assistant_thread_started carries the user inside `event.assistant_thread.user_id`).
 */
function extractPrincipal(parsed: ParsedSlackRequest): {
  teamId: string | undefined;
  userId: SlackUserId | undefined;
} {
  switch (parsed.kind) {
    case 'event': {
      const ev = parsed.event;
      if (!ev) return { teamId: undefined, userId: undefined };
      const teamId = ev.team_id;
      // event.event.user covers app_mention + message; assistant_thread_*
      // lifecycle events store the user under event.assistant_thread.user_id.
      const inner = ev.event;
      const eventUser = inner?.user;
      const assistantUser = inner?.assistant_thread?.user_id;
      const userId = (eventUser ?? assistantUser) as SlackUserId | undefined;
      return { teamId, userId };
    }
    case 'interactivity': {
      const p = parsed.interactivity;
      return {
        teamId: p?.team?.id,
        userId: p?.user?.id as SlackUserId | undefined,
      };
    }
    case 'slash': {
      const s = parsed.slash;
      return { teamId: s?.team_id, userId: s?.user_id };
    }
    default:
      return { teamId: undefined, userId: undefined };
  }
}

// ---------------------------------------------------------------------------
// Body parsing — JSON vs form vs form-with-nested-payload
// ---------------------------------------------------------------------------

function parseBody(contentType: string, rawBody: string): ParsedSlackRequest {
  const base: ParsedSlackRequest = { kind: 'unknown', rawBody };

  // Events API: application/json, top-level `type` tells us what it is.
  if (contentType.includes('application/json')) {
    let parsed: (RawSlackEvent & { challenge?: string }) | undefined;
    try {
      parsed = JSON.parse(rawBody) as RawSlackEvent & { challenge?: string };
    } catch {
      return base;
    }
    if (parsed.type === 'url_verification') {
      return { ...base, kind: 'url_verification', challenge: parsed.challenge ?? '' };
    }
    return {
      ...base,
      kind: 'event',
      event: parsed,
      ...(parsed.team_id !== undefined ? { teamId: parsed.team_id } : {}),
    };
  }

  // Form-encoded surfaces: interactivity (has `payload` field) or slash command.
  if (contentType.includes('application/x-www-form-urlencoded')) {
    const params = new URLSearchParams(rawBody);

    const payload = params.get('payload');
    if (payload !== null) {
      let interactivity: InteractivityPayload | undefined;
      try {
        interactivity = JSON.parse(payload) as InteractivityPayload;
      } catch {
        return base;
      }
      return { ...base, kind: 'interactivity', interactivity };
    }

    // Slash command: required fields tell us this is the shape.
    const command = params.get('command');
    if (command !== null) {
      const slash: SlashCommand = {
        command,
        team_id: params.get('team_id') ?? '',
        user_id: (params.get('user_id') ?? '') as SlackUserId,
        channel_id: params.get('channel_id') ?? '',
        text: params.get('text') ?? '',
        ...(params.get('trigger_id') ? { trigger_id: params.get('trigger_id') ?? '' } : {}),
        ...(params.get('response_url') ? { response_url: params.get('response_url') ?? '' } : {}),
      };
      return { ...base, kind: 'slash', slash };
    }
  }

  return base;
}

// ---------------------------------------------------------------------------
// Is this event a DM? (drives the polite-decline UX path)
// ---------------------------------------------------------------------------

function dmTarget(
  ev: RawSlackEvent | undefined,
): { channelId: string; threadTs: string | undefined } | undefined {
  const inner = ev?.event;
  if (!inner) return undefined;
  if (inner.type !== 'message' || inner.channel_type !== 'im') return undefined;
  return { channelId: inner.channel, threadTs: inner.thread_ts };
}

// ---------------------------------------------------------------------------
// The middleware
// ---------------------------------------------------------------------------

/**
 * Hono middleware that ALL Slack ingress routes must mount.
 *
 * On success, attaches the parsed payload to the request context (`c.set('slack', …)`)
 * and the handler runs. On any failure (bad signature, foreign team, non-owner,
 * malformed body), the middleware short-circuits with a Slack-appropriate
 * response — 401 for crypto failures, 200 for ACK-silently denials.
 *
 * Handlers MUST NOT re-check team or owner — by the time they run, the gate
 * has already allowed.
 */
export function slackAuth(deps: SlackAuthDeps): MiddlewareHandler<{
  Variables: SlackContextVariables;
}> {
  return async (c, next) => {
    const rawBody = await c.req.text();
    const verification = verifySlackSignature({
      signingSecret: deps.signingSecret,
      headers: {
        'x-slack-request-timestamp': c.req.header('x-slack-request-timestamp') ?? '',
        'x-slack-signature': c.req.header('x-slack-signature') ?? '',
      },
      rawBody,
    });
    if (!verification.ok) {
      return c.json({ error: verification.reason }, 401);
    }

    const contentType = c.req.header('content-type') ?? '';
    const parsed = parseBody(contentType, rawBody);

    // url_verification has no principal; respond with the challenge and stop.
    if (parsed.kind === 'url_verification') {
      return c.json({ challenge: parsed.challenge ?? '' });
    }

    const { teamId, userId } = extractPrincipal(parsed);

    // Foreign team or no principal at all → silent ACK. We never echo
    // anything useful back to an unauthorized caller.
    if (teamId === undefined || teamId !== deps.allowedTeamId) {
      return c.json({ ok: true });
    }

    // The one centralised gate. Every surface flows through this single line.
    if (userId === undefined || checkOwnerAccess(userId, deps.allowedOwnerUserId) === 'deny') {
      // Polite-decline UX for non-owner DMs only. Channel mentions stay silent
      // (Sym is invisible to the rest of the team), and slash/interactivity
      // denials silent-ACK too. Best-effort; never block the Slack ACK.
      if (parsed.kind === 'event' && deps.postDmDecline) {
        const target = dmTarget(parsed.event);
        if (target) {
          void deps
            .postDmDecline(target.channelId, target.threadTs)
            .catch((err: unknown) =>
              console.warn('[agent] owner-gate decline post failed (continuing):', err),
            );
        }
      }
      return c.json({ ok: true });
    }

    // Allowed. Stash the parsed payload and let the route run.
    c.set('slack', { ...parsed, teamId, userId });
    await next();
    return undefined;
  };
}

// Re-export the decline message so callers can craft their own posters without
// reaching into owner-gate (keeps the gate's public API in one import path).
export { OWNER_DECLINE_MESSAGE };
