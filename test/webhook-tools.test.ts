import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Sql } from "../lib/db.ts";
import type { LedgerDeps } from "../lib/jobs/run.ts";
import { recordSessionThread } from "../lib/ledger/threads.ts";
import type { SlackApi } from "../lib/slack/api.ts";
import { getTrigger, parseTriggerRef, type Trigger } from "../lib/triggers/rows.ts";
import { TRIGGER_NOT_ALLOWED } from "../lib/triggers/setup.ts";
import { WEBHOOKS_OFF, webhookSecret } from "../lib/triggers/webhook.ts";
import { hasDatabase, useLedger } from "./helpers/ledger.ts";

const runtime = vi.hoisted(() => ({
  sql: undefined as Sql | undefined,
  slack: undefined as SlackApi | undefined,
}));
vi.mock("../lib/runtime.ts", async (original) => ({
  ...(await original<object>()),
  ledger: () => runtime.sql,
  ledgerDeps: (): LedgerDeps =>
    ({
      sql: runtime.sql,
      allowedProjects: [],
      ...(runtime.slack ? { slack: runtime.slack } : {}),
    }) as LedgerDeps,
  pack: () => undefined,
}));

import triggerCreate from "../agent/tools/trigger_create.ts";
import triggerList from "../agent/tools/trigger_list.ts";
import triggerRotate, { NOT_YOUR_WEBHOOK } from "../agent/tools/trigger_rotate_secret.ts";

// Decision 090: anyone allowed sets up a webhook trigger. Its URL and secret go only to the
// creator's DM, once; no tool result, channel, or log carries the secret. Only the creator
// rotates it.

const KEY = "w".repeat(48);
const ALLOWED = "slack:T1:UALLOWED";
const OTHER = "slack:T1:UOTHER";
const STRANGER = "slack:T1:USTRANGER";
const RUN = "eve:app";

const ctx = (principalId: string, id: string) => ({
  session: { id, auth: { current: { principalId } } },
  callId: "call-1",
});
// biome-ignore lint/suspicious/noExplicitAny: a test context with only the fields the tools read
const call = (tool: any, input: unknown, principalId = ALLOWED, session = "here-session") =>
  tool.execute(input, ctx(principalId, session)) as Promise<
    string | { trigger: string; answer: string; url?: string; secretSent?: boolean }
  >;

const base = {
  title: "Deploy alerts",
  instruction: "Summarize each deploy alert and say if it needs a person.",
  on: "webhook",
  keywords: [],
  builder: "ask",
};

interface Post {
  channel: string;
  text: string;
}

// Channel facts and a record of every post. `failPosts` makes chat.postMessage fail.
function slackWith(posts: Post[], options: { failPosts?: boolean } = {}): SlackApi {
  return {
    call: vi.fn(async (method: string, body: Record<string, unknown>) => {
      const channel = String(body.channel);
      if (method === "conversations.info") {
        return { channel: { id: channel, is_private: false, is_member: true } };
      }
      if (method === "conversations.members") return { members: ["UALLOWED", "UOTHER"] };
      if (method === "conversations.open") return { channel: { id: `D${String(body.users)}` } };
      if (method === "chat.postMessage") {
        if (options.failPosts) throw new Error("channel_not_found");
        posts.push({ channel, text: String(body.text) });
        return { ts: "1.1" };
      }
      throw new Error(`unexpected ${method}`);
    }),
  };
}

describe.skipIf(!hasDatabase)("webhook trigger tools", () => {
  const ledger = useLedger();
  let posts: Post[];

  beforeEach(async () => {
    runtime.sql = ledger.sql();
    posts = [];
    runtime.slack = slackWith(posts);
    vi.stubEnv("SYM_SLACK_USERS", "UALLOWED,UOTHER");
    vi.stubEnv("SYM_WEBHOOK_KEY", KEY);
    vi.stubEnv("SYM_SIGNIN_URL", "https://sym.example.com");
    await recordSessionThread(ledger.sql(), {
      sessionId: "here-session",
      channelId: "CHERE",
      threadTs: "1.1",
      teamId: "T1",
      userId: "UALLOWED",
    });
  });
  afterEach(() => vi.unstubAllEnvs());

  const created = async (input: unknown = base, principalId = ALLOWED) => {
    const result = await call(triggerCreate, input, principalId);
    if (typeof result === "string") throw new Error(result);
    const row = await getTrigger(ledger.sql(), parseTriggerRef(result.trigger) ?? 0);
    if (!row) throw new Error("no row");
    return { result, row };
  };
  const secretOf = (row: Trigger) => webhookSecret(KEY, row.hookId ?? "", row.secretVersion);

  it("creates a webhook trigger that posts in this channel and DMs the secret once", async () => {
    const { result, row } = await created();
    expect(row).toMatchObject({
      kind: "webhook",
      channel: null,
      destination: "CHERE",
      owner: "UALLOWED",
      status: "active",
      secretVersion: 1,
    });
    expect(row.hookId).toMatch(/^[A-Za-z0-9_-]{24}$/);
    const url = `https://sym.example.com/sym/hooks/${row.hookId}`;
    expect(result).toMatchObject({ url, secretSent: true });
    // The secret is only in the DM: not in the tool result, and not in any channel.
    const secret = secretOf(row);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.channel).toBe("DUALLOWED");
    expect(posts[0]?.text).toContain(secret);
    expect(posts[0]?.text).toContain(url);
    expect(posts[0]?.text).toContain("x-sym-signature");
    expect(posts.filter((p) => !p.channel.startsWith("D"))).toEqual([]);
    // The row holds no secret.
    const [raw] = await ledger.sql()`select * from triggers where id = ${row.id}`;
    expect(JSON.stringify(raw)).not.toContain(secret);
  });

  it("posts runs in the person's DM on request", async () => {
    const { row } = await created({ ...base, destination: "dm" });
    expect(row.destination).toBe("DUALLOWED");
  });

  it("refuses when webhooks are off, and for a stranger or a run", async () => {
    vi.stubEnv("SYM_WEBHOOK_KEY", "");
    expect(await call(triggerCreate, base)).toBe(WEBHOOKS_OFF);
    vi.stubEnv("SYM_WEBHOOK_KEY", KEY);
    expect(await call(triggerCreate, base, STRANGER)).toBe(TRIGGER_NOT_ALLOWED);
    expect(await call(triggerCreate, base, RUN)).toBe(TRIGGER_NOT_ALLOWED);
    expect(posts).toEqual([]);
  });

  it("says so when the DM fails, without the secret", async () => {
    runtime.slack = slackWith(posts, { failPosts: true });
    const { result, row } = await created();
    expect(result).toMatchObject({ secretSent: false });
    expect(result.answer).toContain("rotate");
    expect(JSON.stringify(result)).not.toContain(secretOf(row));
  });

  it("lists the URL and never the secret", async () => {
    const { row } = await created({ ...base, title: "Listed hook" });
    const listed = (await triggerList.execute({} as never, ctx(OTHER, "x") as never)) as {
      summary: string;
      triggers: { ref: string; url: string | null }[];
    };
    const url = `https://sym.example.com/sym/hooks/${row.hookId}`;
    expect(listed.summary).toContain("Listed hook: on a signed webhook request - active");
    expect(listed.summary).toContain(`URL: ${url}`);
    expect(listed.triggers.find((t) => t.ref === `T-${row.id}`)?.url).toBe(url);
    expect(JSON.stringify(listed)).not.toContain(secretOf(row));
  });

  it("rotates only for the creator and DMs the new secret", async () => {
    const { row } = await created();
    const ref = `T-${row.id}`;
    posts.length = 0;
    expect(await call(triggerRotate, { trigger: ref }, OTHER)).toBe(NOT_YOUR_WEBHOOK);
    expect(await call(triggerRotate, { trigger: ref }, STRANGER)).toBe(TRIGGER_NOT_ALLOWED);
    expect(await call(triggerRotate, { trigger: ref }, RUN)).toBe(TRIGGER_NOT_ALLOWED);
    expect(posts).toEqual([]);
    const result = await call(triggerRotate, { trigger: ref });
    expect(result).toMatchObject({ trigger: ref, secretSent: true });
    const rotated = await getTrigger(ledger.sql(), row.id);
    if (!rotated) throw new Error("no row");
    expect(rotated.secretVersion).toBe(2);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.channel).toBe("DUALLOWED");
    expect(posts[0]?.text).toContain(secretOf(rotated));
    expect(posts[0]?.text).not.toContain(secretOf(row));
    expect(JSON.stringify(result)).not.toContain(secretOf(rotated));
  });
});
