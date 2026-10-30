import type { Job } from "../ledger/jobs.ts";
import type { SlackApi } from "./api.ts";

// The Slack thread a job came from (decision 075). The brief carries Sym's summary of the
// request; the worker reads the thread itself when the summary leaves out a detail, and gets the
// thread's images with its first message. This module runs inside steps a workflow body reaches,
// so it imports no Node.js builtins.

// T3 takes at most 8 attachments per message and 10 MB per image.
export const MAX_IMAGES = 8;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
// The thread text the worker can read in one call.
const MAX_MESSAGES = 100;
const MAX_TEXT = 4000;

export interface SourceThread {
  channel: string;
  ts: string;
}

export interface ThreadFile {
  name: string;
  mimeType: string;
  size: number;
  url: string;
}

export interface ThreadMessage {
  ts: string;
  author: string;
  bot: boolean;
  text: string;
  files: ThreadFile[];
}

export interface ThreadImage {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}

// The thread the request came from. A job moved into a code channel keeps its origin thread.
export function sourceOf(
  job: Pick<Job, "slackChannel" | "slackThreadTs" | "originChannel" | "originThreadTs">,
): SourceThread | undefined {
  if (job.originChannel && job.originThreadTs) {
    return { channel: job.originChannel, ts: job.originThreadTs };
  }
  if (job.slackChannel && job.slackThreadTs) {
    return { channel: job.slackChannel, ts: job.slackThreadTs };
  }
  return undefined;
}

export async function threadLink(slack: SlackApi, source: SourceThread) {
  const result = await slack.call("chat.getPermalink", {
    channel: source.channel,
    message_ts: source.ts,
  });
  return typeof result.permalink === "string" ? result.permalink : undefined;
}

export async function readThread(slack: SlackApi, source: SourceThread): Promise<ThreadMessage[]> {
  const result = await slack.call("conversations.replies", {
    channel: source.channel,
    ts: source.ts,
    limit: MAX_MESSAGES,
  });
  const messages = Array.isArray(result.messages) ? result.messages : [];
  return messages.slice(0, MAX_MESSAGES).map((raw) => toMessage(raw as Record<string, unknown>));
}

// The images people posted in the thread, oldest first. Sym's own posts and other bots' posts
// are left out. A file that fails to download is skipped, so the job still starts.
export async function threadImages(
  slack: SlackApi,
  messages: ThreadMessage[],
): Promise<ThreadImage[]> {
  if (!slack.download) return [];
  const wanted = messages
    .filter((message) => !message.bot)
    .flatMap((message) => message.files)
    .filter((file) => IMAGE_TYPES.has(file.mimeType) && file.size <= MAX_IMAGE_BYTES)
    .slice(0, MAX_IMAGES);
  const images: ThreadImage[] = [];
  for (const file of wanted) {
    try {
      const bytes = await slack.download(file.url, MAX_IMAGE_BYTES);
      if (bytes.byteLength > 0) images.push({ name: file.name, mimeType: file.mimeType, bytes });
    } catch {
      // The message stays generic: a file URL is private to the workspace.
      console.warn("Sym skipped a thread image it could not download.");
    }
  }
  return images;
}

// The thread as plain text for the worker. Every line is data from Slack, not instructions.
export function threadText(messages: ThreadMessage[]): string {
  if (messages.length === 0) return "The thread has no messages Sym can read.";
  return messages
    .map((message) => {
      const who = `${message.bot ? "bot" : "user"} ${message.author}`;
      const files = message.files.map((file) => `[file: ${file.name}, ${file.mimeType}]`);
      return [`[${message.ts}] ${who}:`, cut(message.text), ...files].filter(Boolean).join("\n");
    })
    .join("\n\n");
}

function toMessage(raw: Record<string, unknown>): ThreadMessage {
  const files = Array.isArray(raw.files) ? (raw.files as Record<string, unknown>[]) : [];
  return {
    ts: String(raw.ts ?? ""),
    author: String(raw.user ?? raw.bot_id ?? "unknown"),
    bot: typeof raw.bot_id === "string" || raw.subtype === "bot_message",
    text: typeof raw.text === "string" ? raw.text : "",
    files: files.flatMap((file) => {
      const url = file.url_private_download ?? file.url_private;
      if (typeof url !== "string") return [];
      return [
        {
          name: String(file.name ?? file.title ?? "file"),
          mimeType: String(file.mimetype ?? ""),
          size: Number(file.size ?? 0),
          url,
        },
      ];
    }),
  };
}

function cut(text: string): string {
  return text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT - 1)}…`;
}
