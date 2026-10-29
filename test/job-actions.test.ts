import { describe, expect, it } from "vitest";
import type { Sql } from "../lib/db.ts";
import { deliver } from "../lib/delivery/deliver.ts";
import type { Brief } from "../lib/jobs/brief.ts";
import { closeJob, retryClosures, startFollowUp } from "../lib/jobs/followup.ts";
import { jobsToWatch } from "../lib/jobs/pr-wakes.ts";
import { refOfPrompt } from "../lib/jobs/prompts.ts";
import { reconcileJobs } from "../lib/jobs/reconcile.ts";
import { checkJob, type JobDeps, launchOrAdopt, startJob } from "../lib/jobs/run.ts";
import { getJob, type Job } from "../lib/ledger/jobs.ts";
import { recordSessionThread } from "../lib/ledger/threads.ts";
import type { Pack } from "../lib/pack/load.ts";
import { packSchema } from "../lib/pack/schema.ts";
import { type SlackApi, SlackApiError } from "../lib/slack/api.ts";
import { handleJobAction, type JobAction } from "../lib/slack/job-actions.ts";
import { type FakeStep, FakeWorker } from "./fakes/worker.ts";
import { hasDatabase, useLedger } from "./helpers/ledger.ts";
import { TEST_PROJECTS } from "./helpers/projects.ts";

const PR = "https://github.com/example/app/pull/12";
const result = (summary: string) =>
  `Done.\n\`\`\`json\n${JSON.stringify({
    summary,
    pr_url: PR,
    tests: "ok",
    files_changed: ["src/a.ts"],
    open_questions: [],
  })}\n\`\`\``;

const brief: Brief = {
  project: "test-repo",
  title: "Retry",
  goal: "Add retry.",
  constraints: [],
  doneWhen: ["Tests pass"],
  openPullRequest: true,
  estimatedMinutes: 15,
};

const CHANNEL = "C1";

describe("prompt blocks", () => {
  it("put the job reference in the block ID and send on Enter", () => {
    expect(refOfPrompt("fix", "fix-J-7")).toBe("J-7");
    expect(refOfPrompt("steer", "fix-J-7")).toBeUndefined();
    expect(refOfPrompt("fix", "fix-J-7-x")).toBeUndefined();
  });
});

describe.skipIf(!hasDatabase)("job buttons", () => {
  const ledger = useLedger();
  let ts = 1;
  const posts: { method: string; body: Record<string, unknown> }[] = [];
  const slack: SlackApi = {
    async call(method, body) {
      posts.push({ method, body });
      return { ok: true, ts: (body.ts as string | undefined) ?? `1700000000.${ts++}` };
    },
  };

  // A finished job with a sent result message. `steps` script its worker thread: the first step
  // ends the job, later steps are what a follow-up turn does.
  async function finishedJob(key: string, steps: FakeStep[]) {
    const sql = ledger.sql();
    await recordSessionThread(sql, {
      sessionId: `s-${key}`,
      teamId: "T1",
      channelId: CHANNEL,
      threadTs: `1690000000.${key.length}`,
      userId: "U1",
    });
    const worker = new FakeWorker({ script: steps });
    const deps: JobDeps = {
      sql,
      worker,
      workerIdentity: "worker-one",
      allowedProjects: TEST_PROJECTS,
      slack,
    };
    const job = await startJob(sql, { requestKey: key, sessionId: `s-${key}`, brief });
    await launchOrAdopt(deps, job.id, "http://127.0.0.1/cb");
    await checkJob(deps, job.id, 1000);
    await deliver(sql, slack);
    return { deps, worker, job: (await getJob(sql, job.id)) as Job, sql };
  }

  const click = (deps: JobDeps, action: Partial<JobAction> & { actionId: string }) => {
    const replies: string[] = [];
    if (action.actionId === "sym_job_fix_text") {
      const ref = action.blockId?.replace(/^fix-/, "") ?? "";
      return startFollowUp(
        deps,
        ref,
        action.value ?? "",
        "U1",
        `${CHANNEL}:${action.messageTs}`,
      ).then((result) => ({ answer: result.answer, replies }));
    }
    return handleJobAction(deps, { user: { id: "U1" }, ...action }, CHANNEL, async (text) => {
      replies.push(text);
    }).then((answer) => ({ answer, replies }));
  };

  const outbox = (sql: Sql, prefix: string) =>
    sql<{ idempotencyKey: string; method: string; payload: Record<string, unknown> }[]>`
      select idempotency_key, method, payload from outbox
      where starts_with(idempotency_key, ${prefix}) order by id
    `;

  it("records Looks good once per person and result", async () => {
    const { deps, job, sql } = await finishedJob("ok", [
      { status: "completed", items: [result("A")] },
    ]);
    const ref = `J-${job.id}`;
    const first = await click(deps, { actionId: "sym_job_ok", value: ref, messageTs: "1.1" });
    await click(deps, { actionId: "sym_job_ok", value: ref, messageTs: "1.1" });
    expect(first.replies).toEqual([`Thanks, I recorded your feedback on ${ref}.`]);
    const rows = await sql`select kind, value from feedback where job_id = ${job.id}`;
    expect(rows).toEqual([{ kind: "thumbs_up", value: "looks_good" }]);
  });

  it("sends the full brief privately, escaped once, only in the job's channel", async () => {
    const { deps, job, sql } = await finishedJob("brief", [
      { status: "completed", items: [result("A")] },
    ]);
    const ref = `J-${job.id}`;
    await sql`update jobs set brief = brief || '{"goal": "Retry 5xx & 429."}' where id = ${job.id}`;
    const shown = await click(deps, { actionId: "sym_job_brief", value: ref });
    expect(shown.replies).toHaveLength(1);
    expect(shown.replies[0]).toContain(`${ref}: Retry 5xx &amp; 429.`);
    expect(shown.replies[0]).toContain("I'll check: Tests pass.");

    const elsewhere = await handleJobAction(
      deps,
      { actionId: "sym_job_brief", value: ref, user: { id: "U1" } },
      "C-other",
      async () => {},
    );
    expect(elsewhere).toBe(`There is no job ${ref}.`);
    expect((await click(deps, { actionId: "sym_job_brief", value: "J-99999" })).answer).toBe(
      "There is no job J-99999.",
    );
  });

  it("turns a Fix into a follow-up job on the same worker thread, which reconcile finishes", async () => {
    const { deps, worker, job, sql } = await finishedJob("fix", [
      { status: "completed", items: [result("First pass")] },
      { status: "completed", items: [result("Fixed the edge case")] },
    ]);
    const ref = `J-${job.id}`;

    await click(deps, { actionId: "sym_job_fix", value: ref });
    const [prompt] = await outbox(sql, `${ref}:fix-prompt:U1:`);
    expect(prompt).toBeUndefined();

    const sent = await click(deps, {
      actionId: "sym_job_fix_text",
      blockId: `fix-${ref}`,
      value: "Also cover the empty list.",
      messageTs: "1700000099.1",
    });
    const [child] = await sql<
      { id: number; parentJobId: number; workerThreadId: string; status: string; cursor: string }[]
    >`select id::int, parent_job_id::int, worker_thread_id, status, cursor from jobs where parent_job_id = ${job.id}`;
    expect(child).toMatchObject({
      parentJobId: job.id,
      workerThreadId: job.workerThreadId,
      status: "running",
      cursor: job.cursor,
    });
    const childRef = `J-${child?.id}`;
    expect(sent.answer).toBe(`Sent to the worker as ${childRef}.`);
    expect(worker.sends).toEqual([
      expect.objectContaining({ threadId: job.workerThreadId, mode: "auto" }),
    ]);
    expect(worker.sends[0]?.text).toContain("Also cover the empty list.");
    expect(worker.sends[0]?.text).toContain("Keep production systems and customer data read-only.");
    expect(await sql`select kind, value from feedback where job_id = ${job.id}`).toEqual([
      { kind: "fix", value: "Also cover the empty list." },
    ]);
    // A follow-up records the continuation on the parent's result.
    const [edit] = await outbox(sql, `${ref}:end-edit:`);
    expect(JSON.stringify(edit?.payload)).not.toContain("sym_job_fix");
    expect(JSON.stringify(edit?.payload)).toContain(`I sent the follow-up as ${childRef}`);

    // The same Enter again sends nothing new.
    const again = await click(deps, {
      actionId: "sym_job_fix_text",
      blockId: `fix-${ref}`,
      value: "Also cover the empty list.",
      messageTs: "1700000099.1",
    });
    expect(again.answer).toBe(`Already sent as ${childRef}.`);
    expect(worker.sends).toHaveLength(1);

    // A short lease keeps reconcile away until the send lands; then reconcile drives it.
    const [lease] = await sql<{ soon: boolean }[]>`
      select watch_until between now() and now() + interval '61 seconds' as soon
      from jobs where id = ${Number(child?.id)}
    `;
    expect(lease?.soon).toBe(true);
    await sql`update jobs set watch_until = now() - interval '1 second' where id = ${Number(child?.id)}`;
    await reconcileJobs(deps);
    const done = await getJob(sql, Number(child?.id));
    expect(done?.status).toBe("done");
    expect(done?.lastMessage).toContain("Fixed the edge case");
    const [end] = await outbox(sql, `${childRef}:end`);
    expect(JSON.stringify(end?.payload)).not.toContain("sym_job_fix");

    // The parent's thread now belongs to the follow-up: no second Fix or Close on the parent.
    const fixParent = await click(deps, { actionId: "sym_job_fix", value: ref });
    expect(fixParent.replies).toEqual([`${childRef} continued this thread. Use that job.`]);
    const closeParent = await click(deps, { actionId: "sym_job_close", value: ref });
    expect(closeParent.replies).toEqual([`${childRef} continued this thread. Close it instead.`]);
    expect(worker.settled).toEqual([]);
  });

  it("refuses a Fix when its project has been removed, before creating or sending a job", async () => {
    const { deps, worker, job, sql } = await finishedJob("revoked", [
      { status: "completed", items: [result("Done")] },
    ]);
    const ref = `J-${job.id}`;
    const denied = await click(
      { ...deps, allowedProjects: [] },
      {
        actionId: "sym_job_fix_text",
        blockId: `fix-${ref}`,
        value: "Change A",
        messageTs: "2.1",
      },
    );
    expect(denied.answer).toContain("Sym has no projects configured.");
    expect(await sql`select id from jobs where parent_job_id = ${job.id}`).toEqual([]);
    expect(worker.sends).toEqual([]);
  });

  it("refuses a Fix when the allowed name now maps to a different worker project", async () => {
    const { deps, worker, job, sql } = await finishedJob("remapped", [
      { status: "completed", items: [result("Done")] },
    ]);
    const ref = `J-${job.id}`;
    const otherWorker = new FakeWorker({
      projects: [{ id: "other-id", title: "other", workspaceRoot: "/other" }],
    });
    const denied = await click(
      {
        ...deps,
        worker: otherWorker,
        allowedProjects: [{ name: "test-repo", workerProject: "other" }],
      },
      {
        actionId: "sym_job_fix_text",
        blockId: `fix-${ref}`,
        value: "Change A",
        messageTs: "2.2",
      },
    );
    expect(denied.answer).toContain("project has changed");
    expect(await sql`select id from jobs where parent_job_id = ${job.id}`).toEqual([]);
    expect(worker.sends).toEqual([]);
    expect(otherWorker.sends).toEqual([]);
  });

  it("refuses a Fix when the connected worker changed or the original identity is unknown", async () => {
    const { deps, worker, job, sql } = await finishedJob("worker-change", [
      { status: "completed", items: [result("Done")] },
    ]);
    const ref = `J-${job.id}`;
    const action = {
      actionId: "sym_job_fix_text",
      blockId: `fix-${ref}`,
      value: "Change A",
      messageTs: "8.1",
    };
    const changed = await click({ ...deps, workerIdentity: "worker-two" }, action);
    expect(changed.answer).toContain("worker has changed");
    await sql`update jobs set worker_identity = null where id = ${job.id}`;
    const legacy = await click(deps, { ...action, messageTs: "8.2" });
    expect(legacy.answer).toContain("worker has changed");
    expect(await sql`select id from jobs where parent_job_id = ${job.id}`).toEqual([]);
    expect(worker.sends).toEqual([]);
  });

  it("applies current pack restrictions to a Fix and its stored brief", async () => {
    const { deps, worker, job, sql } = await finishedJob("pack-change", [
      { status: "completed", items: [result("Done")] },
    ]);
    const pack: Pack = {
      dir: "fixture",
      config: packSchema.parse({
        owner: { slackUserId: "U1" },
        workers: [{ name: "local", kind: "t3", mcpUrl: "https://worker.example/mcp" }],
        projects: [
          { name: "test-repo", worker: "local", allowedPaths: ["docs/**"], prPolicy: "none" },
        ],
      }),
      instructions: [],
      playbooks: [],
      schedules: [],
    };
    const ref = `J-${job.id}`;
    await sql`update jobs set brief = jsonb_set(brief, '{constraints}', '["Keep docs clear"]') where id = ${job.id}`;
    const denied = await click(
      { ...deps, pack, workerName: "another" },
      {
        actionId: "sym_job_fix_text",
        blockId: `fix-${ref}`,
        value: "Change A",
        messageTs: "9.1",
      },
    );
    expect(denied.answer).toContain('runs on worker "local"');
    expect(await sql`select id from jobs where parent_job_id = ${job.id}`).toEqual([]);
    expect(worker.sends).toEqual([]);
    const sent = await click(
      { ...deps, pack, workerName: "local" },
      {
        actionId: "sym_job_fix_text",
        blockId: `fix-${ref}`,
        value: "Change A",
        messageTs: "2.3",
      },
    );
    expect(sent.answer).toContain("Sent to the worker as");
    expect(worker.sends[0]?.text).toContain("Change only files that match: docs/**.");
    expect(worker.sends[0]?.text).toContain("Keep docs clear");
    expect(worker.sends[0]?.text).toContain("Do not push and do not open a pull request.");
    const [child] = await sql<
      { brief: Brief }[]
    >`select brief from jobs where parent_job_id = ${job.id}`;
    expect(child?.brief.openPullRequest).toBe(false);
  });

  it("holds a job for less than reconcile's interval when reconcile checks it", async () => {
    const { deps, job, sql } = await finishedJob("lease", [
      { status: "running", items: ["Working"] },
    ]);
    await sql`update jobs set status = 'running', finished_at = null, watch_until = null
      where id = ${job.id}`;
    await reconcileJobs(deps);
    const [row] = await sql<{ ok: boolean }[]>`
      select watch_until > now() + interval '90 seconds'
        and watch_until <= now() + interval '121 seconds' as ok
      from jobs where id = ${job.id}
    `;
    expect(row?.ok).toBe(true);
  });

  it("refuses a Fix while another job works in the thread, and on a running job", async () => {
    const { deps, job } = await finishedJob("busy", [
      { status: "completed", items: [result("One")] },
      { status: "running", items: [] },
    ]);
    const ref = `J-${job.id}`;
    const first = await click(deps, {
      actionId: "sym_job_fix_text",
      blockId: `fix-${ref}`,
      value: "Change A",
      messageTs: "2.1",
    });
    expect(first.answer).toMatch(/^Sent to the worker as J-\d+\.$/);
    const childRef = first.answer?.match(/J-\d+/)?.[0] ?? "";
    const second = await click(deps, {
      actionId: "sym_job_fix_text",
      blockId: `fix-${ref}`,
      value: "Change B",
      messageTs: "2.2",
    });
    expect(second.answer).toBe(`${childRef} is still working in this thread. Steer it instead.`);
    const onRunning = await click(deps, { actionId: "sym_job_fix", value: childRef });
    expect(onRunning.replies).toEqual([`${childRef} cannot take a fix now.`]);
  });

  it("closes a finished job once: settles the thread, edits the result, stops PR follow", async () => {
    const { deps, worker, job, sql } = await finishedJob("close", [
      { status: "completed", items: [result("Done")] },
    ]);
    const ref = `J-${job.id}`;
    expect((await jobsToWatch(deps, new Date(0))).map((j) => j.id)).toContain(job.id);

    await click(deps, { actionId: "sym_job_ok", value: ref, messageTs: "4.1" });
    const closed = await click(deps, { actionId: "sym_job_close", value: ref });
    expect(closed.replies).toEqual([`Closed ${ref}.`]);
    expect(worker.settled).toEqual([job.workerThreadId]);
    const [edit] = await outbox(sql, `${ref}:end-edit:`);
    expect(JSON.stringify(edit?.payload)).toContain(
      `I've closed ${ref} and stopped following its PR.`,
    );
    expect(JSON.stringify(edit?.payload)).toContain("sym_job_pr");
    expect((await jobsToWatch(deps, new Date(0))).map((j) => j.id)).not.toContain(job.id);

    const again = await click(deps, { actionId: "sym_job_close", value: ref });
    expect(again.replies).toEqual([`Closed ${ref}.`]);
    const fix = await click(deps, { actionId: "sym_job_fix", value: ref });
    expect(fix.replies).toEqual([`${ref} is closed.`]);
  });

  it("retries a failed archive after restart without settling twice or claiming success", async () => {
    const { deps, worker, job, sql } = await finishedJob("archive-recovery", [
      { status: "completed", items: [result("Done")] },
    ]);
    const ref = `J-${job.id}`;
    await sql`update jobs set code_channel = true, slack_channel = 'C-code', slack_thread_ts = null,
      origin_channel = 'C1', origin_thread_ts = '1.1' where id = ${job.id}`;
    const calls: { method: string; body: Record<string, unknown> }[] = [];
    let fail = true;
    const api: SlackApi = {
      async call(method, body) {
        calls.push({ method, body });
        if (method === "agents.conversations.archive" && fail) {
          fail = false;
          throw new SlackApiError(method, "internal_error");
        }
        return slack.call(method, body);
      },
    };
    const answer = await closeJob({ ...deps, slack: api }, ref, "U1");
    expect(answer).toContain("couldn't archive");
    expect(answer).not.toContain(`Closed ${ref}`);
    expect(calls.filter((c) => c.method === "agents.sessions.setStatus")).toEqual([]);
    expect(await getJob(sql, job.id)).toMatchObject({ archiveState: "pending" });
    await retryClosures({ ...deps, slack: api });
    await deliver(sql, api);
    expect(worker.settled).toEqual([job.workerThreadId]);
    expect(await getJob(sql, job.id)).toMatchObject({
      archiveState: "archived",
      archiveError: null,
    });
    const archives = calls.filter((c) => c.method === "agents.conversations.archive");
    const [end] = await sql<
      { slackTs: string }[]
    >`select slack_ts from outbox where idempotency_key = ${`${ref}:end`}`;
    expect(archives.map((c) => c.body)).toEqual([
      { channel_id: "C-code", summary_message_ts: end?.slackTs },
      { channel_id: "C-code", summary_message_ts: end?.slackTs },
    ]);
    const [repaired] = await outbox(sql, `${ref}:archive-recovered`);
    expect(repaired?.payload).toMatchObject({ text: `I've archived ${ref}'s channel.` });
    await retryClosures({ ...deps, slack: api });
    expect(worker.settled).toHaveLength(1);
    expect(calls.filter((c) => c.method === "agents.conversations.archive")).toHaveLength(2);
  });

  it("repairs an interrupted close, missing client and missing channel without false success", async () => {
    const { deps, worker, job, sql } = await finishedJob("archive-missing", [
      { status: "completed", items: [result("Done")] },
    ]);
    const ref = `J-${job.id}`;
    // Simulate death just after accepting Close, before settlement or archive.
    await sql`update jobs set closed_at = now(), code_channel = true, archive_state = 'pending'
      where id = ${job.id}`;
    const { slack: _slack, ...withoutSlack } = deps;
    await retryClosures(withoutSlack);
    expect(await getJob(sql, job.id)).toMatchObject({
      archiveState: "repair",
      archiveError: "missing_client",
    });
    await sql`update jobs set slack_channel = null, origin_channel = 'C-origin', origin_thread_ts = '7.1'
      where id = ${job.id}`;
    expect(await closeJob(deps, ref, "U1")).toContain("channel ID is missing");
    expect(await getJob(sql, job.id)).toMatchObject({
      archiveState: "repair",
      archiveError: "missing_channel",
    });
    await sql`update jobs set slack_channel = 'C-repaired' where id = ${job.id}`;
    const api: SlackApi = {
      async call(method, body) {
        if (method === "agents.conversations.archive")
          throw new SlackApiError(method, "already_archived");
        if (method === "chat.update") throw new SlackApiError(method, "internal_error");
        return slack.call(method, body);
      },
    };
    expect(await closeJob({ ...deps, slack: api }, ref, "U1")).toBe(
      `Closed ${ref} and archived its channel.`,
    );
    expect(await getJob(sql, job.id)).toMatchObject({ archiveState: "archived" });
    expect(worker.settled).toEqual([job.workerThreadId]);
  });

  it("steers a running job from its text box", async () => {
    const sql = ledger.sql();
    await recordSessionThread(sql, {
      sessionId: "s-steer",
      teamId: "T1",
      channelId: CHANNEL,
      threadTs: "1690000000.9",
      userId: "U1",
    });
    const worker = new FakeWorker({ script: [{ status: "running", items: [] }] });
    const deps: JobDeps = { sql, worker, allowedProjects: TEST_PROJECTS, slack };
    const job = await startJob(sql, { requestKey: "steer", sessionId: "s-steer", brief });
    await launchOrAdopt(deps, job.id, "http://127.0.0.1/cb");
    const ref = `J-${job.id}`;

    const box = await click(deps, { actionId: "sym_job_steer", value: ref });
    expect(box.replies[0]).toContain("Reply here with the direction");
    const [prompt] = await outbox(sql, `${ref}:steer-prompt:U1:`);
    expect(prompt).toBeUndefined();

    const steered = await click(deps, {
      actionId: "sym_job_steer_text",
      blockId: `steer-${ref}`,
      value: "skip the staging test",
      messageTs: "3.1",
    });
    expect(steered.answer).toContain("skip the staging test");
    expect(worker.sends).toEqual([
      expect.objectContaining({
        mode: "steer",
        text: "Direction from the person in the Slack thread: skip the staging test",
      }),
    ]);
  });
});
