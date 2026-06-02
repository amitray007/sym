import {
  assistantThreadContextChanged,
  assistantThreadStarted,
  normalizeSlackEvent,
  slackTurnInputToTurn,
} from '@sym/adapter-slack';

import { handleAssistantThreadStarted } from './assistant.js';
import { resolveConfirmation, buildResolvedConfirmationMessage } from './confirmations.js';
import { handleTurn } from './handle-turn.js';
import { buildOwnerDeclineMessage } from './owner-gate.js';

import type { AssistantContextStore } from './assistant-context.js';
import type { AgentConfig } from './config.js';
import type { HandleTurnDeps } from './handle-turn.js';
import type { WorkspaceContext } from './workspace-context.js';
import type { RawSlackEvent } from '@sym/adapter-slack';
import type { SlackThreadTs, SlackUserId, Turn } from '@sym/contracts';

/**
 * Build the per-turn `HandleTurnDeps` from the workspace context. Extracted
 * so every ingress route (events, slash commands, future shortcuts) hands
 * `handleTurn` the same shape — no drift between paths.
 */
function buildTurnDeps(
  ctx: WorkspaceContext,
  config: AgentConfig,
  viewedChannelId?: string,
): HandleTurnDeps {
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
    nameResolver: ctx.nameResolver,
    // No mcpConfigs here: handleTurn reads the LIVE active set (getActiveConfigs),
    // which POST /admin/reload reconciles out-of-band. Passing the boot-frozen
    // ctx.mcpServers would pin every turn to the startup config and defeat reload.
  };
}

/**
 * Process an incoming Slack event from the Events API.
 *
 * Handles assistant lifecycle events (context-changed, thread-started), owner
 * gating, dedup, and dispatch to handleTurn.
 */
export async function processEvent(
  raw: RawSlackEvent,
  teamId: string,
  ctx: WorkspaceContext,
  config: AgentConfig,
  assistantContext: AssistantContextStore,
  ownerGate: (requester: SlackUserId, surface: string, text?: string) => boolean,
): Promise<void> {
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
    if (!ownerGate(ctxChanged.userId, 'assistant_panel')) return;
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
    if (!ownerGate(assistantStart.userId, 'assistant_panel')) return;
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
  // The attempt is logged inside ownerGate (name + request + time).
  if (!ownerGate(turn.requester, turn.entrySurface, turn.text)) {
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
  await handleTurn(turn, buildTurnDeps(ctx, config, viewedChannelId));
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
export async function processSlashCommand(
  rawEvent: RawSlackEvent,
  requester: SlackUserId,
  responseUrl: string,
  isDm: boolean,
  ctx: WorkspaceContext,
  config: AgentConfig,
  postToResponseUrl: (url: string, payload: unknown) => Promise<boolean>,
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
    // Sym isn't a member of this conversation (typically `not_in_channel` —
    // a private chat / DM with someone else / a channel it wasn't invited
    // to), so it can't seed a thread here. But it can STILL answer: Slack's
    // slash `response_url` posts back into the originating conversation
    // regardless of membership. Run the turn and deliver the reply that way.
    // Trade-off vs the seeded path: no live streaming / task cards / buttons
    // (response_url is a one-shot post), but the owner gets a real answer
    // instead of an impossible "invite me" instruction (you can't /invite a
    // bot into a 1:1 DM).
    console.warn('[agent] /sym seed post failed — answering via response_url instead:', err);
    try {
      await handleTurn(turn, {
        ...buildTurnDeps(ctx, config),
        replySink: async ({ text, blocks, receiptText }) => {
          // `text` is the FULL body, so text-only tiers are never truncated.
          // Each postToResponseUrl call logs the HTTP status + Slack error on
          // failure (a bare fetch would swallow a 4xx).
          //
          // DM context (1:1 or group): Slack SILENTLY DROPS a delayed
          // `in_channel` response_url reply (returns 200, renders nothing), so
          // we must use `ephemeral` — the owner who ran /sym sees the answer.
          // This is a Slack platform limit, not ours: a non-member app cannot
          // post a visible delayed reply into a DM (that's why /giphy answers
          // synchronously, which we can't — the model takes >3s).
          //
          // Non-DM (a channel Sym just isn't a member of): a delayed
          // `in_channel` reply DOES render, visible to the channel.
          //
          // Both branches try rich blocks first, then fall back to text-only
          // (the newer `markdown`/table block types aren't always accepted
          // over response_url).
          const responseType = isDm ? 'ephemeral' : 'in_channel';
          // Echo the command the same way the seed message does
          // (`<@owner> via /sym: <prompt>`) so the response_url reply has the
          // same attribution header as the in-channel experience — we can't
          // post a separate seed here, so we prepend it to the answer itself.
          const attribution = `<@${requester}> via \`/sym\`: ${seedText}`;
          // Rich tier: attribution header block + the answer/receipt blocks.
          const headedBlocks = [{ type: 'markdown', text: attribution }, ...blocks];
          // Text-only tier: the blocks' receipt context footer is unavailable,
          // so append the plain-text receipt under the answer to match.
          const footer = receiptText.length > 0 ? `\n\n${receiptText}` : '';
          const headedText = `${attribution}\n\n${text}${footer}`;
          if (
            await postToResponseUrl(responseUrl, {
              response_type: responseType,
              text: headedText,
              blocks: headedBlocks,
            })
          )
            return;
          await postToResponseUrl(responseUrl, { response_type: responseType, text: headedText });
        },
      });
    } catch (runErr) {
      console.warn('[agent] /sym response_url answer failed — sending hint instead:', runErr);
      await postToResponseUrl(responseUrl, {
        response_type: 'ephemeral',
        text: "I hit an error answering that here. Try again, or run `/sym` from our DM or a channel I'm in.",
      });
    }
    return;
  }

  // Re-issue the turn with the seed message's ts as the thread root so
  // `streamReply` engages (task cards + streaming require a threadTs).
  const threadedTurn: Turn = { ...turn, threadTs: seedTs };
  await handleTurn(threadedTurn, buildTurnDeps(ctx, config));
}

/**
 * Result of parsing a Slack interactivity payload — returned to the route
 * handler which owns the HTTP response.
 */
export type InteractivityResult =
  | { status: 401; body: { error: string | undefined } }
  | { status: 400; body: { error: string } }
  | { status: 200; body: { ok: boolean } }
  | {
      status: 'resolved';
      approved: boolean;
      responseUrl: string | undefined;
      message: { blocks?: unknown[]; text?: string };
    };

/**
 * Parse and process a Slack block_actions interactivity payload.
 *
 * Validates the form body, extracts the action, owner-gates the click, and
 * resolves the confirmation. The route handler owns the HTTP response — this
 * function returns a discriminated result so it can be tested without a real
 * Hono context.
 */
export function processInteractivity(
  rawBody: string,
  slackTeamId: string,
  ownerGate: (requester: SlackUserId, surface: string, text?: string) => boolean,
): InteractivityResult {
  // Parse `application/x-www-form-urlencoded` → extract `payload` field.
  let payloadJson: string;
  try {
    const params = new URLSearchParams(rawBody);
    const raw = params.get('payload');
    if (!raw) {
      return { status: 400, body: { error: 'missing_payload' } };
    }
    payloadJson = raw;
  } catch {
    return { status: 400, body: { error: 'invalid_form' } };
  }

  // Parse the block_actions payload.
  let payload: {
    type?: string;
    user?: { id?: string };
    team?: { id?: string };
    actions?: { action_id?: string }[];
    response_url?: string;
    message?: { blocks?: unknown[]; text?: string };
  };
  try {
    payload = JSON.parse(payloadJson) as typeof payload;
  } catch {
    return { status: 400, body: { error: 'invalid_payload_json' } };
  }

  if (payload.type !== 'block_actions') {
    // We only handle block_actions; ACK other interaction types without error.
    return { status: 200, body: { ok: true } };
  }

  const clickerId = payload.user?.id;
  const teamId = payload.team?.id;
  const actionId = payload.actions?.[0]?.action_id ?? '';
  const responseUrl = payload.response_url;

  if (!clickerId || !teamId) {
    return { status: 400, body: { error: 'missing_user_or_team' } };
  }

  // ---------------------------------------------------------------------------
  // Owner gate — only the owner's click, from our workspace, resolves a
  // confirmation. Foreign-workspace clicks are dropped before the owner gate.
  // The owner gate logs the clicked action_id as the request for any non-owner.
  // ---------------------------------------------------------------------------
  if (teamId !== slackTeamId) {
    return { status: 200, body: { ok: true } };
  }
  if (!ownerGate(clickerId as SlackUserId, 'interactivity', actionId)) {
    return { status: 200, body: { ok: true } };
  }

  // Parse action_id: `sym_confirm:<id>:approve|deny`
  const match = /^sym_confirm:([^:]+):(approve|deny)$/.exec(actionId);
  if (!match) {
    return { status: 200, body: { ok: true } };
  }

  const confirmationId = match[1] ?? '';
  const verdict = match[2] ?? '';
  const approved = verdict === 'approve';

  resolveConfirmation(confirmationId, approved);

  return {
    status: 'resolved',
    approved,
    responseUrl,
    message: payload.message ?? {},
  };
}

export { buildResolvedConfirmationMessage };
