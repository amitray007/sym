import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BOT,
  briefMention,
  clickButton,
  contractMessage,
  finishedSteps,
  type Harness,
  hitlControls,
  messageText,
  newConversation,
  SAMPLE_CONTRACT,
  sayInChannel,
  settle,
  startHarness,
  startJob,
  threadsOf,
  until,
  waitForJobStatus,
  workerAdvance,
} from "./harness.ts";

let h: Harness;
beforeAll(async () => {
  h = await startHarness({ database: "sym_e2e_code_channels", env: { SYM_CODE_CHANNELS: "on" } });
  await h.startEve();
});
afterAll(async () => {
  h?.writeReport();
  await h?.close();
});
const reconcile = async () => {
  const response = await fetch(`${h.eveUrl()}/eve/v1/dev/schedules/reconcile`, { method: "POST" });
  expect(response.ok).toBe(true);
};

describe("code channel conversations", () => {
  async function running(title: string) {
    const c = newConversation(h);
    const { approval, job, ref } = await startJob(h, c, title);
    await c.click(approval, "Start");
    const channel = await until(
      () => h.slack.codeChannels.find((cc) => cc.sessionId === `sym-${ref}`),
      { label: "the code channel" },
    );
    const thread = await until(() => threadsOf(h, ref)[0], { label: "the worker" });
    return { c, job, ref, channel, thread };
  }
  const resultIn = (channel: string, ref: string) =>
    until(
      async () => {
        const [post] = await h.sql<
          { slackTs: string | null }[]
        >`select slack_ts from outbox where idempotency_key = ${`${ref}:end`} and status = 'sent'`;
        return h.slack.messages.find((m) => m.channel === channel && m.ts === post?.slackTs);
      },
      { label: `${ref} result` },
    );
  const proposalIn = (channel: string) =>
    until(
      () =>
        h.slack.messages.find(
          (m) =>
            m.channel === channel &&
            (m.text ?? "").includes("same branch") &&
            hitlControls(m.blocks ?? []).length > 0,
        ),
      { label: "follow-up Start" },
    );

  it("keeps progress and results in the channel and confirms archive before reporting it", async () => {
    const { c, job, ref, channel, thread } = await running("Channel job");
    expect(channel.originChannel).toBe(c.channel);
    expect(channel.name).toBe("Channel job");
    expect(channel.contextBar).not.toContainEqual(expect.objectContaining({ key: "job" }));
    await workerAdvance(h, thread, finishedSteps());
    await waitForJobStatus(h.sql, job.id, "done");
    const result = await resultIn(channel.id, ref);
    expect(result.thread_ts).toBeUndefined();
    await sayInChannel(h, channel.id, "what's the update?");
    await until(
      () =>
        h.slack.messages.find(
          (m) => m.channel === channel.id && messageText(m).includes("This is done"),
        ),
      { label: "channel status answer" },
    );
    await sayInChannel(h, channel.id, `fixture-close ${ref}`);
    await until(() => (channel.archived ? true : undefined), { label: "confirmed archive" });
    expect(channel.summaryTs).toBe(result.ts);
    expect(
      (await h.sql`select archive_state from jobs where id = ${job.id}`)[0]?.archiveState,
    ).toBe("archived");
    expect(c.botMessages().some((m) => m.ts === result.ts)).toBe(false);
  });

  it("asks locally and accepts a typed answer through a normal brain turn", async () => {
    const { c, job, ref, channel, thread } = await running("Question here");
    await workerAdvance(h, thread, [
      {
        status: "waiting",
        items: ["I need the target."],
        questions: [
          {
            requestId: "req-env",
            questions: [
              {
                id: "q-env",
                header: "Target",
                question: "Which environment?",
                options: [
                  { label: "staging", description: "Test environment" },
                  { label: "production", description: "Production environment" },
                ],
              },
            ],
          },
        ],
      },
    ]);
    const question = await until(
      () =>
        h.slack.messages.find(
          (m) => m.channel === channel.id && messageText(m).includes("Which environment?"),
        ),
      { label: "local question" },
    );
    expect(hitlControls(question.blocks ?? []).map((control) => control.label)).toEqual([
      "staging",
      "production",
    ]);
    expect(c.botMessages().some((m) => messageText(m).includes("Which environment?"))).toBe(false);
    await waitForJobStatus(h.sql, job.id, "waiting_input");
    await sayInChannel(h, channel.id, "staging");
    await until(() => thread.answers[0], { label: "typed answer at the worker" });
    expect(thread.answers).toEqual([{ requestId: "req-env", answers: { "q-env": "staging" } }]);
    await workerAdvance(h, thread, finishedSteps());
    await waitForJobStatus(h.sql, job.id, "done");
    await resultIn(channel.id, ref);
  });

  it("starts follow-ups only after approval and retries archives after a restart", async () => {
    const { job, ref, channel, thread } = await running("Follow-up here");
    await workerAdvance(h, thread, finishedSteps());
    await waitForJobStatus(h.sql, job.id, "done");
    await resultIn(channel.id, ref);
    await sayInChannel(h, channel.id, `fixture-followup ${ref}: log each retry`);
    const proposal = await proposalIn(channel.id);
    expect(thread.sends).toHaveLength(0);
    const start = hitlControls(proposal.blocks ?? []).find((c) => c.label === "Start");
    if (!start?.value) throw new Error("missing Start");
    await clickButton(h, proposal, start.actionId, start.value);
    const child = await until(
      async () =>
        (
          await h.sql<{ id: number }[]>`select id::int from jobs where parent_job_id = ${job.id}`
        )[0],
      { label: "the follow-up" },
    );
    await until(() => thread.sends[0], { label: "the approved send" });
    expect(
      (await h.sql`select slack_channel, code_channel from jobs where id = ${child.id}`)[0],
    ).toMatchObject({ slackChannel: channel.id, codeChannel: true });
    thread.steps.push({
      status: "completed",
      items: [contractMessage({ ...SAMPLE_CONTRACT, summary: "Logged each retry." })],
    });
    await h.sql`update jobs set watch_until = null where id = ${child.id}`;
    await reconcile();
    await waitForJobStatus(h.sql, child.id, "done");
    const result = await resultIn(channel.id, `J-${child.id}`);
    h.slack.failNext("agents.conversations.archive", "internal_error");
    await sayInChannel(h, channel.id, `fixture-close J-${child.id}`);
    await until(
      async () =>
        (await h.sql`select 1 from jobs where id = ${child.id} and archive_state = 'pending'`)[0],
      { label: "pending archive" },
    );
    const notice = await until(
      () =>
        h.slack.messages.find(
          (m) =>
            m.channel === channel.id &&
            m.ts !== result.ts &&
            (m.text ?? "").includes("couldn't archive this channel"),
        ),
      { label: "honest retry notice" },
    );
    expect(channel.archived).toBe(false);
    expect(messageText(notice)).not.toContain("Closed");
    expect(JSON.stringify(notice.blocks ?? [])).not.toContain("sym_job_close");
    await h.stopEve();
    await h.startEve();
    await reconcile();
    await until(() => (channel.archived ? true : undefined), {
      label: "archive recovered after restart",
    });
    await settle(h);
    expect(channel.summaryTs).toBe(result.ts);
    expect(thread.organized.filter((action) => action === "settle")).toHaveLength(1);
    expect(messageText(notice)).toContain("I've archived");
    expect(messageText(notice)).not.toContain("I'll retry");
    expect(messageText(result)).toContain("I've closed this and archived its channel.");
    expect(messageText(result)).not.toContain("couldn't archive");
    const archives = h.slack.callsTo("agents.conversations.archive");
    expect(archives.at(-1)?.body).toMatchObject({
      channel_id: channel.id,
      summary_message_ts: result.ts,
    });
  });

  it("invites a mentioned teammate into this job's channel on request", async () => {
    const { channel, thread, job } = await running("Invite teammate");
    const before = h.slack.callsTo("conversations.invite").length;
    expect(h.slack.members[channel.id] ?? []).not.toContain("UTEAMMATE");
    await sayInChannel(h, channel.id, "fixture-invite <@UTEAMMATE>");
    await until(() => h.slack.members[channel.id]?.includes("UTEAMMATE"), {
      label: "teammate invited",
    });
    await workerAdvance(h, thread, finishedSteps());
    await waitForJobStatus(h.sql, job.id, "done");
    await settle(h);
    expect(
      h.slack
        .callsTo("conversations.invite")
        .slice(before)
        .map((call) => call.body),
    ).toEqual([{ channel: channel.id, users: "UTEAMMATE" }]);
  });

  it("adopts an existing conversation channel for a new job", async () => {
    const c = newConversation(h);
    const before = h.slack.codeChannels.length;
    await c.mention(`<@${BOT}> move this to a code channel`);
    const channel = await until(() => h.slack.codeChannels[before], {
      label: "conversation channel",
    });
    await sayInChannel(h, channel.id, briefMention("Adopted job").replace(`<@${BOT}> `, ""));
    const proposal = await until(
      () =>
        h.slack.messages.find(
          (m) => m.channel === channel.id && /Want me to start/.test(messageText(m)),
        ),
      { label: "Start in channel" },
    );
    const start = hitlControls(proposal.blocks ?? []).find((c) => c.label === "Start");
    if (!start?.value) throw new Error("missing Start");
    await clickButton(h, proposal, start.actionId, start.value);
    const job = await until(
      async () =>
        (
          await h.sql<
            { id: number }[]
          >`select id::int from jobs where slack_channel = ${channel.id} and code_channel`
        )[0],
      { label: "adopted job" },
    );
    const ref = `J-${job.id}`;
    const thread = await until(() => threadsOf(h, ref)[0], { label: "adopted worker" });
    await workerAdvance(h, thread, finishedSteps());
    await waitForJobStatus(h.sql, job.id, "done");
    expect(h.slack.codeChannels).toHaveLength(before + 1);
  });
});
