import { createServer, type IncomingMessage, type Server } from "node:http";

// An in-process fake of the Slack Web API for tests and the local e2e. It listens on 127.0.0.1,
// stores messages, and answers the methods Eve's Slack channel and Sym call. Point
// SLACK_API_BASE_URL at `apiBaseUrl`. It never talks to the real Slack.

export interface FakeSlackOptions {
  botToken?: string;
  botUserId?: string;
  teamId?: string;
  port?: number;
  // Conversation info by channel ID. Unlisted channels look like public channels.
  channels?: Record<string, Record<string, unknown>>;
  // Profiles by user ID. Unlisted users get a generic profile.
  users?: Record<string, Record<string, unknown>>;
}

export interface FakeSlackCall {
  method: string;
  body: Record<string, unknown>;
  authorized: boolean;
}

export interface FakeSlackMessage {
  channel: string;
  ts: string;
  thread_ts?: string | undefined;
  user: string;
  bot_id?: string | undefined;
  text?: string | undefined;
  markdown_text?: string | undefined;
  blocks?: unknown[] | undefined;
  metadata?: unknown | undefined;
  files?: unknown[] | undefined;
  edited?: { ts: string } | undefined;
  [key: string]: unknown;
}

export interface FakeSlackReaction {
  channel: string;
  timestamp: string;
  name: string;
}

export interface FakeSlack {
  apiBaseUrl: string;
  calls: FakeSlackCall[];
  messages: FakeSlackMessage[];
  ephemerals: FakeSlackMessage[];
  reactions: FakeSlackReaction[];
  // The workspace's custom emoji for emoji.list: a name to an image URL or `alias:<name>`.
  customEmoji: Record<string, string>;
  // Each assistant.threads.setStatus call, in order.
  statuses: { channel: string; thread_ts: string; status: string }[];
  views: Record<string, unknown>[];
  uploads: { fileId: string; bytes: number }[];
  // Calls to one method, in order.
  callsTo(method: string): FakeSlackCall[];
  // Adds a message as a human would post it (a stand-in for the Slack client).
  addMessage(
    message: Partial<FakeSlackMessage> & { channel: string; user: string },
  ): FakeSlackMessage;
  // The next call to `method` answers `ok: false` with `error`.
  failNext(method: string, error: string): void;
  // Resolves when a stored message matches, or rejects after `timeoutMs`.
  waitForMessage(
    predicate: (message: FakeSlackMessage) => boolean,
    timeoutMs?: number,
  ): Promise<FakeSlackMessage>;
  close(): Promise<void>;
}

// Fields whose string values are plain text, never JSON.
const TEXT_FIELDS = new Set(["text", "markdown_text", "initial_comment", "status", "name"]);

function parseValue(key: string, value: string): unknown {
  if (TEXT_FIELDS.has(key)) return value;
  const first = value[0];
  if (first !== "{" && first !== "[") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

// Accepts form-encoded and JSON bodies.
function parseBody(raw: Buffer, contentType: string): Record<string, unknown> {
  const text = raw.toString("utf8");
  if (!text) return {};
  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  const body: Record<string, unknown> = {};
  for (const [key, value] of new URLSearchParams(text)) body[key] = parseValue(key, value);
  return body;
}

export async function startFakeSlack(options: FakeSlackOptions = {}): Promise<FakeSlack> {
  const botToken = options.botToken ?? "xoxb-fake-token";
  const botUserId = options.botUserId ?? "UBOT";
  const teamId = options.teamId ?? "T0FAKE";
  const calls: FakeSlackCall[] = [];
  const messages: FakeSlackMessage[] = [];
  const ephemerals: FakeSlackMessage[] = [];
  const reactions: FakeSlackReaction[] = [];
  const customEmoji: Record<string, string> = {};
  const statuses: FakeSlack["statuses"] = [];
  const views: Record<string, unknown>[] = [];
  const uploads: FakeSlack["uploads"] = [];
  const pendingUploads = new Set<string>();
  const failures = new Map<string, string[]>();
  const waiters = new Set<() => void>();
  let tsCounter = 0;
  let fileCounter = 0;
  const baseSeconds = Math.floor(Date.now() / 1000);

  // Unique, increasing, Slack-shaped ts values.
  const nextTs = () => `${baseSeconds}.${String(++tsCounter).padStart(6, "0")}`;
  const changed = () => {
    for (const wake of [...waiters]) wake();
  };

  function store(fields: Partial<FakeSlackMessage> & { channel: string }): FakeSlackMessage {
    const message: FakeSlackMessage = {
      type: "message",
      user: botUserId,
      ts: nextTs(),
      ...fields,
    };
    if (message.user === botUserId) message.bot_id = "BFAKE";
    messages.push(message);
    changed();
    return message;
  }

  const find = (channel: unknown, ts: unknown) =>
    messages.find((m) => m.channel === channel && m.ts === ts);

  // Handlers return the response fields. They throw a string to answer `ok: false`.
  const handlers: Record<string, (body: Record<string, unknown>) => Record<string, unknown>> = {
    "auth.test": () => ({
      url: "http://127.0.0.1/",
      team: "Fake",
      team_id: teamId,
      user: "sym",
      user_id: botUserId,
      bot_id: "BFAKE",
    }),
    "chat.postMessage": (b) => {
      if (!b.channel) throw "channel_not_found";
      const message = store({
        channel: String(b.channel),
        thread_ts: b.thread_ts === undefined ? undefined : String(b.thread_ts),
        text: b.text as string | undefined,
        markdown_text: b.markdown_text as string | undefined,
        blocks: b.blocks as unknown[] | undefined,
        metadata: b.metadata,
      });
      return { channel: message.channel, ts: message.ts, message };
    },
    "chat.update": (b) => {
      const message = find(b.channel, b.ts);
      if (!message) throw "message_not_found";
      for (const key of ["text", "markdown_text", "blocks", "metadata"]) {
        if (b[key] !== undefined) message[key] = b[key];
      }
      message.edited = { ts: nextTs() };
      changed();
      return { channel: message.channel, ts: message.ts, text: message.text, message };
    },
    "chat.postEphemeral": (b) => {
      if (!b.channel || !b.user) throw "channel_not_found";
      const message: FakeSlackMessage = {
        channel: String(b.channel),
        ts: nextTs(),
        user: botUserId,
        thread_ts: b.thread_ts === undefined ? undefined : String(b.thread_ts),
        text: b.text as string | undefined,
        markdown_text: b.markdown_text as string | undefined,
        blocks: b.blocks as unknown[] | undefined,
        target_user: String(b.user),
      };
      ephemerals.push(message);
      changed();
      return { message_ts: message.ts };
    },
    "chat.delete": (b) => {
      const index = messages.findIndex((m) => m.channel === b.channel && m.ts === b.ts);
      if (index < 0) throw "message_not_found";
      messages.splice(index, 1);
      return { channel: String(b.channel), ts: String(b.ts) };
    },
    "chat.getPermalink": (b) => {
      if (!find(b.channel, b.message_ts)) throw "message_not_found";
      return {
        channel: b.channel,
        permalink: `http://127.0.0.1/archives/${b.channel}/p${String(b.message_ts).replace(".", "")}`,
      };
    },
    "reactions.add": (b) => {
      const entry = {
        channel: String(b.channel),
        timestamp: String(b.timestamp),
        name: String(b.name),
      };
      if (!find(entry.channel, entry.timestamp)) throw "message_not_found";
      if (
        reactions.some(
          (r) =>
            r.channel === entry.channel && r.timestamp === entry.timestamp && r.name === entry.name,
        )
      ) {
        throw "already_reacted";
      }
      reactions.push(entry);
      return {};
    },
    "emoji.list": () => ({ emoji: customEmoji }),
    "reactions.remove": (b) => {
      const index = reactions.findIndex(
        (r) => r.channel === b.channel && r.timestamp === b.timestamp && r.name === b.name,
      );
      if (index < 0) throw "no_reaction";
      reactions.splice(index, 1);
      return {};
    },
    "assistant.threads.setStatus": (b) => {
      statuses.push({
        channel: String(b.channel_id ?? b.channel),
        thread_ts: String(b.thread_ts),
        status: String(b.status ?? ""),
      });
      changed();
      return {};
    },
    "conversations.replies": (b) => {
      const root = find(b.channel, b.ts);
      if (!root) throw "thread_not_found";
      const latest = b.latest === undefined ? undefined : Number(b.latest);
      const limit = b.limit === undefined ? 1000 : Number(b.limit);
      const thread = messages.filter(
        (m) => m.channel === b.channel && (m.ts === b.ts || m.thread_ts === b.ts),
      );
      const kept = thread
        .filter((m) => latest === undefined || Number(m.ts) <= latest)
        .slice(0, limit)
        .map((m) => (m.ts === root.ts ? { ...m, thread_ts: root.ts } : m));
      return { messages: kept, has_more: false };
    },
    "conversations.info": (b) => {
      const channel = String(b.channel);
      const known = options.channels?.[channel];
      return {
        channel: {
          id: channel,
          is_channel: !channel.startsWith("D"),
          is_im: channel.startsWith("D"),
          is_private: false,
          ...known,
        },
      };
    },
    "conversations.open": (b) => {
      if (!b.users) throw "users_list_not_supplied";
      return { channel: { id: `D${String(b.users).split(",")[0]}` } };
    },
    "users.info": (b) => {
      const id = String(b.user);
      return {
        user: {
          id,
          team_id: teamId,
          name: id.toLowerCase(),
          real_name: `User ${id}`,
          is_bot: false,
          profile: { display_name: `user-${id}` },
          ...options.users?.[id],
        },
      };
    },
    "views.open": (b) => {
      if (!b.trigger_id && !b.interactivity_pointer) throw "invalid_arguments";
      const view = (b.view ?? {}) as Record<string, unknown>;
      views.push(view);
      changed();
      return { view: { id: `V${views.length}`, ...view } };
    },
    "files.getUploadURLExternal": () => {
      const fileId = `F${String(++fileCounter).padStart(6, "0")}`;
      pendingUploads.add(fileId);
      return { upload_url: `${origin}/upload/${fileId}`, file_id: fileId };
    },
    "files.completeUploadExternal": (b) => {
      const files = (Array.isArray(b.files) ? b.files : []) as { id: string; title?: string }[];
      for (const file of files) if (!pendingUploads.has(file.id)) throw "invalid_arguments";
      if (b.channel_id) {
        store({
          channel: String(b.channel_id),
          thread_ts: b.thread_ts === undefined ? undefined : String(b.thread_ts),
          text: b.initial_comment as string | undefined,
          files,
        });
      }
      return { files };
    },
  };

  const server: Server = createServer(async (req, res) => {
    const send = (payload: Record<string, unknown>) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    const raw = await readBody(req);
    const authorized = req.headers.authorization === `Bearer ${botToken}`;
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;

    // Upload target for files.getUploadURLExternal. It takes raw bytes.
    const upload = /^\/upload\/(F\d+)$/.exec(path);
    if (upload) {
      const fileId = upload[1] as string;
      if (!authorized || !pendingUploads.has(fileId)) {
        res.writeHead(403).end("denied");
        return;
      }
      uploads.push({ fileId, bytes: raw.byteLength });
      res.writeHead(200).end(`OK - ${raw.byteLength}`);
      return;
    }

    const method = path.replace(/^\/api\//, "");
    const body = parseBody(raw, String(req.headers["content-type"] ?? ""));
    calls.push({ method, body, authorized });
    if (!authorized) return send({ ok: false, error: "invalid_auth" });

    const queued = failures.get(method);
    if (queued?.length) return send({ ok: false, error: queued.shift() as string });

    const handler = handlers[method];
    if (!handler) return send({ ok: false, error: "unknown_method" });
    try {
      send({ ok: true, ...handler(body) });
    } catch (error) {
      if (typeof error !== "string") throw error;
      send({ ok: false, error });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake Slack did not bind a port");
  const origin = `http://127.0.0.1:${address.port}`;

  return {
    apiBaseUrl: `${origin}/api/`,
    calls,
    messages,
    ephemerals,
    reactions,
    customEmoji,
    statuses,
    views,
    uploads,
    callsTo: (method) => calls.filter((call) => call.method === method),
    addMessage: (message) => store(message),
    failNext(method, error) {
      failures.set(method, [...(failures.get(method) ?? []), error]);
    },
    waitForMessage(predicate, timeoutMs = 5000) {
      return new Promise((resolve, reject) => {
        const check = () => {
          const hit = messages.find(predicate);
          if (!hit) return;
          clearTimeout(timer);
          waiters.delete(check);
          resolve(hit);
        };
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(new Error("fake Slack: no matching message before the timeout"));
        }, timeoutMs);
        waiters.add(check);
        check();
      });
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
