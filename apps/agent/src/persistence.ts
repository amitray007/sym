/**
 * Turn persistence — records each Slack turn into `conversations` + `messages`
 * and loads prior thread history back for context.
 *
 * The conversation row's PK is the deterministic conversation key
 * (`workspaceId:channelId[:threadTs]`, i.e. `turn.conversationId`), so creating
 * it is a race-safe `onConflictDoNothing` upsert and the persisted id matches
 * the id the kernel already stamps on receipts.
 *
 * `content_json` shape (per D-DB-8 the table stores what Sym "sees"):
 *   - user      → `{ text }`
 *   - assistant → `{ markdown, blocks }` (Block Kit for the Dashboard; markdown
 *                  is the plain text reused as history content)
 *
 * All writes here are best-effort from the caller's perspective: handle-turn
 * wraps them so a DB hiccup degrades memory but never blocks the reply.
 */

import { conversations, messages } from '@sym/db';
import { desc, eq } from 'drizzle-orm';

import type { ChatMessage, Turn } from '@sym/contracts';
import type { Database } from '@sym/db';

/** How many prior messages of the thread to feed back to the model. */
export const HISTORY_LIMIT = 20;

/** Create the conversation row if it doesn't exist yet (idempotent by PK). */
export async function ensureConversation(db: Database, turn: Turn): Promise<void> {
  await db
    .insert(conversations)
    .values({
      id: turn.conversationId,
      workspaceId: turn.workspaceId,
      entrySurface: turn.entrySurface,
      slackChannelId: turn.channelId ?? null,
      slackThreadTs: turn.threadTs ?? null,
      initiatorSlackUserId: turn.requester,
    })
    .onConflictDoNothing();
}

/** Load the most recent thread messages (chronological) as kernel ChatMessages. */
export async function loadHistory(db: Database, conversationId: string): Promise<ChatMessage[]> {
  const rows = await db
    .select({ role: messages.role, contentJson: messages.contentJson })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.createdAt))
    .limit(HISTORY_LIMIT);

  return rows.reverse().map((r) => ({ role: r.role, content: contentText(r.contentJson) }));
}

/** Record the inbound user message + bump the conversation's last-turn time. */
export async function recordUserMessage(db: Database, turn: Turn): Promise<void> {
  await db.insert(messages).values({
    workspaceId: turn.workspaceId,
    conversationId: turn.conversationId,
    role: 'user',
    authorSlackUserId: turn.requester,
    contentJson: { text: turn.text },
  });
  await touch(db, turn.conversationId);
}

export interface AssistantMessage {
  workspaceId: string;
  conversationId: string;
  markdown: string;
  blocks: unknown[];
  slackTs?: string;
}

/** Record the outbound assistant reply (Block Kit + markdown) + bump the conversation. */
export async function recordAssistantMessage(db: Database, msg: AssistantMessage): Promise<void> {
  await db.insert(messages).values({
    workspaceId: msg.workspaceId,
    conversationId: msg.conversationId,
    role: 'assistant',
    contentJson: { markdown: msg.markdown, blocks: msg.blocks },
    ...(msg.slackTs !== undefined ? { slackTs: msg.slackTs } : {}),
  });
  await touch(db, msg.conversationId);
}

async function touch(db: Database, conversationId: string): Promise<void> {
  await db
    .update(conversations)
    .set({ lastTurnAt: new Date() })
    .where(eq(conversations.id, conversationId));
}

/** Pull display text out of a stored `content_json` ({markdown} or {text}). */
function contentText(json: unknown): string {
  if (json && typeof json === 'object') {
    const o = json as Record<string, unknown>;
    if (typeof o['markdown'] === 'string') return o['markdown'];
    if (typeof o['text'] === 'string') return o['text'];
  }
  return '';
}
