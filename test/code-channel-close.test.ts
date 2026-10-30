import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { closeJob } from "../lib/jobs/followup.ts";
import { createJob, getJob, updateJob } from "../lib/ledger/jobs.ts";
import { handleCodeChannelAction } from "../lib/slack/code-channel-actions.ts";
import { closeCodeChannel } from "../lib/slack/code-channel-close.ts";
import { slackApiFromEnv } from "../lib/slack/eve-api.ts";
import { type FakeSlack, startFakeSlack } from "./fakes/slack-server.ts";
import { FakeWorker } from "./fakes/worker.ts";
import { hasDatabase, useLedger } from "./helpers/ledger.ts";

describe.skipIf(!hasDatabase)("close any code channel", () => {
  const ledger = useLedger();
  let slack: FakeSlack;
  let api: ReturnType<typeof slackApiFromEnv>;
  beforeAll(async () => {
    slack = await startFakeSlack();
    api = slackApiFromEnv({
      SLACK_BOT_TOKEN: "xoxb-fake-token",
      SLACK_API_BASE_URL: slack.apiBaseUrl,
    });
  });
  afterAll(async () => slack.close());
  afterEach(() => vi.restoreAllMocks());

  function deps() {
    const jobDeps = { sql: ledger.sql(), slack: api, worker: new FakeWorker() };
    return {
      ...jobDeps,
      usersEnv: "U1",
      closeJob: vi.fn((ref: string, by: string) => closeJob(jobDeps, ref, by)),
    };
  }
  async function channel() {
    const created = await api.call("agents.conversations.create", { name: "Conversation" });
    return String(created.channel_id);
  }

  it("archives a conversation channel without a summary or worker, once under double click", async () => {
    const d = deps();
    const id = await channel();
    const before = slack.callsTo("agents.conversations.archive").length;
    const answers = await Promise.all([
      closeCodeChannel(d, id, "U1"),
      closeCodeChannel(d, id, "U1"),
    ]);
    expect(answers.sort()).toEqual(["Already closed.", "Closed this and archived its channel."]);
    expect(
      slack
        .callsTo("agents.conversations.archive")
        .slice(before)
        .map((c) => c.body),
    ).toEqual([{ channel_id: id }]);
    expect(slack.codeChannels.find((c) => c.id === id)?.archived).toBe(true);
    expect(d.closeJob).not.toHaveBeenCalled();
  });

  it("delegates a finished job channel to the existing close path", async () => {
    const d = deps();
    const id = await channel();
    const job = await createJob(d.sql, {
      requestKey: id,
      kind: "code-change",
      title: "Retry work",
      brief: {},
      worker: "fake",
      slackChannel: id,
    });
    await updateJob(d.sql, job.id, { status: "done", codeChannel: true });
    expect(await closeCodeChannel(d, id, "U1")).toBe("Closed this and archived its channel.");
    expect(d.closeJob).toHaveBeenCalledExactlyOnceWith(`J-${job.id}`, "U1");
    expect(await getJob(d.sql, job.id)).toMatchObject({ archiveState: "archived", closedBy: "U1" });
  });

  it("refuses running jobs without archiving or accepting closure", async () => {
    const d = deps();
    const id = await channel();
    const job = await createJob(d.sql, {
      requestKey: id,
      kind: "code-change",
      title: "Retry work",
      brief: {},
      worker: "fake",
      slackChannel: id,
    });
    await updateJob(d.sql, job.id, { status: "running", codeChannel: true });
    expect(await closeCodeChannel(d, id, "U1")).toBe("I'm still working on this. Stop it first.");
    expect(await getJob(d.sql, job.id)).toMatchObject({ closedAt: null });
    expect(slack.codeChannels.find((c) => c.id === id)?.archived).toBe(false);
  });

  it("answers a refused click in the still-open channel", async () => {
    const d = deps();
    const id = await channel();
    const job = await createJob(d.sql, {
      requestKey: `click-${id}`,
      kind: "code-change",
      title: "Retry work",
      brief: {},
      worker: "fake",
      slackChannel: id,
    });
    await updateJob(d.sql, job.id, { status: "running", codeChannel: true });
    await handleCodeChannelAction(d, { key: "close", channel: id, user: "U1" }, `click-${id}`);
    expect(slack.codeChannels.find((c) => c.id === id)?.archived).toBe(false);
    expect(slack.messages.at(-1)).toMatchObject({
      channel: id,
      text: "I'm still working on this. Stop it first.",
    });
  });

  it("refuses an unauthorized requester before any Slack call", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const d = deps();
    const before = slack.calls.length;
    expect(await closeCodeChannel(d, "CSECRET", "UOTHER")).toBe(
      "You are not on Sym's Slack allow-list.",
    );
    expect(slack.calls).toHaveLength(before);
    expect(d.closeJob).not.toHaveBeenCalled();
  });

  it("refuses ordinary Slack channels", async () => {
    const d = deps();
    expect(await closeCodeChannel(d, "CORDINARY", "U1")).toBe("This is not a code channel.");
  });

  it("reports an archived channel without another archive call", async () => {
    const d = deps();
    const id = await channel();
    await api.call("agents.conversations.archive", { channel_id: id });
    const before = slack.calls.length;
    expect(await closeCodeChannel(d, id, "U1")).toBe("Already closed.");
    expect(slack.calls.slice(before).map((c) => c.method)).toEqual(["conversations.info"]);
  });

  it.each(["conversations.info", "agents.conversations.archive"])(
    "reports Slack's refusal from %s and lets the person retry",
    async (method) => {
      const d = deps();
      const id = await channel();
      slack.failNext(method, "restricted_action");
      expect(await closeCodeChannel(d, id, "U1")).toBe("Slack refused: restricted_action.");
      expect(slack.codeChannels.find((c) => c.id === id)?.archived).toBe(false);
      expect(await closeCodeChannel(d, id, "U1")).toBe("Closed this and archived its channel.");
    },
  );

  it("handles already_archived returned between info and archive", async () => {
    const id = await channel();
    slack.failNext("agents.conversations.archive", "already_archived");
    expect(await closeCodeChannel(deps(), id, "U1")).toBe("Already closed.");
  });

  const keys = [
    { key: "close" },
    { item_key: "close" },
    { action_id: "close" },
    { item: { key: "close" } },
    { action: { key: "close" } },
  ];
  const variants = ["channel", "channel_id"].flatMap((channelField) =>
    ["user", "user_id"].flatMap((userField) =>
      keys.map((key) => ({ channelField, userField, key })),
    ),
  );
  it.each(variants)("handles event fields $channelField / $userField / $key", async (variant) => {
    const d = deps();
    const id = await channel();
    await handleCodeChannelAction(
      d,
      { ...variant.key, [variant.channelField]: id, [variant.userField]: "U1" },
      id,
    );
    expect(slack.codeChannels.find((c) => c.id === id)?.archived).toBe(true);
    // Slack refuses posts in an archived channel; the archive itself is the confirmation.
    expect(slack.messages.filter((m) => m.channel === id)).toHaveLength(0);
    const posts =
      await d.sql`select 1 from outbox where idempotency_key = ${`code-channel-close:${id}`}`;
    expect(posts).toHaveLength(0);
  });

  it("sends only an ephemeral refusal for a denied click", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const d = deps();
    const id = await channel();
    const before = slack.calls.length;
    await handleCodeChannelAction(d, { key: "close", channel: id, user: "UOTHER" }, id);
    expect(slack.calls.slice(before).map((c) => c.method)).toEqual(["chat.postEphemeral"]);
    expect(slack.ephemerals.at(-1)).toMatchObject({
      channel: id,
      target_user: "UOTHER",
      text: "You are not on Sym's Slack allow-list.",
    });
    expect(slack.codeChannels.find((c) => c.id === id)?.archived).toBe(false);
    expect(d.closeJob).not.toHaveBeenCalled();
  });

  it("ignores other keys and logs only field names for unknown shapes", async () => {
    const d = deps();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const before = slack.calls.length;
    await handleCodeChannelAction(d, { key: "other" }, "other");
    expect(warn).not.toHaveBeenCalled();
    await handleCodeChannelAction(
      d,
      { key: "close", channel: { secret: "sensitive" }, user: "private-user", token: "secret" },
      "unknown",
    );
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "Sym could not parse a code channel action; fields:",
      ["key", "channel", "user", "token"],
    );
    expect(slack.calls).toHaveLength(before);
  });
});
