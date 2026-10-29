import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLOSE_ACTION_ID } from "../../lib/jobs/card.ts";
import {
  clickButton,
  finishedSteps,
  type Harness,
  newConversation,
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
});
