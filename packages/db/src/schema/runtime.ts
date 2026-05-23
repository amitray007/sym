import { bigint, index, jsonb, pgEnum, pgTable, text } from 'drizzle-orm/pg-core';

import { uuidv7 } from '../uuid.js';
import { createdAt, tstz } from './_shared.js';
import { auditEvents } from './audit.js';
import { workspaces } from './workspaces.js';

export const conversationEntrySurfaceEnum = pgEnum('conversation_entry_surface', [
  'app_mention',
  'dm',
  'shortcut',
  'slash_command',
  'task',
]);

export const conversationStatusEnum = pgEnum('conversation_status', ['active', 'closed']);

export const messageRoleEnum = pgEnum('message_role', ['user', 'assistant', 'system', 'tool']);

/**
 * A Slack conversation thread (or DM) Sym participates in. DMs are modeled
 * per `im` channel and never auto-close (D-DB-4) — Slack threads are the
 * natural conversation boundary; DMs aren't "sessions".
 */
export const conversations = pgTable(
  'conversations',
  {
    id: text('id').primaryKey().$defaultFn(uuidv7),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    entrySurface: conversationEntrySurfaceEnum('entry_surface').notNull(),
    slackChannelId: text('slack_channel_id'),
    slackThreadTs: text('slack_thread_ts'),
    initiatorSlackUserId: text('initiator_slack_user_id').notNull(),
    status: conversationStatusEnum('status').notNull().default('active'),
    startedAt: createdAt(),
    lastTurnAt: tstz('last_turn_at').notNull().defaultNow(),
  },
  (t) => [
    index('conversations_channel_thread').on(t.workspaceId, t.slackChannelId, t.slackThreadTs),
  ],
);

/**
 * A turn within a conversation: one row per inbound user message, outbound
 * assistant reply, or persisted tool call/result. `content_json` holds full
 * Block Kit JSON for outbound replies (D-DB-8) so the Dashboard can render
 * "the conversation as Sym sees it" without joining audit. Full tool I/O
 * lives in audit; this stays terse.
 */
export const messages = pgTable(
  'messages',
  {
    id: text('id').primaryKey().$defaultFn(uuidv7),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    role: messageRoleEnum('role').notNull(),
    authorSlackUserId: text('author_slack_user_id'),
    contentJson: jsonb('content_json').notNull(),
    slackTs: text('slack_ts'),
    createdAt: createdAt(),
    auditEventId: bigint('audit_event_id', { mode: 'number' }).references(() => auditEvents.id),
  },
  (t) => [index('messages_conversation_created').on(t.conversationId, t.createdAt)],
);
