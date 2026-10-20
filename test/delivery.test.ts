import { describe, expect, it } from "vitest";
import { CARD_VERSION_FIELD, deliver } from "../lib/delivery/deliver.ts";
import type { DisplayChoice } from "../lib/display.ts";
import { createJob, getJob, markCardSent, setJobCard, updateJob } from "../lib/ledger/jobs.ts";
import { claimPosts, enqueuePost, markCardPostSent, postStatus } from "../lib/ledger/outbox.ts";
import { type SlackApi, SlackApiError } from "../lib/slack/api.ts";
import { hasDatabase, useLedger } from "./helpers/ledger.ts";

// Records calls and answers like Slack. `failWith` makes the next calls fail with a Slack code.
function fakeSlack() {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  let nextTs = 1;
  let failWith: string | undefined;
  const api: SlackApi = {
    async call(method, body) {
      calls.push({ method, body });
      if (failWith) throw new SlackApiError(method, failWith);
      if (method === "chat.postMessage") return { ok: true, ts: `1700000000.${nextTs++}` };
      return { ok: true, ts: body.ts };
    },
  };
  return {
    api,
    calls,
    fail: (code: string | undefined) => {
      failWith = code;
    },
  };
}

const text: DisplayChoice = { level: 1, target: "thread", reason: "short" };
const card: DisplayChoice = { level: 3, target: "thread", reason: "long job with steps" };

describe.skipIf(!hasDatabase)("deliver", () => {
  const ledger = useLedger();

  const newJob = (key: string) =>
    createJob(ledger.sql(), {
      requestKey: key,
      kind: "code-change",
      title: "Retry",
      brief: {},
      worker: "fake",
      slackChannel: "C1",
      slackThreadTs: "1690000000.000100",
    });

  it("sends a pending post once, without link unfurls", async () => {
    const sql = ledger.sql();
    const slack = fakeSlack();
    await enqueuePost(sql, {
      idempotencyKey: "deliver-once",
      method: "chat.postMessage",
      payload: { channel: "C1", thread_ts: "1690000000.000100", text: "Done" },
      display: text,
    });

    const first = await deliver(sql, slack.api);
    const second = await deliver(sql, slack.api);

    const posts = slack.calls.filter((c) => c.body.text === "Done");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toMatchObject({ unfurl_links: false, unfurl_media: false });
    expect(first.sent).toBeGreaterThanOrEqual(1);
    expect(second.sent).toBe(0);
  });

  it("reports whether one post went out, for the sign-in DM", async () => {
    const sql = ledger.sql();
    const post = await enqueuePost(sql, {
      idempotencyKey: "status-check",
      method: "chat.postMessage",
      payload: { channel: "C1", text: "Link" },
      display: text,
    });
    expect(await postStatus(sql, post.id)).toBe("pending");
    await deliver(sql, fakeSlack().api);
    expect(await postStatus(sql, post.id)).toBe("sent");
  });

  it("saves a card's ts on the job and edits the card only when it changes", async () => {
    const sql = ledger.sql();
    const slack = fakeSlack();
    const job = await newJob("card");
    const v1 = await setJobCard(sql, job.id, { blocks: [{ type: "plan" }], text: "v1" });
    await enqueuePost(sql, {
      idempotencyKey: `card-${job.id}`,
      jobId: job.id,
      method: "chat.postMessage",
      purpose: "card",
      payload: {
        channel: "C1",
        blocks: v1.card?.blocks,
        text: "v1",
        [CARD_VERSION_FIELD]: v1.cardVersion,
      },
      display: card,
    });

    await deliver(sql, slack.api);
    const posted = await getJob(sql, job.id);
    expect(posted?.cardTs).toMatch(/^1700000000\./);
    expect(posted?.cardSentVersion).toBe(v1.cardVersion);
    expect(slack.calls.at(-1)?.body).not.toHaveProperty(CARD_VERSION_FIELD);

    await setJobCard(sql, job.id, { blocks: [{ type: "plan" }], text: "v1" });
    expect((await deliver(sql, slack.api)).cardsUpdated).toBe(0);

    await setJobCard(sql, job.id, { blocks: [{ type: "plan", title: "x" }], text: "v2" });
    const report = await deliver(sql, slack.api);

    expect(report.cardsUpdated).toBe(1);
    expect(slack.calls.at(-1)).toMatchObject({
      method: "chat.update",
      body: { channel: "C1", ts: posted?.cardTs, text: "v2" },
    });
  });

  it("does not edit a card that has not been posted yet", async () => {
    const sql = ledger.sql();
    const slack = fakeSlack();
    const job = await newJob("unposted");
    await setJobCard(sql, job.id, { blocks: [], text: "never posted" });

    await deliver(sql, slack.api);

    expect(slack.calls.some((c) => c.body.text === "never posted")).toBe(false);
  });

  it("records a Slack error and retries the post on the next delivery", async () => {
    const sql = ledger.sql();
    const slack = fakeSlack();
    const post = await enqueuePost(sql, {
      idempotencyKey: "flaky-send",
      method: "chat.postMessage",
      payload: { channel: "C1", text: "Flaky" },
      display: text,
    });

    slack.fail("ratelimited");
    await deliver(sql, slack.api);
    const [failed] =
      await sql`select status, attempts, last_error from outbox where id = ${post.id}`;
    expect(failed).toEqual({ status: "pending", attempts: 1, lastError: "ratelimited" });

    slack.fail(undefined);
    await deliver(sql, slack.api);
    const [sent] = await sql`select status from outbox where id = ${post.id}`;
    expect(sent).toEqual({ status: "sent" });
  });

  it("lets only one of two concurrent senders send a post", async () => {
    const sql = ledger.sql();
    const slack = fakeSlack();
    await enqueuePost(sql, {
      idempotencyKey: "race",
      method: "chat.postMessage",
      payload: { channel: "C1", text: "Race" },
      display: text,
    });

    await Promise.all([deliver(sql, slack.api), deliver(sql, slack.api)]);

    expect(slack.calls.filter((c) => c.body.text === "Race")).toHaveLength(1);
  });

  it("does not hand a claimed post to a second sender before the claim runs out", async () => {
    const sql = ledger.sql();
    await enqueuePost(sql, {
      idempotencyKey: "claimed",
      method: "chat.postMessage",
      payload: { channel: "C1", text: "Claimed" },
      display: text,
    });
    const first = await claimPosts(sql, 100, 60_000);
    const second = await claimPosts(sql, 100, 60_000);

    const ids = (posts: { idempotencyKey: string }[]) => posts.map((p) => p.idempotencyKey);
    expect(ids(first)).toContain("claimed");
    expect(ids(second)).not.toContain("claimed");
  });

  it("saves the card ts and the shown version with the outbox completion", async () => {
    const sql = ledger.sql();
    const job = await newJob("card-atomic");
    const v1 = await setJobCard(sql, job.id, { blocks: [], text: "v1" });
    const post = await enqueuePost(sql, {
      idempotencyKey: `card-atomic-${job.id}`,
      jobId: job.id,
      method: "chat.postMessage",
      purpose: "card",
      payload: { channel: "C1", text: "v1" },
      display: card,
    });

    await markCardPostSent(sql, post.id, "1700000000.9", v1.cardVersion);
    const [row] = await sql`select status, slack_ts from outbox where id = ${post.id}`;
    const saved = await getJob(sql, job.id);
    expect(row).toEqual({ status: "sent", slackTs: "1700000000.9" });
    expect(saved).toMatchObject({ cardTs: "1700000000.9", cardSentVersion: v1.cardVersion });

    // A late completion of an older version cannot move the shown version back.
    const v2 = await setJobCard(sql, job.id, { blocks: [], text: "v2" });
    await markCardSent(sql, job.id, v2.cardVersion);
    await markCardPostSent(sql, post.id, "1700000000.9", v1.cardVersion);
    expect((await getJob(sql, job.id))?.cardSentVersion).toBe(v2.cardVersion);
  });

  it("serializes card edits per job and ends with the newest card in Slack", async () => {
    const sql = ledger.sql();
    const job = await newJob("card-race");
    await updateJob(sql, job.id, { cardTs: "1700000000.5" });
    await setJobCard(sql, job.id, { blocks: [], text: "v1" });

    const updates: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => {};
    const inFlight = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const slow: SlackApi = {
      async call(_method, body) {
        updates.push(String(body.text));
        if (body.text === "v1") {
          entered();
          await gate;
        }
        return { ok: true, ts: body.ts };
      },
    };
    const fast = fakeSlack();

    // Sender A holds the card at v1. The card changes to v2. Sender B must not edit meanwhile.
    const a = deliver(sql, slow);
    await inFlight;
    const v2 = await setJobCard(sql, job.id, { blocks: [], text: "v2" });
    const skipped = await deliver(sql, fast.api);
    expect(skipped.cardsUpdated).toBe(0);
    expect(fast.calls).toHaveLength(0);

    release();
    await a;
    expect((await getJob(sql, job.id))?.cardSentVersion).toBe(v2.cardVersion - 1);

    // The next delivery reloads the newest card and edits it.
    await deliver(sql, fast.api);
    expect(fast.calls.at(-1)?.body).toMatchObject({ text: "v2" });
    expect((await getJob(sql, job.id))?.cardSentVersion).toBe(v2.cardVersion);
    expect(updates).toEqual(["v1"]);
  });
});
