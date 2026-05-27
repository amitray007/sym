import type { SlackActionError, SlackChannelId, SlackThreadTs, SlackUserId } from '@sym/contracts';

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
   *  `task` — individual task cards (one block per step)
   *  `plan` — grouped plan block (steps shown as a checklist inside one block)
   * Default if omitted: Slack picks. We set this explicitly to lock the
   * rendering we want.
   */
  taskDisplayMode?: 'task' | 'plan';
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

// ---------------------------------------------------------------------------
// SlackClient interface
// ---------------------------------------------------------------------------

/**
 * Abstraction over the Slack Web API calls `@sym/adapter-slack` needs.
 * Implemented by `apps/agent` using a real Slack SDK client.
 * Tests inject a mock.
 */
export interface SlackClient {
  chatPostMessage(params: PostMessageParams): Promise<PostMessageResult>;
  chatUpdate(params: UpdateMessageParams): Promise<void>;
  chatDelete(params: DeleteMessageParams): Promise<void>;
  reactionsAdd(params: ReactionsAddParams): Promise<void>;
  assistantThreadsSetStatus(params: SetStatusParams): Promise<void>;
  /** Read a thread (root + replies), oldest-first, for in-thread context. */
  conversationsReplies(params: ConversationsRepliesParams): Promise<ConversationsRepliesResult>;
  /** Read a channel's recent messages (oldest-first) for viewed-channel context. */
  conversationsHistory(params: ConversationsHistoryParams): Promise<ConversationsHistoryResult>;
  /** Set the assistant thread's suggested prompts (shown when the panel opens). */
  assistantThreadsSetSuggestedPrompts(params: SetSuggestedPromptsParams): Promise<void>;
  /** Set the assistant thread's title. */
  assistantThreadsSetTitle(params: SetTitleParams): Promise<void>;
  /** Begin a streamed reply; returns a handle for append/stop. */
  chatStartStream(params: StartStreamParams): Promise<StreamHandle>;
  /** Append a markdown chunk to an in-flight stream. */
  chatAppendStream(params: AppendStreamParams): Promise<void>;
  /** Finalize a stream, optionally adding Block Kit at the bottom. */
  chatStopStream(params: StopStreamParams): Promise<void>;
  /** Fetch a user's profile (requires `users:read`; email needs `users:read.email`). */
  usersInfo(params: UsersInfoParams): Promise<SlackUserProfile>;
  /** List channels the bot can see (requires `channels:read` / `groups:read`). */
  conversationsList(params: ConversationsListParams): Promise<ConversationsListResult>;
}

// ---------------------------------------------------------------------------
// Retry mechanics
// ---------------------------------------------------------------------------

/** Error shape thrown when Slack returns a non-ok response. */
export interface SlackApiError extends Error {
  code: string;
  /** Raw Slack API error string (e.g. `too_many_requests`). */
  data?: { error?: string; retry_after?: number };
}

function isSlackApiError(e: unknown): e is SlackApiError {
  return e instanceof Error && 'code' in e;
}

/**
 * A terminal Slack failure as a real `Error` that also carries the structured
 * `SlackActionError` fields. Being an `Error` keeps `instanceof Error` + `.message`
 * working for callers that log it; the fields are there for structured handling.
 */
class SlackError extends Error implements SlackActionError {
  readonly domain = 'slack';
  readonly code: SlackActionError['code'];
  readonly retryable: boolean;
  constructor(
    code: SlackActionError['code'],
    message: string,
    retryable: boolean,
    cause?: unknown,
  ) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'SlackError';
    this.code = code;
    this.retryable = retryable;
  }
}

/**
 * Wraps a Slack API call with exponential backoff on 429 rate-limits.
 * Non-rate-limit errors surface immediately as `SlackActionError`.
 *
 * @param fn         The async Slack API call to wrap.
 * @param maxRetries Maximum number of retry attempts (default 3).
 */
export async function withSlackRetries<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  let attempt = 0;
  let delay = 1_000; // ms

  while (attempt <= maxRetries) {
    try {
      return await fn();
    } catch (err: unknown) {
      if (isSlackApiError(err)) {
        const slackError = err.data?.error ?? err.code;

        // Rate limited — respect Retry-After or back off exponentially.
        if (slackError === 'too_many_requests' || slackError === 'ratelimited') {
          if (attempt === maxRetries) {
            throw mapSlackError(err);
          }
          const retryAfterMs = (err.data?.retry_after ?? 0) * 1000 || delay;
          await sleep(Math.max(retryAfterMs, delay));
          delay = Math.min(delay * 2, 30_000);
          attempt++;
          continue;
        }

        // Idempotent success cases.
        if (slackError === 'already_reacted' || slackError === 'no_reaction') {
          return undefined as unknown as T;
        }

        // Any other Slack error is a terminal failure.
        throw mapSlackError(err);
      }

      // Non-Slack errors propagate as-is.
      throw err;
    }
  }

  /* istanbul ignore next — unreachable after exhausting retries */
  throw new SlackError('rate_limited', 'Exceeded retry budget', true);
}

/** Convert a raw Slack API error into a typed `SlackActionError`. */
export function mapSlackError(err: SlackApiError): SlackActionError {
  const slackError = err.data?.error ?? err.code;

  const codeMap: Record<string, SlackActionError['code']> = {
    too_many_requests: 'rate_limited',
    ratelimited: 'rate_limited',
    not_authed: 'not_authed',
    invalid_auth: 'not_authed',
    channel_not_found: 'channel_not_found',
    invalid_blocks: 'invalid_input',
    no_text: 'invalid_input',
  };

  const code: SlackActionError['code'] = codeMap[slackError] ?? 'api_error';

  return new SlackError(code, slackError ?? err.message, code === 'rate_limited', err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
