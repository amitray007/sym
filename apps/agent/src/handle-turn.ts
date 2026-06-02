/**
 * Per-turn orchestrator — builds the tool registry, runs the Pi loop, and
 * delivers the reply to Slack.
 *
 * `handleTurn` is the main entry point for every user message. It wires the
 * dependencies (Slack client, Fireworks model, MCP pool, builtin tools) into a
 * `ToolRegistry`, delegates to `streamReply` for streamed delivery or falls
 * back to `postMessage`, and drives the `PlanController` that backs the live
 * task card.
 */

import { markdownBlocks, receiptToContextBlock, receiptToFooterFields } from '@sym/adapter-slack';
import { ToolRegistry } from '@sym/kernel';

import { createBuiltinDispatcher } from './builtin-tools.js';
import { logCtx } from './log.js';
import { CompositeDispatcher, McpDispatcher, initMcpPool, getActiveConfigs } from './mcp/index.js';
import { PlanController } from './plan-controller.js';
import {
  clipNotif,
  finalReplyBody,
  heroRenderParts,
  runTurnLoop,
  streamReply,
} from './stream-reply.js';
import { loadTurnHistory, loadViewedChannelContext } from './turn-context.js';

import type { BehaviorConfig } from './config.js';
import type { ConnectorConfig } from './mcp/index.js';
import type { NameResolver } from './name-resolver.js';
import type { SlackBlock, SlackClient } from '@sym/adapter-slack';
import type { ChatMessage, SlackChannelId, SlackThreadTs, SlackUserId, Turn } from '@sym/contracts';
import type { OwnerIdentity } from '@sym/kernel';

/** Injected dependencies for processing a turn (the testable seam). */
export interface HandleTurnDeps {
  /** Raw Fireworks credentials — required by the Pi loop. */
  fireworks: { baseUrl: string; apiKey: string };
  model: string;
  /** Bot-token client — Sym's identity (replies, streaming, status). */
  slackClient: SlackClient;
  /**
   * Owner user-token client — present when SLACK_OWNER_USER_TOKEN is set.
   * Tools declared `actor: 'user'` use this for broader visibility and
   * act-as-owner writes.
   */
  userSlackClient?: SlackClient;
  /** Sym's own bot user id — lets thread history mark its posts as assistant. */
  botUserId: SlackUserId;
  /** Slack team id — required as `recipientTeamId` when streaming into channels. */
  slackTeamId: string;
  /** The channel the user is currently viewing in Slack's assistant panel, if known. */
  viewedChannelId?: string;
  /** Runtime behavior knobs. */
  behavior: BehaviorConfig;
  /**
   * Resolved owner identity (name, tz, title) — embedded in the per-turn
   * metadata so the model can address the owner naturally. Undefined when
   * boot-time resolution hasn't completed or failed.
   */
  ownerProfile?: OwnerIdentity;
  /**
   * Workspace-scoped name resolver — passed into the builtin dispatcher
   * so tool returns surface `@DisplayName` / `#channel-name` instead of
   * raw `<@U…>` / `<#C…>` markup.
   */
  nameResolver: NameResolver;
  /**
   * Parsed MCP server configs from `SYM_MCP_SERVERS` env var.
   * When empty, no MCP tools are registered (zero-config safe default).
   * When present, MCP tools are available alongside builtin tools.
   */
  mcpConfigs?: ConnectorConfig[];
  /**
   * Optional override for FINAL reply delivery. When set, handleTurn does NOT
   * post to Slack and skips streaming (which needs a postable thread) — it hands
   * the rendered reply here instead. Used by the slash-command `response_url`
   * path: when Sym isn't a member of the conversation it can't `chat.postMessage`
   * a seed, but Slack's response_url delivers the answer there regardless. The
   * turn still runs identically (same tools, same loop); only delivery differs.
   */
  replySink?: (msg: {
    text: string;
    blocks: SlackBlock[];
    /**
     * Plain-text rendering of the receipt footer (model / tools / duration),
     * for the text-only delivery tier where the `blocks` context footer can't
     * be used. The rich tier shows the footer via the receipt context block in
     * `blocks`, so this is only needed when falling back to text.
     */
    receiptText: string;
  }) => Promise<void>;
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

/** Max characters in a derived assistant-thread title (Slack truncates long ones). */
const TITLE_MAX_CHARS = 60;
/** Words pulled from the user's text when deriving a title. */
const TITLE_MAX_WORDS = 8;

/**
 * Heuristic title from a user message — strips bot mentions / links, takes the
 * first few words, truncates. Used for `assistant.threads.setTitle` on the
 * first user turn in an assistant-panel thread so Slack's left-rail History
 * shows something readable instead of the raw question.
 */
function deriveTitle(userText: string): string {
  const cleaned = userText
    // Drop bot mentions like <@U123ABC> and channel/user link syntax.
    .replace(/<[@#!][^>]+>/g, '')
    // Collapse URLs to their host.
    .replace(/https?:\/\/(\S+)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length === 0) return 'New chat with Sym';
  const words = cleaned.split(' ').slice(0, TITLE_MAX_WORDS).join(' ');
  const truncated =
    words.length > TITLE_MAX_CHARS ? `${words.slice(0, TITLE_MAX_CHARS - 1)}…` : words;
  return capitalize(truncated);
}

/**
 * Set the assistant-panel thread title from the user's first message — only
 * for DM/assistant-panel turns AND only when the thread has no prior user
 * messages (the welcome post from `handleAssistantThreadStarted` is an
 * assistant message and doesn't count). Best-effort: failures are logged.
 */
async function maybeSetThreadTitleFromTurn(
  turn: Turn,
  deps: HandleTurnDeps,
  history: ChatMessage[],
): Promise<void> {
  if (turn.entrySurface !== 'dm') return;
  if (turn.channelId === undefined || turn.threadTs === undefined) return;
  const hasPriorUserTurn = history.some((m) => m.role === 'user');
  if (hasPriorUserTurn) return;
  // The turn text carries preserved `<@U…>` / `<#C…>` tokens; flatten them to
  // plain `@Name` / `#name` first, because the title is NOT Slack mrkdwn —
  // `deriveTitle` would otherwise strip the whole token and drop the name.
  // Best-effort: a resolver miss falls through to the raw text (deriveTitle
  // strips the tag markup either way).
  let titleSource = turn.text ?? '';
  try {
    titleSource = deps.nameResolver.flattenToNames(titleSource);
  } catch {
    // fall through with the raw turn text
  }
  const title = deriveTitle(titleSource);
  try {
    await deps.slackClient.assistantThreadsSetTitle({
      channelId: turn.channelId as SlackChannelId,
      threadTs: turn.threadTs as SlackThreadTs,
      title,
    });
  } catch (err) {
    console.warn(
      `${logCtx(turn.id)} [agent] setTitle from first user turn failed (continuing):`,
      err,
    );
  }
}

/**
 * The turn path: read live Slack history for context, run the Pi loop with the
 * built-in tools, and deliver the reply to Slack.
 *
 * Stateless — Slack is the only memory; nothing is persisted. Deps are injected
 * so this is unit-testable with a mocked Pi loop + a mock Slack client.
 *
 * Delivery strategy:
 *  - Threaded turns (threadTs defined): attempt streaming; fall back to postMessage.
 *  - Unthreaded turns (slash commands etc.): always postMessage.
 */
export async function handleTurn(turn: Turn, deps: HandleTurnDeps): Promise<void> {
  const ctx = logCtx(turn.id);
  if (!turn.channelId) {
    console.warn(`${ctx} [agent] turn has no channelId; cannot reply`);
    return;
  }

  // Independent reads — run them concurrently to shave a round-trip off every
  // assistant-panel turn (each does its own Slack fetch + name resolution).
  const [baseHistory, viewedContext] = await Promise.all([
    loadTurnHistory(turn, deps),
    loadViewedChannelContext(turn, deps),
  ]);
  const history = viewedContext ? [viewedContext, ...baseHistory] : baseHistory;

  // Rewrite the owner's own message — their text can carry raw `<@U…>` /
  // `<#C…>` markup when Slack converted typed @-mentions on send. Without
  // this pass, the model receives `<@U042>` in the user-turn metadata frame
  // and may parrot it back. Best-effort: a resolver miss falls through to
  // the raw text, identical to the pre-resolver behaviour.
  let rewrittenTurn = turn;
  if (turn.text !== undefined && turn.text.length > 0) {
    try {
      const rewrittenText = await deps.nameResolver.rewriteMentions(turn.text, deps.slackClient);
      if (rewrittenText !== turn.text) {
        rewrittenTurn = { ...turn, text: rewrittenText };
      }
    } catch {
      // fall through with the raw turn
    }
  }

  // First user turn in an assistant-panel thread → derive a real title from
  // their question. Fire-and-forget so it doesn't add latency to the reply.
  // Checks `baseHistory` (raw thread) not `history` (which includes synthetic
  // viewed-channel context as a user role message). Use the resolver-rewritten
  // turn so the title shows display names, not raw `<@U…>` markup.
  void maybeSetThreadTitleFromTurn(rewrittenTurn, deps, baseHistory);

  // Per-turn plan controller — both streaming and post-message paths share
  // this. On the streaming path it drives the TaskCardManager into plan-mode
  // when the model calls `set_plan`; on the post-message path it's a no-op
  // state holder (no card exists) but the tool calls still succeed cleanly.
  const planController = new PlanController();

  const builtin = createBuiltinDispatcher({
    slackClient: deps.slackClient,
    botUserId: deps.botUserId,
    ...(deps.userSlackClient !== undefined ? { userSlackClient: deps.userSlackClient } : {}),
    ownerPostMarker: deps.behavior.ownerPostMarker,
    planController,
    nameResolver: deps.nameResolver,
  });

  // MCP tool layer — lazy-connects stdio servers on first use. When no MCP
  // servers are configured (mcpConfigs is empty or absent), this contributes
  // zero tools and the composite is functionally identical to builtin alone.
  // Pool init runs once (pool is module-level); subsequent calls are cheap.
  // Live set: the connector pool is reconciled out-of-band by POST /admin/reload,
  // so each turn reads the CURRENT active configs rather than a boot-frozen array.
  // `deps.mcpConfigs` remains an explicit override for tests.
  const mcpConfigs = deps.mcpConfigs ?? getActiveConfigs();
  if (mcpConfigs.length > 0) {
    // Fire-and-forget the pool warm; list() returns whatever is cached so far.
    // For the first turn the pool warms before the loop starts because we
    // await initMcpPool here (serial with the loop start).
    await initMcpPool(mcpConfigs);
  }
  const mcp = new McpDispatcher(mcpConfigs);
  const dispatcher = mcpConfigs.length > 0 ? new CompositeDispatcher(builtin, mcp) : builtin;
  const registry = new ToolRegistry(dispatcher);

  // Threaded turns: try streaming; fall through to postMessage only if it fails.
  // A replySink turn never streams — streaming requires posting into a thread
  // Sym owns, which is exactly what the sink path lacks (it can't post here).
  if (turn.threadTs !== undefined && deps.replySink === undefined) {
    const streamed = await streamReply(rewrittenTurn, deps, { history, registry, planController });
    if (streamed) return;
  }

  // Non-threaded or stream fallback: run the loop and build the final reply.
  const reply = await runTurnLoop(rewrittenTurn, deps, registry, history);

  const { renderBlocks, fallbackSuffix } = heroRenderParts(reply);
  const body = await finalReplyBody(reply, planController, deps);
  const blocks = [...markdownBlocks(body), ...renderBlocks, receiptToContextBlock(reply.receipt)];
  const fullText = body + fallbackSuffix;

  // Delivery override (slash response_url): hand off instead of posting to a
  // channel Sym may not be a member of. Pass the FULL body — for chat.postMessage
  // `text` is only the notification preview (blocks carry the body, so we clip
  // it), but a response_url sink may need to fall back to text-only delivery,
  // where the text IS the content and must not be truncated. Also hand over a
  // plain-text receipt footer for that text-only tier (the rich tier gets it
  // from the receipt context block already in `blocks`).
  if (deps.replySink !== undefined) {
    const receiptText = receiptToFooterFields(reply.receipt)
      .map((f) => `_${f.label}:_ ${f.value}`)
      .join('  ·  ');
    await deps.replySink({ text: fullText, blocks, receiptText });
    return;
  }

  await deps.slackClient.chatPostMessage({
    channel: turn.channelId,
    text: clipNotif(fullText),
    blocks,
    // Reply in-thread when the turn is already threaded; top-level otherwise.
    ...(turn.threadTs !== undefined ? { thread_ts: turn.threadTs } : {}),
  });
}
