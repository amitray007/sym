import type {
  ConversationId,
  SlackChannelId,
  SlackThreadTs,
  SlackUserId,
  TurnId,
  WorkspaceId,
} from './ids.js';
import type { Usage } from './provider.js';
import type { SlackEntrySurface, SlackTurnInput } from './slack.js';

/** What woke the kernel. v1 surfaces are Slack-driven plus internal tasks. */
export type Event =
  | { kind: 'slack'; input: SlackTurnInput }
  | { kind: 'task'; taskKind: string; payload: unknown }
  | { kind: 'resume'; conversationId: ConversationId; sliceId: string };

/**
 * The unit the kernel processes. Assembled from an `Event` (+ ACL + soul).
 * One Turn produces at most one user-visible `Reply`.
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

/** A persisted conversation row. Mirrors the `messages` table. */
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

export interface Message {
  conversationId: ConversationId;
  role: MessageRole;
  /** Block Kit JSON / text / tool call / tool result. */
  content: unknown;
  authorId?: SlackUserId;
  slackTs?: SlackThreadTs;
  createdAt: Date;
}

/**
 * Structured provenance of a reply — rendered into the Slack receipt footer
 * and the Dashboard activity feed. Produced by the kernel (S2), formatted by
 * the adapter (S1) and audit (S7b).
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
  /** Slack-flavored markdown (rendered to a `markdown` block by S1). */
  markdown: string;
  receipt: Receipt;
}
