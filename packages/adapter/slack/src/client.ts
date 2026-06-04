// Re-export all param/result types so existing barrel consumers keep working.
export * from './types.js';

// Re-export the SlackApiError interface from retry.ts (public surface).
export type { SlackApiError } from './retry.js';

import type {
  AppendStreamParams,
  AuthTestResult,
  ConversationsHistoryParams,
  ConversationsHistoryResult,
  ConversationsInfoParams,
  ConversationsInfoResult,
  ConversationsListParams,
  ConversationsListResult,
  ConversationsRepliesParams,
  ConversationsRepliesResult,
  DeleteMessageParams,
  PostMessageParams,
  PostMessageResult,
  ReactionsAddParams,
  RemindersAddParams,
  RemindersAddResult,
  SearchMessagesParams,
  SearchMessagesResult,
  SetStatusParams,
  SetSuggestedPromptsParams,
  SetTitleParams,
  SlackUserProfile,
  StartStreamParams,
  StopStreamParams,
  StreamHandle,
  UpdateMessageParams,
  UsersInfoParams,
  UsersListParams,
  UsersListResult,
  UsersProfileSetParams,
} from './types.js';

/**
 * Abstraction over the Slack Web API calls `@sym/adapter-slack` needs.
 * The concrete implementation lives in `web-api-client.ts`.
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
  /**
   * Bulk-list workspace members (`users.list`, paginated). Used to warm the
   * name cache at boot so `<@U…>` ids resolve to names without a per-id
   * `users.info` round-trip. Requires `users:read`.
   */
  usersList(params: UsersListParams): Promise<UsersListResult>;
  /** List channels the bot can see (requires `channels:read` / `groups:read`). */
  conversationsList(params: ConversationsListParams): Promise<ConversationsListResult>;
  /**
   * Fetch one conversation's metadata (`conversations.info`). Sym uses it to
   * resolve a DM channel id (`D…`) to its counterpart user. Requires the
   * matching read scope for the conversation type.
   */
  conversationsInfo(params: ConversationsInfoParams): Promise<ConversationsInfoResult>;
  /**
   * Verify the token is valid and discover the identity it's acting as.
   * Cheap; usable as a startup health check.
   */
  authTest(): Promise<AuthTestResult>;
  /**
   * Full Slack workspace search (`search.messages`). User-token only — bot
   * tokens lack the `search:read` scope (Slack does not support it for bots).
   * For agents, call via the owner's user token.
   */
  searchMessages(params: SearchMessagesParams): Promise<SearchMessagesResult>;
  /**
   * Update the calling user's Slack profile status (`users.profile.set`).
   * Acts as whoever owns the token — when called with the user token, sets
   * the owner's status. Requires `users.profile:write` (user scope).
   */
  usersProfileSet(params: UsersProfileSetParams): Promise<void>;
  /**
   * Create a Slack reminder for the calling user (`reminders.add`). Requires
   * `reminders:write` (user scope).
   */
  remindersAdd(params: RemindersAddParams): Promise<RemindersAddResult>;
}
