import { afterEach, describe, expect, it, vi } from "vitest";
import type { Sql } from "../lib/db.ts";
import { recordSessionThread } from "../lib/ledger/threads.ts";
import { hasDatabase, useLedger } from "./helpers/ledger.ts";

const runtime = vi.hoisted(() => ({
  sql: undefined as Sql | undefined,
  slack: undefined as
    | { call: (method: string, body: Record<string, unknown>) => unknown }
    | undefined,
}));
vi.mock("../lib/runtime.ts", async (original) => ({
  ...(await original<object>()),
  ledger: () => runtime.sql,
  pack: () => undefined,
  slackFromEnv: () => runtime.slack,
}));

import presentCard from "../agent/tools/present_card.ts";

// biome-ignore lint/suspicious/noExplicitAny: invoke the registered tool's public execute method
const present = (presentCard as any).execute;
const spec = {
  root: "card",
  elements: {
    card: { type: "Card", props: { title: "Open incidents" }, children: ["fields"] },
    fields: { type: "Fields", props: {}, children: ["open"] },
    open: { type: "Field", props: { label: "Open", value: 3 }, children: [] },
  },
};

describe.skipIf(!hasDatabase)("present_card", () => {
  const ledger = useLedger();
  afterEach(() => vi.unstubAllEnvs());

  async function setup(session: string) {
    runtime.sql = ledger.sql();
    vi.stubEnv("SYM_SLACK_USERS", "U1");
    runtime.slack = { call: vi.fn(async () => ({ ok: true, ts: "2.0" })) };
    await recordSessionThread(runtime.sql, {
      sessionId: session,
      channelId: "C1",
      threadTs: "1.0",
      teamId: "T1",
      userId: "U1",
    });
    return {
      session: { id: session, auth: { current: { principalId: "slack:T1:U1" } } },
      callId: "card",
    };
  }

  it("posts the rendered card in the conversation through the outbox", async () => {
    const ctx = await setup("card-post");
    expect(await present({ spec }, ctx)).toEqual({ posted: true });
    const [row] =
      await ledger.sql()`select status, display from outbox where idempotency_key = 'card-post:card:card'`;
    expect(row?.status).toBe("sent");
    expect(row?.display).toMatchObject({ level: 1 });
    const post = vi
      .mocked(runtime.slack?.call)
      ?.mock.calls.find(([method]) => method === "chat.postMessage");
    expect(post?.[1]).toMatchObject({ channel: "C1", thread_ts: "1.0" });
    expect(JSON.stringify(post?.[1].blocks)).toContain("Open incidents");
    expect(String(post?.[1].text)).toContain("Open: 3");
  });

  it("returns issues and posts nothing for an invalid spec", async () => {
    const ctx = await setup("card-invalid");
    const bad = {
      root: "card",
      elements: { card: { type: "Card", props: { title: 5 }, children: [] } },
    };
    const result = await present({ spec: bad }, ctx);
    expect(result).toMatchObject({ posted: false, issues: [expect.any(String)] });
    expect(await outboxRows("card-invalid")).toHaveLength(0);
  });

  async function outboxRows(session: string) {
    return ledger.sql()`select 1 from outbox where idempotency_key like ${`${session}:%`}`;
  }

  it("refuses a person outside the allow-list and posts nothing", async () => {
    const ctx = await setup("card-stranger");
    ctx.session.auth.current.principalId = "slack:T1:U9";
    expect(await present({ spec }, ctx)).toEqual({
      posted: false,
      reason: "This needs an allowed person in Slack.",
    });
    expect(await outboxRows("card-stranger")).toHaveLength(0);
    expect(runtime.slack?.call).not.toHaveBeenCalled();
  });

  it("refuses a worker caller", async () => {
    const ctx = await setup("card-worker");
    ctx.session.auth.current.principalId = "sym-worker";
    expect(await present({ spec }, ctx)).toBe("Worker threads cannot call this tool.");
    expect(await outboxRows("card-worker")).toHaveLength(0);
  });

  it("sends a card too long for one message back to text", async () => {
    const ctx = await setup("card-long");
    const long = {
      root: "card",
      elements: {
        card: { type: "Card", props: { title: "Notes" }, children: ["a", "b", "c", "d", "e"] },
        ...Object.fromEntries(
          ["a", "b", "c", "d", "e"].map((id) => [
            id,
            { type: "Text", props: { content: "x".repeat(2900) }, children: [] },
          ]),
        ),
      },
    };
    expect(await present({ spec: long }, ctx)).toEqual({
      posted: false,
      reason: "This is too long for a card. Reply in text instead.",
    });
    expect(await outboxRows("card-long")).toHaveLength(0);
  });

  it("tells the brain to answer in text when Slack refuses the card", async () => {
    const ctx = await setup("card-refused");
    runtime.slack = {
      call: vi.fn(async (method: string) => {
        if (method === "chat.postMessage") throw new Error("channel_not_found");
        return { ok: true };
      }),
    };
    expect(await present({ spec }, ctx)).toEqual({
      posted: false,
      reason: "The card didn't post. Answer in text instead.",
    });
    const [row] =
      await ledger.sql()`select status from outbox where idempotency_key = 'card-refused:card:card'`;
    expect(row?.status).toBe("failed");
  });

  it("counts a card it could not try yet as on its way", async () => {
    const ctx = await setup("card-later");
    runtime.slack = undefined;
    expect(await present({ spec }, ctx)).toEqual({ posted: true });
    const [row] =
      await ledger.sql()`select status from outbox where idempotency_key = 'card-later:card:card'`;
    expect(row?.status).toBe("pending");
  });
});
