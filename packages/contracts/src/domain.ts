import type {
  ConversationId,
  SlackChannelId,
  SlackThreadTs,
  SlackUserId,
  TurnId,
  WorkspaceId,
} from './ids.js';
import type { Usage } from './provider.js';
import type { RenderIntent } from './render.js';
import type { SlackEntrySurface } from './slack.js';

/**
 * The unit the kernel processes. One Turn produces at most one user-visible `Reply`.
 */
export interface Turn {
  id: TurnId;
  workspaceId: WorkspaceId;
  conversationId: ConversationId;
  entrySurface: SlackEntrySurface | 'task';
  requester: SlackUserId;
  channelId?: SlackChannelId;
  threadTs?: SlackThreadTs;
  /** Slack `ts` of the triggering message (absent for slash commands / tasks). */
  ts?: SlackThreadTs;
  text: string;
  receivedAt: Date;
}

/**
 * Structured provenance of a reply — rendered into the Slack receipt footer
 * by the adapter.
 */
export interface Receipt {
  turnId: TurnId;
  model: string;
  usage?: Usage;
  durationMs?: number;
  toolsInvoked: string[];
  /** Set when the turn acted through a cross-user grant. */
  onBehalfOf?: SlackUserId;
}

/** The kernel's output for a turn. */
export interface Reply {
  turnId: TurnId;
  /** Slack-flavored markdown (rendered to a `markdown` block by the adapter). */
  markdown: string;
  receipt: Receipt;
  /**
   * Render intents collected from tool results during the turn. The adapter
   * renders the LAST one as the turn's single "hero" surface beneath the
   * markdown body. Absent when no tool attached a render.
   */
  renders?: RenderIntent[];
}
