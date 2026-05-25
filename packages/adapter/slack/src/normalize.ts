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

interface SlackEventPayload {
  type: string;
  channel_type?: string;
  ts: string;
  user?: string;
  channel: string;
  thread_ts?: string;
  text: string;
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
  const { event: raw, workspaceId } = opts;

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
      return {
        workspaceId,
        eventId,
        entrySurface: 'dm',
        requester: (e.user ?? '') as SlackUserId,
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
 * client-side key; `@sym/kernel` (S2) may canonicalize it against DB state.
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
 * The kernel (S2) should validate and persist the resulting Turn.
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
  };
}
