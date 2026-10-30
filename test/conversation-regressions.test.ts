import { afterEach, describe, expect, it, vi } from "vitest";
import { takeChoice } from "../lib/delivery/choices.ts";
import { deliver } from "../lib/delivery/deliver.ts";
import { Brief } from "../lib/jobs/brief.ts";
import { closeJob, proposeFollowUp, retryClosures } from "../lib/jobs/followup.ts";
import { presentBrief } from "../lib/jobs/present.ts";
import { reconcileJobs } from "../lib/jobs/reconcile.ts";
import { checkJob, type JobDeps, launchOrAdopt } from "../lib/jobs/run.ts";
import { choiceBlocks, storeChoices } from "../lib/ledger/choices.ts";
import { createJob, getJob, json, updateJob } from "../lib/ledger/jobs.ts";
import type { JobProposal } from "../lib/ledger/proposals.ts";
import { SlackApiError } from "../lib/slack/api.ts";
import { handleProposal } from "../lib/slack/job-actions.ts";
import { FakeWorker } from "./fakes/worker.ts";
import { hasDatabase, useLedger } from "./helpers/ledger.ts";
import { TEST_PROJECTS } from "./helpers/projects.ts";

const brief = Brief.parse({
  project: "test-repo",
  title: "Retry",
  goal: "add retries",
  doneWhen: ["Tests pass"],
});
const allowed = (by: string) => by === "U1";

describe.skipIf(!hasDatabase)("conversation recovery regressions", () => {
  const ledger = useLedger();
  afterEach(() => vi.unstubAllEnvs());
  let seq = 0;
  async function setup(key: string, completed = false) {
    const sql = ledger.sql();
    const calls: { method: string; body: Record<string, unknown> }[] = [];
    const slack = {
      async call(method: string, body: Record<string, unknown>) {
        calls.push({ method, body });
        return { ok: true, ts: body.ts ?? `9.${++seq}` };
      },
    };
    const worker = new FakeWorker({
      script: [
        { status: "completed", items: ['```json\n{"summary":"done","tests":"passed"}\n```'] },
      ],
    });
    const deps: JobDeps = {
      sql,
      slack,
      worker,
      workerIdentity: "worker-one",
      allowedProjects: TEST_PROJECTS,
    };
    const job = await createJob(sql, {
      requestKey: key,
      title: brief.title,
      brief,
      kind: "code-change",
      worker: "fake",
      owner: "U1",
      slackChannel: "C1",
      slackThreadTs: key,
    });
    if (completed) {
      await launchOrAdopt(deps, job.id, "http://127.0.0.1/cb");
      await checkJob(deps, job.id, 1);
    }
    const current = await getJob(sql, job.id);
    if (!current) throw new Error("Missing job");
    return { sql, calls, slack, worker, deps, job: current };
  }
  const decide = async (s: Awaited<ReturnType<typeof setup>>, start: boolean) => {
    const [p] = await s.sql<
      JobProposal[]
    >`select * from job_proposals where job_id = ${s.job.id} and status = 'pending'`;
    if (!p) throw new Error("missing proposal");
    return handleProposal(
      s.deps,
      { id: String(p.id), by: "U1", channel: "C1", threadTs: s.job.slackThreadTs, start },
      allowed,
    );
  };

  it("keeps Start valid across bookkeeping updates but expires a changed brief", async () => {
    const s = await setup("unchanged-brief");
    await presentBrief(s.sql, s.job);
    await updateJob(s.sql, s.job.id, { lastSummary: "Waiting" });
    expect(await decide(s, true)).toMatchObject({ kind: "accepted" });
    const changed = await setup("changed-brief");
    await presentBrief(changed.sql, changed.job);
    await changed.sql`update jobs set brief = brief || '{"goal":"delete retries"}' where id = ${changed.job.id}`;
    expect(await decide(changed, true)).toMatchObject({ kind: "stale" });
  });

  it.each([false, true])(
    "cancels Not now without a live task, reconcile after decision: %s",
    async (reconcile) => {
      const s = await setup(`dismiss-${reconcile}`);
      await presentBrief(s.sql, s.job);
      await decide(s, false);
      expect((await getJob(s.sql, s.job.id))?.status).toBe("cancelled");
      if (reconcile) await reconcileJobs(s.deps);
      expect((await getJob(s.sql, s.job.id))?.status).toBe("cancelled");
      expect(s.worker.launches).toBe(0);
    },
  );

  it("closes a recovered accepted Start rejected by current policy and tells its approver", async () => {
    vi.stubEnv("SYM_SLACK_USERS", "U1");
    const s = await setup("invalid-recovered-start");
    await presentBrief(s.sql, s.job);
    await decide(s, true);
    await s.sql`insert into job_start_callbacks (job_id, callback_url) values (${s.job.id}, 'http://127.0.0.1/cb')`;
    await s.sql`update job_proposals set created_at = now() - interval '2 minutes' where job_id = ${s.job.id}`;
    await reconcileJobs({ ...s.deps, allowedProjects: [] });
    expect(await getJob(s.sql, s.job.id)).toMatchObject({
      status: "cancelled",
      lastSummary: expect.stringContaining("no projects configured"),
    });
    expect(
      s.calls.some(
        (c) =>
          c.method === "chat.postMessage" &&
          c.body.channel === "U1" &&
          String(c.body.text).includes("no projects configured"),
      ),
    ).toBe(true);
  });

  it("retries only a failed follow-up send and waits for a new assistant result", async () => {
    vi.stubEnv("SYM_SLACK_USERS", "U1");
    const s = await setup("send-failure", true);
    await proposeFollowUp(s.deps, `J-${s.job.id}`, "can you add a test?", "send-failure");
    const send = vi.spyOn(s.worker, "send").mockRejectedValue(new Error("offline"));
    await expect(decide(s, true)).rejects.toThrow("could not start");
    const [child] = await s.sql<
      { id: number }[]
    >`select id from jobs where parent_job_id = ${s.job.id}`;
    const id = Number(child?.id);
    await s.sql`update jobs set watch_until = null where id = ${id}`;
    await reconcileJobs(s.deps);
    expect((await getJob(s.sql, id))?.status).not.toMatch(/done|failed|cancelled/);
    expect(
      await s.sql`select id from outbox where idempotency_key = ${`J-${id}:end`}`,
    ).toHaveLength(0);
    send.mockRestore();
    await reconcileJobs(s.deps);
    await s.sql`update jobs set watch_until = null where id = ${id}`;
    await reconcileJobs(s.deps);
    expect((await getJob(s.sql, id))?.status).toBe("running");
    expect(s.worker.sends).toHaveLength(1);
    const read = vi.spyOn(s.worker, "readActivity").mockResolvedValue({
      status: "completed",
      items: [
        {
          type: "assistant_message",
          position: 2,
          text: '```json\n{"summary":"new result","tests":"passed"}\n```',
        },
      ],
      cursor: "2",
      hasMore: false,
      pendingRequests: 0,
    });
    await s.sql`update jobs set watch_until = null where id = ${id}`;
    await reconcileJobs(s.deps);
    expect(await getJob(s.sql, id)).toMatchObject({
      status: "done",
      lastMessage: expect.stringContaining("new result"),
    });
    expect(s.worker.sends).toHaveLength(1);
    read.mockRestore();
  });

  it("archives while settlement is offline and holds no row lock during either external call", async () => {
    const s = await setup("offline-close", true);
    await s.sql`update jobs set code_channel = true, slack_thread_ts = null where id = ${s.job.id}`;
    const lockProbe = () =>
      s.sql.begin(async (tx) => {
        await tx`set local lock_timeout = '200ms'`;
        await tx`select id from jobs where id = ${s.job.id} for update`;
      });
    let settlementUnlocked = false;
    vi.spyOn(s.worker, "settle").mockImplementation(async () => {
      await lockProbe();
      settlementUnlocked = true;
      throw new Error("offline");
    });
    const slack = {
      async call(method: string, body: Record<string, unknown>) {
        if (method === "agents.conversations.archive") await lockProbe();
        return s.slack.call(method, body);
      },
    };
    const answer = await closeJob({ ...s.deps, slack }, `J-${s.job.id}`, "U1");
    expect(settlementUnlocked).toBe(true);
    expect(answer).toContain("archived");
    expect(answer).toContain("retry");
    expect(await getJob(s.sql, s.job.id)).toMatchObject({
      archiveState: "archived",
      workerSettledAt: null,
    });
    vi.mocked(s.worker.settle).mockRestore();
    await retryClosures({ ...s.deps, slack });
    expect((await getJob(s.sql, s.job.id))?.workerSettledAt).not.toBeNull();
    expect(s.calls.filter((c) => c.method === "agents.conversations.archive")).toHaveLength(1);
  });

  it("replaces stale archive retry facts in the result after recovery", async () => {
    const s = await setup("archive-result-retry", true);
    const ref = `J-${s.job.id}`;
    await s.sql`update jobs set code_channel = true, slack_thread_ts = null where id = ${s.job.id}`;
    let failed = false;
    const slack = {
      async call(method: string, body: Record<string, unknown>) {
        if (method === "agents.conversations.archive" && !failed) {
          failed = true;
          throw new SlackApiError(method, "internal_error");
        }
        return s.slack.call(method, body);
      },
    };
    await closeJob({ ...s.deps, slack }, ref, "U1");
    const pending = s.calls.filter((call) => call.method === "chat.update").at(-1);
    expect(pending?.body.text).toContain("couldn't archive");
    await retryClosures({ ...s.deps, slack });
    await deliver(s.sql, slack);
    const recovered = s.calls.filter((call) => call.method === "chat.update").at(-1);
    expect(recovered?.body.text).toContain("I've closed this and archived its channel.");
    expect(recovered?.body.text).toContain("done");
    expect(recovered?.body.text).not.toContain("couldn't archive");
    expect(JSON.stringify(recovered?.body.blocks)).not.toContain("I'll retry");
  });

  it("preserves result controls and actor notes across choice and Close edits, and expires choices", async () => {
    const s = await setup("choice-controls", true);
    const ref = `J-${s.job.id}`;
    const stored = await storeChoices(s.sql, {
      key: "result-choice",
      jobId: s.job.id,
      channel: "C1",
      threadTs: s.job.slackThreadTs,
      message: "Result",
      choices: ["Explain", "Wait"],
    });
    const kept = [
      { type: "markdown", text: "Full result" },
      { type: "context", elements: [{ type: "mrkdwn", text: `${ref} · 2m` }] },
      {
        type: "actions",
        elements: [
          { action_id: "sym_job_pr", url: "https://example.com/pr" },
          { action_id: "sym_job_ci", url: "https://example.com/ci" },
          { action_id: "sym_feedback", value: "yes" },
        ],
      },
    ];
    await s.sql`update outbox set payload = ${json(s.sql, { channel: "C1", text: "Full result", blocks: [...kept, ...choiceBlocks(stored)] })} where idempotency_key = ${`${ref}:end`}`;
    const [end] = await s.sql<
      { slackTs: string }[]
    >`select slack_ts from outbox where idempotency_key = ${`${ref}:end`}`;
    await s.sql`update conversation_choices set message_ts = ${end?.slackTs ?? ""} where id = ${stored.id}::bigint`;
    await takeChoice(
      { sql: s.sql, slack: s.slack, allowed },
      { value: `${stored.id}:0`, channel: "C1", messageTs: end?.slackTs ?? "", user: "U1" },
      async () => {},
    );
    const edit = s.calls.filter((c) => c.method === "chat.update").at(-1);
    expect(edit?.body.blocks).toEqual([
      ...kept,
      { type: "context", elements: [{ type: "mrkdwn", text: "<@U1> chose: Explain" }] },
    ]);
    const open = await storeChoices(s.sql, {
      key: "open-choice",
      jobId: s.job.id,
      channel: "C1",
      threadTs: s.job.slackThreadTs,
      message: "Next?",
      choices: ["One", "Two"],
    });
    await closeJob(s.deps, ref, "U1");
    const closed = s.calls.filter((c) => c.method === "chat.update").at(-1);
    expect(JSON.stringify(closed?.body.blocks)).toContain("<@U1> chose: Explain");
    expect(JSON.stringify(closed?.body.blocks)).not.toContain("sym_choice_");
    expect(
      (
        await s.sql`select expires_at <= now() as expired from conversation_choices where id = ${open.id}::bigint`
      )[0]?.expired,
    ).toBe(true);
  });

  it("removes unclicked result choices when Close edits the result", async () => {
    const s = await setup("unclicked-close", true);
    const ref = `J-${s.job.id}`;
    const choice = await storeChoices(s.sql, {
      key: "unclicked",
      jobId: s.job.id,
      channel: "C1",
      threadTs: s.job.slackThreadTs,
      message: "Result",
      choices: ["Explain", "Wait"],
    });
    await s.sql`update outbox set payload = payload || ${json(s.sql, { blocks: [{ type: "markdown", text: "Full result" }, ...choiceBlocks(choice)] })} where idempotency_key = ${`${ref}:end`}`;
    await closeJob(s.deps, ref, "U1");
    const edit = s.calls.filter((c) => c.method === "chat.update").at(-1);
    expect(JSON.stringify(edit?.body.blocks)).toContain("Full result");
    expect(JSON.stringify(edit?.body.blocks)).not.toContain("sym_choice_");
  });
  it("drops a threaded proposal whose root was deleted", async () => {
    const s = await setup("deleted-proposal");
    await presentBrief(s.sql, s.job);
    await deliver(s.sql, {
      async call(method, body) {
        if (method === "chat.getPermalink") throw new SlackApiError(method, "message_not_found");
        return s.slack.call(method, body);
      },
    });
    expect(s.calls.some((c) => c.method === "chat.postMessage")).toBe(false);
    expect((await s.sql`select status from outbox where job_id = ${s.job.id}`)[0]?.status).toBe(
      "failed",
    );
  });

  it("guards worker questions and keeps their mention-shaped text inert", async () => {
    const s = await setup("question-mentions");
    const worker = new FakeWorker({
      script: [
        {
          status: "waiting",
          questions: [
            {
              requestId: "ask",
              questions: [
                { id: "part", prompt: "Ask <!channel> and <@U1>", options: [], multiSelect: false },
              ],
            },
          ],
        },
      ],
    });
    const deps = { ...s.deps, worker };
    await launchOrAdopt(deps, s.job.id, "http://127.0.0.1/cb");
    await checkJob(deps, s.job.id, 1);
    const [question] = await s.sql<
      { payload: { text: string; sym_thread_reply: boolean } }[]
    >`select payload from outbox where starts_with(idempotency_key, ${`J-${s.job.id}:question:`})`;
    expect(question?.payload.text).not.toMatch(/<!|<@/);
    expect(question?.payload.sym_thread_reply).toBe(true);
  });
  it("uses grammatical proposal text for a question-shaped request", async () => {
    const s = await setup("proposal-grammar", true);
    await proposeFollowUp(s.deps, `J-${s.job.id}`, "can you add a test?", "proposal-grammar");
    const [p] = await s.sql`select message from job_proposals where job_id = ${s.job.id}`;
    expect(p?.message).toBe(
      "You asked: 'can you add a test?' I'd continue on the same branch. Should I start?",
    );
  });
});
