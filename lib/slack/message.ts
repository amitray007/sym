import type { SlackApi } from "./api.ts";

// One Slack message read back by its channel and timestamp, for the reaction trigger and the
// Send to Sym shortcut (decision 088). Its text includes what a forwarded message carries: Slack
// leaves a forward's own text empty and puts the original in an attachment.

export interface FoundMessage {
  text: string;
  user?: string | undefined;
  botId?: string | undefined;
  threadTs: string;
}

interface RawAttachment {
  text?: string;
  fallback?: string;
  author_id?: string;
  author_name?: string;
  is_share?: boolean;
  is_msg_unfurl?: boolean;
}

export interface RawMessage {
  ts?: string;
  text?: string;
  user?: string;
  bot_id?: string;
  thread_ts?: string;
  attachments?: RawAttachment[];
  files?: { name?: string; title?: string }[];
}

// The message: a top-level message from the channel history, else a reply found in its thread.
// Undefined when Slack refuses, such as in a channel Sym has not joined. Never throws.
export async function findMessage(
  slack: SlackApi,
  channel: string,
  ts: string,
): Promise<FoundMessage | undefined> {
  const pick = (messages: unknown): RawMessage | undefined =>
    Array.isArray(messages) ? (messages as RawMessage[]).find((m) => m.ts === ts) : undefined;
  try {
    // Only the one message lies between `oldest` and `latest`.
    const history = await slack.call("conversations.history", {
      channel,
      latest: ts,
      oldest: ts,
      inclusive: true,
    });
    let found = pick(history.messages);
    if (!found) {
      // A reply: its thread from the root up to the reply.
      const replies = await slack.call("conversations.replies", {
        channel,
        ts,
        latest: ts,
        inclusive: true,
        limit: 1000,
      });
      found = pick(replies.messages);
    }
    if (!found) return undefined;
    return {
      text: messageText(found),
      user: found.user,
      botId: found.bot_id,
      threadTs: found.thread_ts ?? ts,
    };
  } catch {
    return undefined;
  }
}

// The readable text of a message: its own text, then each forwarded or quoted message, then file
// names. A link preview counts only when the message has no text of its own.
export function messageText(message: RawMessage): string {
  const own = message.text?.trim() ?? "";
  const parts = own ? [own] : [];
  for (const attachment of message.attachments ?? []) {
    const shared = attachment.is_share === true || attachment.is_msg_unfurl === true;
    if (!shared && own) continue;
    const body = (attachment.text || attachment.fallback || "").trim();
    if (!body) continue;
    const from = attachment.author_id
      ? `<@${attachment.author_id}>`
      : attachment.author_name?.trim();
    parts.push(shared ? `Forwarded${from ? ` from ${from}` : ""}: ${body}` : body);
  }
  for (const file of message.files ?? []) {
    const name = (file.title || file.name || "").trim();
    if (name) parts.push(`File: ${name}`);
  }
  return parts.join("\n");
}
