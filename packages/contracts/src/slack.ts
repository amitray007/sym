import type {
  SlackChannelId,
  SlackEventId,
  SlackThreadTs,
  SlackUserId,
  WorkspaceId,
} from './ids.js';

/**
 * Where a turn entered from. Mirrors `conversations.entry_surface` minus
 * `task` (tasks are kernel-internal, not a Slack entry point).
 */
export type SlackEntrySurface = 'app_mention' | 'dm' | 'shortcut' | 'slash_command';

/**
 * A normalized inbound Slack signal produced by the adapter after
 * signature verification + dedup. The agent turns this into a `Turn`.
 */
export interface SlackTurnInput {
  workspaceId: WorkspaceId;
  eventId: SlackEventId;
  entrySurface: SlackEntrySurface;
  requester: SlackUserId;
  channelId: SlackChannelId;
  /** Present for threaded messages; absent for top-level / first DM message. */
  threadTs?: SlackThreadTs;
  /** Plain text of the triggering message (mentions stripped by the adapter). */
  text: string;
  /** Slack `ts` of the triggering message; absent for slash commands (no message ts). */
  ts?: SlackThreadTs;
}

/** A diagnostic footer rendered as a Slack `context` block (outbound contract §3). */
export interface ReceiptFooterField {
  label: string;
  value: string;
}
