import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FakeSlackMessage } from "../fakes/slack-server.ts";
import {
  BOT,
  briefMention,
  type Conversation,
  contractMessage,
  finishedSteps,
  type Harness,
  isCard,
  jobInThread,
  launchesOf,
  messageText,
  newConversation,
  OWNER,
  resultMessage,
  SAMPLE_CONTRACT,
  settle,
  startHarness,
  startJob,
  threadsOf,
  until,
  waitForJobStatus,
  workerAdvance,
} from "./harness.ts";

// Milestone 1 end to end (docs/milestone-1.md, exit criteria). One `eve dev` server with the
// fixture brain, fake T3, fake Slack, and a fresh database. Each scenario uses its own channel.

let h: Harness;

beforeAll(async () => {
  h = await startHarness({ database: "sym_e2e" });
  await h.startEve();
});

afterAll(async () => {
  h?.writeReport();
  await h?.close();
});

const newSince = (c: Conversation, before: string[]): FakeSlackMessage[] =>
  c.botMessages().filter((m) => !before.includes(m.ts));

describe("milestone 1", () => {
  it("refuses a brief for a project outside SYM_PROJECTS without a job or a launch", async () => {
    const refused = newConversation(h);
    const jobsBefore = (await h.sql`select count(*)::int as n from jobs`)[0]?.n;
    await refused.mention(briefMention("Other repo work", { project: "other-repo" }));
    // A later allowed brief proves the server handled the refused one first.
    const allowed = newConversation(h);
    await allowed.mention(briefMention("Allowed work"));
    await allowed.waitForControls(/Start J-\d+:/);
    await settle(h);

    const jobs = await h.sql<{ title: string }[]>`select title from jobs order by id`;
    expect(jobs.map((job) => job.title)).not.toContain("Other repo work");
    expect(jobs).toHaveLength((jobsBefore ?? 0) + 1);
    expect(h.t3.calls.filter((call) => call.name === "t3_thread_launch")).toHaveLength(0);
    // The refused brief never reached the worker, not even for a project lookup.
    expect(JSON.stringify(h.t3.calls)).not.toContain("other-repo");
    expect(refused.botMessages().some((m) => isCard(m))).toBe(false);
  });

  it("brief, Start, one card edited in place, one result", async () => {
    const c = newConversation(h);
    const { approval, job, ref } = await startJob(h, c, "Sync retry");
    expect(job.status).toBe("launching");
    expect(approval.controls.map((control) => control.label)).toEqual(["Start", "Edit", "Cancel"]);
    // Eve's prompt card is short, so the full brief is Sym's own message above it.
    const brief = c.botMessages().find((m) => messageText(m).includes("*goal* Add retry"));
    expect(brief && messageText(brief)).toContain("*done when*");
    const beforeStart = c.botMessages().map((m) => m.ts);

    await c.click(approval, "Start");
    const thread = await until(() => threadsOf(h, ref)[0], { label: `${ref} worker thread` });
    const card = await until(() => c.botMessages().find(isCard), { label: `${ref} job card` });

    await workerAdvance(h, thread, [{ status: "running", items: ["Writing the retry loop"] }]);
    await until(
      () =>
        h.slack
          .callsTo("chat.update")
          .some(
            (call) => call.body.ts === card.ts && JSON.stringify(call.body).includes("retry loop"),
          )
          ? true
          : undefined,
      { label: "a card edit with the worker's progress" },
    );
    await workerAdvance(h, thread, finishedSteps());
    const done = await waitForJobStatus(h.sql, job.id, "done");
    const result = await resultMessage(c, ref);
    await settle(h);

    // Exactly one worker thread, and one launch call.
    expect(threadsOf(h, ref)).toHaveLength(1);
    expect(launchesOf(h, ref)).toHaveLength(1);
    // The launch carries the default model (SYM_WORKER_MODEL), and the job records it.
    expect(launchesOf(h, ref)[0]?.args.modelSelection).toEqual({
      instanceId: "fake",
      model: "fake-model",
    });
    expect(done.workerModel).toBe("fake/fake-model");
    // The thread got one new message at the start (the card) and one at the end (the result).
    expect(newSince(c, beforeStart).map((m) => m.ts)).toEqual([card.ts, result.ts]);
    // Card progress went only through chat.update on the card, and the card ends collapsed.
    const cardEdits = h.slack.callsTo("chat.update").filter((call) => call.body.ts === card.ts);
    expect(cardEdits.length).toBeGreaterThanOrEqual(2);
    expect(messageText(card)).toContain(`[${ref}] Sync retry · Done`);
    expect(isCard(card)).toBe(false);
    // The result carries the summary and the PR link.
    expect(result.text).toContain(SAMPLE_CONTRACT.summary);
    expect(result.text).toContain(SAMPLE_CONTRACT.pr_url);
    expect(done.prUrl).toBe(SAMPLE_CONTRACT.pr_url);
    expect(done.lastMessage).toContain(SAMPLE_CONTRACT.summary);
    // The verifier subagent checked the result before it posted (flow 4, decision 032).
    expect(result.text).toContain("✅ verifier: matches the brief (90% sure)");
    expect(result.text).not.toContain("check before merge");
    // Decision 043: the worker has its label, and no Slack call names the software behind it.
    const slackBodies = JSON.stringify(h.slack.calls.map((call) => call.body));
    expect(slackBodies).toContain("Builder thread");
    expect(slackBodies).not.toMatch(/\bT3\b/i);
  });

  it("the verifier's verdict joins a rule-check concern in the one result message", async () => {
    const c = newConversation(h);
    // The brief allows no pull request, and the worker opens one anyway.
    await c.mention(briefMention("No PR job", { openPullRequest: false }));
    const approval = await c.waitForControls(/Start J-\d+:/);
    const job = await jobInThread(h.sql, c.channel, c.rootTs);
    const ref = `J-${job.id}`;
    await c.click(approval, "Start");
    const thread = await until(() => threadsOf(h, ref)[0], { label: `${ref} worker thread` });
    // The card posts just after the launch. Wait for it, so it does not count as a new message.
    await until(() => c.botMessages().find(isCard), { label: `${ref} job card` });
    const before = c.botMessages().map((m) => m.ts);

    await workerAdvance(h, thread, [
      { status: "completed", items: [contractMessage(SAMPLE_CONTRACT)] },
    ]);
    await waitForJobStatus(h.sql, job.id, "done");
    const result = await resultMessage(c, ref);
    await settle(h);

    expect(newSince(c, before).map((m) => m.ts)).toEqual([result.ts]);
    const concern = "The worker opened a pull request the job did not allow.";
    expect(result.text).toContain("*⚠️ check before merge* (60% sure)");
    expect(result.text).toContain(`*⚠️ check before merge* (60% sure)\n1. ${concern}`);
    // The fixture verifier repeats the rule-check concern; the message lists it once.
    expect(result.text?.split(concern)).toHaveLength(2);
  });

  it("a lost launch response does not start a second worker thread", async () => {
    const c = newConversation(h);
    const { approval, job, ref } = await startJob(h, c, "Lost launch");
    h.t3.dropNextResponse("t3_thread_launch");

    await c.click(approval, "Start");
    const running = await waitForJobStatus(h.sql, job.id, "running", 120_000);
    const thread = await until(() => threadsOf(h, ref)[0], { label: `${ref} worker thread` });
    await workerAdvance(h, thread, finishedSteps());
    await waitForJobStatus(h.sql, job.id, "done");
    await resultMessage(c, ref);
    await settle(h);

    // The launch ran once and its answer was lost. The re-run step found the thread by its
    // title and adopted it instead of launching again.
    expect(launchesOf(h, ref)).toHaveLength(1);
    expect(threadsOf(h, ref)).toHaveLength(1);
    const lookups = h.t3.calls.filter(
      (call) => call.name === "t3_thread_list" && call.args.titleContains === `[${ref}]`,
    );
    expect(lookups.length).toBeGreaterThanOrEqual(2);
    expect(running.workerThreadId).toBe(thread.threadId);
    expect(c.botMessages().filter(isCard)).toHaveLength(0); // collapsed by now
    expect(
      h.slack.messages.filter(
        (m) => m.channel === c.channel && messageText(m).includes(`[${ref}]`),
      ),
    ).toHaveLength(1);
  });

  it("a worker question becomes Slack buttons and the answer reaches the worker", async () => {
    const c = newConversation(h);
    const { approval, job, ref } = await startJob(h, c, "Question job");
    await c.click(approval, "Start");
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
    const question = await c.waitForControls(/Which environment\?/);
    expect(question.controls.map((control) => control.label)).toEqual(
      expect.arrayContaining(["staging", "production"]),
    );
    await waitForJobStatus(h.sql, job.id, "waiting_input");

    await c.click(question, "staging");
    await until(() => thread.answers[0], { label: "the answer on the worker thread" });
    expect(thread.answers).toEqual([{ requestId: "req-env", answers: { "q-env": "staging" } }]);

    await workerAdvance(h, thread, finishedSteps());
    await waitForJobStatus(h.sql, job.id, "done");
    await resultMessage(c, ref);
  });

  it("a permission block sends exactly one DM to the owner", async () => {
    const c = newConversation(h);
    const { approval, job, ref } = await startJob(h, c, "Permission job");
    await c.click(approval, "Start");
    const thread = await until(() => threadsOf(h, ref)[0], { label: `${ref} worker thread` });

    // Waiting with no question: a permission prompt on the worker.
    await workerAdvance(h, thread, [{ status: "waiting" }]);
    await waitForJobStatus(h.sql, job.id, "waiting_permission");
    const dms = () =>
      h.slack.messages.filter((m) => m.channel === OWNER && (m.text ?? "").includes(ref));
    await until(() => dms()[0], { label: "the permission DM" });
    // More checks see the same block. None of them posts again.
    const waits = () => h.t3.calls.filter((call) => call.name === "t3_thread_wait").length;
    const checksBefore = waits();
    await until(() => (waits() >= checksBefore + 2 ? true : undefined), {
      label: "two more checks",
      timeoutMs: 30_000,
    });
    expect(dms()).toHaveLength(1);
    expect(dms()[0]?.text).toContain("permission prompt");
    expect(c.botMessages().some((m) => (m.text ?? "").includes("permission prompt"))).toBe(false);

    await workerAdvance(h, thread, finishedSteps());
    await waitForJobStatus(h.sql, job.id, "done");
    await resultMessage(c, ref);
    expect(dms()).toHaveLength(1);
  });

  it("answers what's the update in the job thread from jobs_status", async () => {
    const c = newConversation(h);
    const { approval, job, ref } = await startJob(h, c, "Status job");
    await c.click(approval, "Start");
    const thread = await until(() => threadsOf(h, ref)[0], { label: `${ref} worker thread` });
    await workerAdvance(h, thread, [{ status: "running", items: ["Running the test suite"] }]);
    await until(
      async () => {
        const [row] = await h.sql<{ lastSummary: string | null }[]>`
          select last_summary from jobs where id = ${job.id}`;
        return row?.lastSummary === "Running the test suite" ? true : undefined;
      },
      { label: "the job's summary" },
    );

    const before = c.botMessages().map((m) => m.ts);
    await c.reply(`<@${BOT}> what's the update?`);
    const answer = await until(
      () => newSince(c, before).find((m) => messageText(m).includes(`${ref} Status job`)),
      { label: "the status answer", timeoutMs: 60_000 },
    );
    expect(messageText(answer)).toContain(`${ref} Status job: running`);
    expect(messageText(answer)).toContain("Running the test suite");

    await workerAdvance(h, thread, finishedSteps());
    await waitForJobStatus(h.sql, job.id, "done");
    await resultMessage(c, ref);
  });

  it("Edit asks for the changes and hands them back without launching", async () => {
    const c = newConversation(h);
    const { approval, job, ref } = await startJob(h, c, "Edited job");

    await c.click(approval, "Edit");
    const ask = await c.waitForPrompt(new RegExp(`What should change in ${ref}`));
    expect(ask).toBeDefined();
    await c.reply("Only touch the retry module, and keep the batch size.");
    const closed = await waitForJobStatus(h.sql, job.id, "cancelled");

    expect(closed.lastSummary).toBe("Brief edited");
    expect(launchesOf(h, ref)).toHaveLength(0);
  });

  it("Cancel before start launches nothing and posts no card", async () => {
    const c = newConversation(h);
    const { approval, job, ref } = await startJob(h, c, "Cancelled job");
    const before = c.botMessages().map((m) => m.ts);

    await c.click(approval, "Cancel");
    const cancelled = await waitForJobStatus(h.sql, job.id, "cancelled");
    await settle(h);

    expect(launchesOf(h, ref)).toHaveLength(0);
    expect(threadsOf(h, ref)).toHaveLength(0);
    expect(cancelled.workerThreadId).toBeNull();
    expect(c.botMessages().filter(isCard)).toHaveLength(0);
    expect(newSince(c, before)).toEqual([]);
  });
});
