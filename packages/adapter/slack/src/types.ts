import type { SlackChannelId, SlackThreadTs, SlackUserId } from '@sym/contracts';

// ---------------------------------------------------------------------------
// Slack API payload types
// ---------------------------------------------------------------------------

export interface PostMessageParams {
  channel: SlackChannelId;
  text: string;
  /** Block Kit blocks for rich formatting. */
  blocks?: unknown[];
  /** Replies go in-thread when provided. */
  thread_ts?: SlackThreadTs;
}

export interface PostMessageResult {
  ts: SlackThreadTs;
  channel: SlackChannelId;
}

export interface DeleteMessageParams {
  channel: SlackChannelId;
  ts: SlackThreadTs;
}

export interface UpdateMessageParams {
  channel: SlackChannelId;
  ts: SlackThreadTs;
  text: string;
  blocks?: unknown[];
}

export interface ReactionsAddParams {
  channel: SlackChannelId;
  timestamp: SlackThreadTs;
  /** Emoji alias without colons, e.g. `eyes`. */
  name: string;
}

export interface SetStatusParams {
  channelId: SlackChannelId;
  threadTs: SlackThreadTs;
  /** Short status string shown in Slack's assistant loading state. */
  status: string;
  /**
   * Optional set of phrases (≤10) Slack rotates through client-side as the
   * shimmer animates — smoother than a single static line. Use for the
   * open/whimsy phase; omit for a concrete phase ("is reading the thread…").
   */
  loadingMessages?: string[];
}

export interface ConversationsRepliesParams {
  channel: SlackChannelId;
  /** Thread root `ts` (the message that opened the thread). */
  ts: SlackThreadTs;
  /**
   * Hard ceiling on how many messages to fetch across pagination. The impl
   * applies a sensible default; the model-side budget trim lives in the mapper.
   */
  limit?: number;
}

/** A single Slack thread message, normalized to the fields Sym reads. */
export interface SlackThreadMessage {
  /** Author's Slack user id. Absent when the message came from a bot/app. */
  user?: SlackUserId;
  /** Bot id, present when the message came from a bot/app rather than a user. */
  botId?: string;
  text: string;
  ts: SlackThreadTs;
  /** Slack message subtype (e.g. `channel_join`, `bot_message`); absent for plain messages. */
  subtype?: string;
}

export interface ConversationsRepliesResult {
  /** Thread messages oldest-first (root first), as Slack returns them. */
  messages: SlackThreadMessage[];
}

export interface ConversationsHistoryParams {
  channel: SlackChannelId;
  /** Hard ceiling on messages fetched across pagination (impl default applies). */
  limit?: number;
}

export interface ConversationsHistoryResult {
  /** Channel messages oldest-first (chronological), reversed from Slack's newest-first. */
  messages: SlackThreadMessage[];
}

// --- Users / channels listing -----------------------------------------------

export interface UsersInfoParams {
  user: SlackUserId;
}

/** Slack user profile flattened to the fields Sym surfaces. */
export interface SlackUserProfile {
  id: SlackUserId;
  /**
   * Slack's stable `@-handle` for this user (e.g. `amit`). This is what works
   * inside `search.messages` query modifiers — `from:@amit` finds their
   * messages. NOT to be confused with `displayName` which can be anything.
   */
  userName?: string;
  /** Display name as the user has it set in their Slack profile. */
  displayName?: string;
  realName?: string;
  title?: string;
  /** Email — only present when the bot has the `users:read.email` scope. */
  email?: string;
  /** Slack status text (the kebab next to the name). */
  statusText?: string;
  statusEmoji?: string;
  /** IANA tz like `America/Los_Angeles`. */
  tz?: string;
  isBot?: boolean;
  deleted?: boolean;
  /** Slack status text (same as statusText; surfaced on usersList for parity with usersInfo). */
  status?: string;
}

export interface ConversationsListParams {
  /** Page-size cap (Slack's `limit`; impl bounds it). */
  limit?: number;
  /** Comma-separated channel types, e.g. `public_channel,private_channel`. */
  types?: string;
  excludeArchived?: boolean;
}

export interface SlackChannelSummary {
  id: SlackChannelId;
  name?: string;
  isPrivate: boolean;
  /** Channel topic value (purpose is separate; we surface topic). */
  topic?: string;
  memberCount?: number;
}

export interface ConversationsListResult {
  channels: SlackChannelSummary[];
}

export interface UsersListParams {
  /** Page-size cap (Slack's `limit`; impl bounds it and paginates to here). */
  limit?: number;
}

export interface UsersListResult {
  users: SlackUserProfile[];
}

export interface ConversationsInfoParams {
  channel: SlackChannelId;
}

/**
 * Flattened `conversations.info`. The fields Sym needs to turn a DM/MPIM
 * channel id into a human label: `isIm` + the single counterpart `userId`
 * for a 1:1 DM (Slack returns the OTHER party's user id on an `im`).
 */
export interface ConversationsInfoResult {
  id: SlackChannelId;
  isIm: boolean;
  isMpim: boolean;
  /** For an `im`, the other participant's user id. Absent for non-DMs. */
  userId?: SlackUserId;
  /** Channel name for public/private channels (absent for DMs). */
  name?: string;
}

// --- Assistant container (Agents & AI Apps) --------------------------------

export interface SuggestedPrompt {
  /** Label shown on the prompt button. */
  title: string;
  /** Message sent as the user when the prompt is clicked. */
  message: string;
}

export interface SetSuggestedPromptsParams {
  channelId: SlackChannelId;
  threadTs: SlackThreadTs;
  prompts: SuggestedPrompt[];
  /** Optional heading shown above the prompts. */
  title?: string;
}

export interface SetTitleParams {
  channelId: SlackChannelId;
  threadTs: SlackThreadTs;
  title: string;
}

// --- Response streaming (chat.startStream family) --------------------------

export interface StartStreamParams {
  channel: SlackChannelId;
  threadTs: SlackThreadTs;
  /** Required when streaming into a channel (not a DM / assistant thread). */
  recipientUserId?: SlackUserId;
  recipientTeamId?: string;
  /** Optional text to seed the stream with. */
  markdownText?: string;
  /**
   * How Slack renders `task_update` chunks pushed into this stream.
   *  `timeline` — individual task cards rendered sequentially (the default).
   *  `plan`     — all tasks grouped inside a single plan block.
   *  `dense`    — consecutive tool calls collapsed into one summarized card.
   * Per the chat.startStream docs. Omit to use Slack's default (`timeline`).
   */
  taskDisplayMode?: 'timeline' | 'plan' | 'dense';
}

/** Handle to an in-flight stream — pass to append/stop. */
export interface StreamHandle {
  channel: SlackChannelId;
  ts: SlackThreadTs;
}

/** A task-card update chunk (renders as a Slack `task_card` block). */
export interface TaskUpdateChunk {
  type: 'task_update';
  id: string;
  title: string;
  status: 'pending' | 'in_progress' | 'complete' | 'error';
  details?: string;
  output?: string;
  sources?: { type: 'url'; text: string; url: string }[];
}

/** A markdown text chunk (appends to the streamed message body). */
export interface MarkdownTextChunk {
  type: 'markdown_text';
  text: string;
}

/** Any chunk type accepted by `chat.appendStream`'s `chunks` array. */
export type StreamChunk = TaskUpdateChunk | MarkdownTextChunk;

export interface AppendStreamParams {
  channel: SlackChannelId;
  ts: SlackThreadTs;
  /**
   * Convenience field — converted to a `markdown_text` chunk internally so we
   * never mix the top-level `markdown_text` parameter with the `chunks` array
   * in the same stream (Slack silently drops markdown body when the two are
   * interleaved).
   */
  markdownText?: string;
  /** Structured chunks (task_update / markdown_text) to push into the stream. */
  chunks?: StreamChunk[];
}

export interface StopStreamParams {
  channel: SlackChannelId;
  ts: SlackThreadTs;
  /** Block Kit rendered at the bottom once the stream finalizes (e.g. receipt). */
  blocks?: unknown[];
}

// --- users.profile.set (user-token, act-as-owner) --------------------------

export interface UsersProfileSetParams {
  /** Slack status text. Empty string clears the status. */
  statusText: string;
  /** Optional `:emoji:` shortcode (with surrounding colons, Slack convention). */
  statusEmoji?: string;
  /** Optional unix-seconds expiration; 0 (or omitted) means no expiration. */
  statusExpiration?: number;
}

// --- reminders.add (user-token, set on owner's behalf) ---------------------

export interface RemindersAddParams {
  /** What the reminder will say. */
  text: string;
  /**
   * Either a natural-language time string ("in 10 minutes", "tomorrow at 9am",
   * "next Tuesday at 3pm") or an absolute unix-seconds timestamp.
   */
  time: string | number;
}

export interface RemindersAddResult {
  /** Slack reminder id; useful for cancelling later. */
  id: string;
  text: string;
  /** Resolved trigger time (unix seconds), if Slack returned one. */
  time?: number;
}

// --- auth.test --------------------------------------------------------------

export interface AuthTestResult {
  /** The user_id the token is currently acting as. */
  userId: SlackUserId;
  /** The team_id the token belongs to. */
  teamId: string;
  /** Human-readable username (bots: app name; users: their Slack handle). */
  user?: string;
  /** True when the token is a bot token (`xoxb-…`). */
  isBot?: boolean;
}

// --- search.messages (user-token only) -------------------------------------

export interface SearchMessagesParams {
  /** Slack-style query string, e.g. `from:@amit pricing in:#general`. */
  query: string;
  sort?: 'score' | 'timestamp';
  sortDir?: 'asc' | 'desc';
  /** Results per page (default 20, max 100). */
  count?: number;
  page?: number;
}

export interface SearchMessageMatch {
  channelId: SlackChannelId;
  channelName?: string;
  username?: string;
  userId?: SlackUserId;
  ts: SlackThreadTs;
  text: string;
  permalink?: string;
}

export interface SearchMessagesResult {
  matches: SearchMessageMatch[];
  /** Total matches across all pages. */
  total: number;
}
