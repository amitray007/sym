import type {
  ConversationId,
  SlackChannelId,
  SlackEntrySurface,
  SlackEventId,
  SlackThreadTs,
  SlackTurnInput,
  SlackUserId,
  Turn,
  TurnId,
  WorkspaceId,
} from '@sym/contracts';

// ---------------------------------------------------------------------------
// Raw Slack payload shapes (minimal — only what we read)
// ---------------------------------------------------------------------------

/** The `assistant_thread` object on assistant_thread_started/context_changed. */
interface SlackAssistantThread {
  user_id?: string;
  /** The DM-style channel the assistant container lives in. */
  channel_id: string;
  thread_ts: string;
  /** Where the user currently is in Slack (the channel they're viewing). */
  context?: {
    channel_id?: string;
    team_id?: string;
    enterprise_id?: string;
  };
}

interface SlackEventPayload {
  type: string;
  channel_type?: string;
  ts: string;
  user?: string;
  channel: string;
  thread_ts?: string;
  text: string;
  /** Set when the message was posted by a bot/app (incl. Sym itself). */
  bot_id?: string;
  /** Slack message subtype (e.g. `bot_message`, `message_changed`); absent for plain user messages. */
  subtype?: string;
  /** Present on assistant_thread_started / assistant_thread_context_changed. */
  assistant_thread?: SlackAssistantThread;
}

export interface RawSlackEvent {
  type: string;
  event_id?: string;
  team_id?: string;
  trigger_id?: string;
  callback_id?: string;
  command?: string;
  user_id?: string;
  channel_id?: string;
  text?: string;
  /** Present for event_callback payloads. */
  event?: SlackEventPayload;
  /** Present for shortcut / message_action. */
  user?: { id: string; team_id?: string };
  /** Present for shortcut. */
  message?: {
    ts: string;
    text: string;
    channel?: string;
    thread_ts?: string;
  };
  team?: { id: string; domain?: string };
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

export interface NormalizeOpts {
  event: RawSlackEvent;
  workspaceId: WorkspaceId;
  botUserId: SlackUserId;
}

/** Strip a leading `<@UXXXXXX>` mention (the bot's user ID) from text. */
function stripMention(text: string): string {
  return text.replace(/^<@[A-Z0-9]+>\s*/u, '').trim();
}

/**
 * Build an optional `threadTs` field compatible with `exactOptionalPropertyTypes`.
 * When the raw value is undefined, we return an empty object so the property
 * is absent (not set to `undefined`) on the resulting `SlackTurnInput`.
 */
function optionalThreadTs(
  raw: string | undefined,
): { threadTs: SlackThreadTs } | Record<never, never> {
  return raw !== undefined ? { threadTs: raw as SlackThreadTs } : {};
}

/**
 * Convert a raw Slack event payload into a `SlackTurnInput`.
 * Returns `null` for payloads we do not act on (e.g. `reaction_added`).
 */
export function normalizeSlackEvent(opts: NormalizeOpts): SlackTurnInput | null {
  const { event: raw, workspaceId, botUserId } = opts;

  // --- event_callback: app_mention or DM message ---
  if (raw.type === 'event_callback' && raw.event) {
    const e = raw.event;
    const eventId = (raw.event_id ?? '') as SlackEventId;

    if (e.type === 'app_mention') {
      return {
        workspaceId,
        eventId,
        entrySurface: 'app_mention',
        requester: (e.user ?? '') as SlackUserId,
        channelId: e.channel as SlackChannelId,
        ts: e.ts as SlackThreadTs,
        text: stripMention(e.text),
        ...optionalThreadTs(e.thread_ts),
      };
    }

    if (e.type === 'message' && e.channel_type === 'im') {
      // Ignore the bot's OWN messages (and Slack edit/delete subtypes). Without
      // this, Sym's posted/streamed reply re-enters as a new message.im event and
      // it replies to itself forever (the event_id dedup can't catch it — each
      // echo is a distinct event). Canonical Slack rule: skip your own bot events.
      if (e.bot_id !== undefined || e.subtype !== undefined) return null;
      if (e.user === undefined || e.user === botUserId) return null;
      return {
        workspaceId,
        eventId,
        entrySurface: 'dm',
        requester: e.user as SlackUserId,
        channelId: e.channel as SlackChannelId,
        ts: e.ts as SlackThreadTs,
        text: e.text,
        ...optionalThreadTs(e.thread_ts),
      };
    }

    // Unhandled event sub-type inside event_callback
    return null;
  }

  // --- Shortcut (message_action) ---
  if (raw.type === 'shortcut' || raw.type === 'message_action') {
    const msg = raw.message;
    if (!msg || !raw.user) return null;
    return {
      workspaceId,
      eventId: (raw.callback_id ?? raw.trigger_id ?? '') as SlackEventId,
      entrySurface: 'shortcut',
      requester: raw.user.id as SlackUserId,
      channelId: (msg.channel ?? '') as SlackChannelId,
      ts: msg.ts as SlackThreadTs,
      text: msg.text,
      ...optionalThreadTs(msg.thread_ts),
    };
  }

  // --- Slash command (no message ts; SlackTurnInput.ts is optional) ---
  if (raw.type === 'slash_command' && raw.command !== undefined) {
    if (!raw.user_id || !raw.channel_id) return null;
    return {
      workspaceId,
      eventId: (raw.trigger_id ?? '') as SlackEventId,
      entrySurface: 'slash_command',
      requester: raw.user_id as SlackUserId,
      channelId: raw.channel_id as SlackChannelId,
      text: raw.text ?? '',
      // no ts (slash commands have none) and no threadTs (always top-level)
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// SlackTurnInput → Turn
// ---------------------------------------------------------------------------

/**
 * The thread Sym replies in. A channel `app_mention` ALWAYS gets a thread —
 * rooted at the triggering message's `ts` when it isn't already threaded — so
 * Sym never answers at channel level. DMs stay flat (the conversation is the im
 * channel itself), which also keeps DM memory keyed per-channel, not per-message.
 */
function effectiveThreadTs(input: SlackTurnInput): SlackThreadTs | undefined {
  if (input.threadTs !== undefined) return input.threadTs;
  if (input.entrySurface === 'app_mention') return input.ts;
  return undefined;
}

/**
 * Derive a stable `conversationId` from workspace + channel (+ effective thread).
 * Uses {@link effectiveThreadTs} so a top-level mention and its threaded replies
 * resolve to the SAME conversation (the thread Sym opened). Best-effort
 * client-side key.
 */
function deriveConversationId(input: SlackTurnInput): ConversationId {
  const base = `${input.workspaceId}:${input.channelId}`;
  const thread = effectiveThreadTs(input);
  const key = thread ? `${base}:${thread}` : base;
  return key as ConversationId;
}

/** Generates a UUID v4 string for use as a TurnId. */
function generateTurnId(): TurnId {
  // Node 24 has crypto.randomUUID() globally.
  return crypto.randomUUID() as TurnId;
}

/**
 * Converts a `SlackTurnInput` (adapter-domain) into a `Turn` (kernel-domain).
 * The agent processes the resulting Turn.
 */
export function slackTurnInputToTurn(input: SlackTurnInput): Turn {
  const thread = effectiveThreadTs(input);
  return {
    id: generateTurnId(),
    workspaceId: input.workspaceId,
    conversationId: deriveConversationId(input),
    entrySurface: input.entrySurface as SlackEntrySurface,
    requester: input.requester,
    channelId: input.channelId,
    text: input.text,
    receivedAt: new Date(),
    ...(thread !== undefined ? { threadTs: thread } : {}),
    ...(input.ts !== undefined ? { ts: input.ts } : {}),
  };
}

// ---------------------------------------------------------------------------
// Assistant container lifecycle events (Agents & AI Apps)
// ---------------------------------------------------------------------------

/**
 * Shared shape for both `assistant_thread_started` and
 * `assistant_thread_context_changed` lifecycle events — both carry the same
 * assistant-thread identity and optional viewed-channel context.
 */
export interface AssistantThreadStarted {
  channelId: SlackChannelId;
  threadTs: SlackThreadTs;
  /** The channel the user was viewing when they opened/navigated the panel, if any. */
  contextChannelId?: SlackChannelId;
}

/**
 * Extract the assistant thread from an `assistant_thread_started` event.
 * Returns `null` for any other event — this is a lifecycle signal, not a Turn.
 */
export function assistantThreadStarted(raw: RawSlackEvent): AssistantThreadStarted | null {
  if (raw.type !== 'event_callback' || raw.event?.type !== 'assistant_thread_started') return null;
  const at = raw.event.assistant_thread;
  if (!at) return null;
  const ctxChannel = at.context?.channel_id;
  return {
    channelId: at.channel_id as SlackChannelId,
    threadTs: at.thread_ts as SlackThreadTs,
    ...(ctxChannel !== undefined ? { contextChannelId: ctxChannel as SlackChannelId } : {}),
  };
}

/**
 * Extract the assistant thread from an `assistant_thread_context_changed` event.
 * Returns `null` for any other event — this is a lifecycle signal, not a Turn.
 * Reuses the `AssistantThreadStarted` interface — both lifecycle events share the same shape.
 */
export function assistantThreadContextChanged(raw: RawSlackEvent): AssistantThreadStarted | null {
  if (raw.type !== 'event_callback' || raw.event?.type !== 'assistant_thread_context_changed')
    return null;
  const at = raw.event.assistant_thread;
  if (!at) return null;
  const ctxChannel = at.context?.channel_id;
  return {
    channelId: at.channel_id as SlackChannelId,
    threadTs: at.thread_ts as SlackThreadTs,
    ...(ctxChannel !== undefined ? { contextChannelId: ctxChannel as SlackChannelId } : {}),
  };
}
