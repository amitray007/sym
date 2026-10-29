import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLOSE_ACTION_ID } from "../../lib/jobs/card.ts";
import {
  clickButton,
  contractMessage,
  finishedSteps,
  type Harness,
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

// Code channels end to end (decision 067): with SYM_CODE_CHANNELS on, a started job moves from its
// thread into its own Slack code channel, posts its card and result there, and Close archives the
// channel with the result as its summary.

let h: Harness;

beforeAll(async () => {
  h = await startHarness({ database: "sym_e2e_code_channels", env: { SYM_CODE_CHANNELS: "on" } });
  await h.startEve();
});

afterAll(async () => {
  h?.writeReport();
  await h?.close();
});

describe("code channels", () => {
  it("runs a started job in its own channel and archives it on Close", async () => {
    const c = newConversation(h);
    const { approval, job, ref } = await startJob(h, c, "Channel job");
    await c.click(approval, "Start");

    const channel = await until(
      () => h.slack.codeChannels.find((cc) => cc.sessionId === `sym-${ref}`),
      {
        label: `${ref} code channel`,
      },
    );
    expect(channel.originChannel).toBe(c.channel);
    expect(channel.contextBar).toContainEqual({ key: "job", label: ref, icon: "code" });

    const thread = await until(() => threadsOf(h, ref)[0], { label: `${ref} worker thread` });
    await workerAdvance(h, thread, finishedSteps());
    const done = await waitForJobStatus(h.sql, job.id, "done");
    expect(done).toMatchObject({
      slackChannel: channel.id,
      slackThreadTs: null,
      codeChannel: true,
    });

    const headline = new RegExp(`^(✅|⚠️) \\*${ref} · `);
    const result = await until(
      () => h.slack.messages.find((m) => m.channel === channel.id && headline.test(m.text ?? "")),
      { label: `${ref} result in the code channel` },
    );
    // The result is a top-level post: the channel is the job's whole conversation.
    expect(result.thread_ts).toBeUndefined();
    await until(() => (channel.statuses.at(-1) === "active" ? true : undefined), {
      label: `${ref} channel status active`,
    });
    expect(channel.statuses[0]).toBe("processing");

    // Anything said in the channel reaches Sym with no tag, about this job.
    const asked = await sayInChannel(h, channel.id, "what's the update?");
    const answer = await until(
      () =>
        h.slack.messages.find(
          (m) =>
            m.channel === channel.id &&
            m.user === "UBOT" &&
            Number(m.ts) > Number(asked.ts) &&
            (m.text ?? m.markdown_text ?? JSON.stringify(m.blocks ?? "")).includes(ref),
        ),
      { label: "Sym's answer in the code channel", timeoutMs: 60_000 },
    );
    expect(answer).toBeDefined();

    await clickButton(h, result, CLOSE_ACTION_ID, ref);
    await until(() => (channel.archived ? true : undefined), { label: `${ref} archived` });
    expect(channel.summaryTs).toBe(result.ts);
    await settle(h);
    // Nothing about the job posted in the old thread after Start.
    expect(c.botMessages().some((m) => headline.test(m.text ?? ""))).toBe(false);
  });

  it("links a worker question from the channel to the thread where Eve asks it", async () => {
    const c = newConversation(h);
    const { approval, job, ref } = await startJob(h, c, "Question in channel");
    await c.click(approval, "Start");
    const channel = await until(
      () => h.slack.codeChannels.find((cc) => cc.sessionId === `sym-${ref}`),
      { label: `${ref} code channel` },
    );
    const thread = await until(() => threadsOf(h, ref)[0], { label: `${ref} worker thread` });
    await workerAdvance(h, thread, [
      {
        status: "waiting",
        items: ["I need to know the target."],
        questions: [
          {
            requestId: "req-env",
            questions: [
              {
                id: "q-env",
                header: "Target",
                question: "Which environment?",
                options: [
                  { label: "staging", description: "Safe" },
                  { label: "production", description: "Careful" },
                ],
              },
            ],
          },
        ],
      },
    ]);

    // The channel says where to answer, and its status waits on a person.
    await until(
      () =>
        h.slack.messages.find(
          (m) =>
            m.channel === channel.id &&
            (m.text ?? "").includes(`${ref} has a question: Which environment?`),
        ),
      { label: "the question link in the channel" },
    );
    await until(() => (channel.statuses.includes("suspended") ? true : undefined), {
      label: "status suspended",
    });

    // A message in the channel runs a brain turn; the channel still waits on the question after it.
    const asked = await sayInChannel(h, channel.id, "what is it waiting on?");
    await until(
      () =>
        h.slack.messages.find(
          (m) => m.channel === channel.id && m.user === "UBOT" && Number(m.ts) > Number(asked.ts),
        ),
      { label: "Sym's answer in the channel" },
    );
    await settle(h);
    await until(() => (channel.statuses.at(-1) === "suspended" ? true : undefined), {
      label: "status still suspended after the brain's turn",
    });

    // Eve asks in the thread where the job started; the answer reaches the worker.
    const question = await c.waitForControls(/Which environment\?/);
    await c.click(question, "staging");
    await until(() => thread.answers[0], { label: "the answer on the worker thread" });
    await until(() => (channel.statuses.at(-1) === "processing" ? true : undefined), {
      label: "status back to processing",
    });

    await workerAdvance(h, thread, finishedSteps());
    await waitForJobStatus(h.sql, job.id, "done");
  });

  it("keeps the old thread's buttons working, runs a Fix in the channel, and retries Close", async () => {
    const reconcile = async () => {
      const response = await fetch(`${h.eveUrl()}/eve/v1/dev/schedules/reconcile`, {
        method: "POST",
      });
      if (!response.ok) throw new Error(`reconcile answered ${response.status}`);
    };
    const c = newConversation(h);
    const { approval, job, ref } = await startJob(h, c, "Fix in channel");
    const briefPost = c
      .botMessages()
      .find((m) => JSON.stringify(m.blocks ?? []).includes("sym_job_brief"));
    if (!briefPost) throw new Error(`${ref} has no brief post`);
    await c.click(approval, "Start");
    const channel = await until(
      () => h.slack.codeChannels.find((cc) => cc.sessionId === `sym-${ref}`),
      { label: `${ref} code channel` },
    );

    // Full brief still answers in the thread the job moved out of.
    const before = h.slack.ephemerals.length;
    await clickButton(h, briefPost, "sym_job_brief", ref);
    const brief = await until(() => h.slack.ephemerals.slice(before)[0], {
      label: "the full brief",
    });
    expect(messageText(brief)).not.toContain("There is no job");
    expect(messageText(brief)).toContain(ref);

    const thread = await until(() => threadsOf(h, ref)[0], { label: `${ref} worker thread` });
    await workerAdvance(h, thread, finishedSteps());
    await waitForJobStatus(h.sql, job.id, "done");
    const inChannel = (pattern: RegExp) =>
      until(
        () => h.slack.messages.find((m) => m.channel === channel.id && pattern.test(m.text ?? "")),
        { label: `a channel post matching ${pattern}` },
      );
    const result = await inChannel(new RegExp(`^(✅|⚠️) \\*${ref} · `));

    // Fix: the text box posts in the channel, and the follow-up shares it.
    await clickButton(h, result, "sym_job_fix", ref);
    const fixBox = await until(
      () =>
        h.slack.messages.find(
          (m) =>
            m.channel === channel.id && JSON.stringify(m.blocks ?? []).includes("sym_job_fix_text"),
        ),
      { label: "the Fix box" },
    );
    await clickButton(h, fixBox, "sym_job_fix_text", "also log each retry", {
      blockId: `fix-${ref}`,
      actionType: "plain_text_input",
    });
    const [child] = await until(
      async () => {
        const rows = await h.sql<{ id: number; codeChannel: boolean; slackChannel: string }[]>`
          select id::int, code_channel, slack_channel from jobs where parent_job_id = ${job.id}
        `;
        return rows.length > 0 ? rows : undefined;
      },
      { label: "the follow-up job" },
    );
    expect(child).toMatchObject({ codeChannel: true, slackChannel: channel.id });
    const childRef = `J-${child?.id}`;
    await until(() => (channel.statuses.at(-1) === "processing" ? true : undefined), {
      label: "the channel working on the follow-up",
    });

    // Reconcile drives the follow-up to its result and sets the channel back to active.
    await h.sql`update jobs set watch_until = now() - interval '1 second' where id = ${Number(child?.id)}`;
    thread.steps.push({
      status: "completed",
      items: [contractMessage({ ...SAMPLE_CONTRACT, summary: "Logged each retry." })],
    });
    await reconcile();
    await waitForJobStatus(h.sql, Number(child?.id), "done");
    const childResult = await inChannel(new RegExp(`^(✅|⚠️) \\*${childRef} · `));
    await until(() => (channel.statuses.at(-1) === "active" ? true : undefined), {
      label: "the channel active after the follow-up",
    });

    // A failed archive on Close is retried by the next Close, with the result as the summary.
    h.slack.failNext("agents.conversations.archive", "internal_error");
    await clickButton(h, childResult, "sym_job_close", childRef);
    await until(
      async () =>
        (
          await h.sql`select 1 from jobs where id = ${Number(child?.id)} and closed_at is not null`
        )[0],
      { label: "the closed follow-up" },
    );
    await settle(h);
    expect(channel.archived).toBe(false);
    // Close took its button off the result, so Sym posts a new one to try again.
    const retry = await inChannel(/could not archive this channel/);
    expect(JSON.stringify(retry.blocks)).toContain("sym_job_close");
    await clickButton(h, retry, "sym_job_close", childRef);
    await until(() => (channel.archived ? true : undefined), { label: "the retried archive" });
    expect(channel.summaryTs).toBe(childResult.ts);
  });
});
