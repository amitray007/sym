import { describe, expect, it, vi } from "vitest";
import { takeChoice } from "../lib/delivery/choices.ts";
import { deliver } from "../lib/delivery/deliver.ts";
import { chooseDisplay } from "../lib/display.ts";
import { Brief } from "../lib/jobs/brief.ts";
import { proposeFollowUp, startFollowUp } from "../lib/jobs/followup.ts";
import { presentBrief, presentStart } from "../lib/jobs/present.ts";
import { reconcileJobs } from "../lib/jobs/reconcile.ts";
import { checkJob, type JobDeps, launchOrAdopt } from "../lib/jobs/run.ts";
import { steerJob } from "../lib/jobs/steer.ts";
import { choiceBlocks, storeChoices } from "../lib/ledger/choices.ts";
import { createJob, getJob, updateJob } from "../lib/ledger/jobs.ts";
import { enqueuePost } from "../lib/ledger/outbox.ts";
import { type JobProposal, propose } from "../lib/ledger/proposals.ts";
import type { SlackApi } from "../lib/slack/api.ts";
import { handleJobAction, handleProposal, handleTypedProposal } from "../lib/slack/job-actions.ts";
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
const display = chooseDisplay({
  kind: "conversation",
  needsAction: true,
  isNew: true,
  estMinutes: 0,
  steps: 0,
  lines: 1,
  surface: "channel",
  quiet: false,
});

describe.skipIf(!hasDatabase)("conversation gates", () => {
  const ledger = useLedger();
  let sequence = 0;
  function setup() {
    const calls: { method: string; body: Record<string, unknown> }[] = [];
    const slack: SlackApi = {
      async call(method, body) {
        calls.push({ method, body });
        return { ok: true, ts: body.ts ?? `1.${++sequence}` };
      },
    };
    const worker = new FakeWorker({
      script: [
        { status: "completed", items: ['```json\n{"summary":"done","tests":"passed"}\n```'] },
        { status: "running" },
      ],
    });
    const deps: JobDeps = {
      sql: ledger.sql(),
      slack,
      worker,
      workerIdentity: "worker-one",
      allowedProjects: TEST_PROJECTS,
    };
    return { deps, calls, slack, worker };
  }
  const job = (key: string) =>
    createJob(ledger.sql(), {
      requestKey: key,
      kind: "code-change",
      title: brief.title,
      brief,
      worker: "fake",
      owner: "U1",
      slackChannel: "C1",
      slackThreadTs: key,
    });

  it("escapes a short job title in the start post", async () => {
    const original = await job("escaped-start");
    const sql = ledger.sql();
    await presentStart(
      sql,
      { ...original, title: "API retries <!channel>", brief: { ...brief, estimatedMinutes: 1 } },
      new Date(),
    );
    const [post] =
      await sql`select payload from outbox where idempotency_key = ${`J-${original.id}:start`}`;
    expect(post?.payload.text).toContain("API retries &lt;!channel&gt;");
    expect(post?.payload.text).not.toContain("<!channel>");
  });

  it("records a choice visibly, removes controls, and dispatches exactly one turn", async () => {
    const s = setup();
    const sql = ledger.sql();
    const stored = await storeChoices(sql, {
      key: "offer-1",
      channel: "C1",
      threadTs: "1.1",
      message: "What next?",
      choices: ["Explain it", "Leave it"],
    });
    await enqueuePost(sql, {
      idempotencyKey: "offer-1",
      method: "chat.postMessage",
      payload: {
        channel: "C1",
        thread_ts: "1.1",
        text: stored.message,
        blocks: choiceBlocks(stored),
      },
      display,
    });
    await deliver(sql, s.slack);
    const ts = String(s.calls[0]?.body.ts ?? "1.1");
    const [row] = await sql<
      { messageTs: string }[]
    >`select message_ts from conversation_choices where id = ${stored.id}::bigint`;
    expect(row?.messageTs).toBeTruthy();
    const input = {
      value: `${stored.id}:0`,
      user: "U1",
      channel: "C1",
      messageTs: row?.messageTs ?? ts,
    };
    const turns: { text: string; key: string }[] = [];
    const send = async (text: string, key: string) => {
      turns.push({ text, key });
    };
    for (const wrong of [
      { ...input, user: "U2" },
      { ...input, channel: "C2" },
      { ...input, messageTs: "forged" },
    ]) {
      expect(await takeChoice({ sql, slack: s.slack, allowed }, wrong, send)).toBe(false);
    }
    await Promise.all([
      takeChoice({ sql, slack: s.slack, allowed }, input, send),
      takeChoice({ sql, slack: s.slack, allowed }, input, send),
    ]);
    expect(turns).toEqual([{ text: "Explain it", key: `choice:${stored.id}:turn` }]);
    const edited = s.calls.find((c) => c.method === "chat.update");
    expect(edited?.body.text).toContain("<@U1> chose: Explain it");
    expect(JSON.stringify(edited?.body.blocks)).not.toContain("actions");
    expect(s.worker.sends).toEqual([]);
  });

  it("replays a lost turn receipt under the same key and rejects expired choices", async () => {
    const s = setup();
    const sql = ledger.sql();
    const stored = await storeChoices(sql, {
      key: "offer-retry",
      channel: "C1",
      threadTs: null,
      message: "Pick",
      choices: ["Explain", "Wait"],
    });
    await sql`update conversation_choices set message_ts = '7.1' where id = ${stored.id}::bigint`;
    const input = { value: `${stored.id}:0`, user: "U1", channel: "C1", messageTs: "7.1" };
    const keys: string[] = [];
    await expect(
      takeChoice({ sql, slack: s.slack, allowed }, input, async (_text, key) => {
        keys.push(key);
        throw new Error("lost receipt");
      }),
    ).rejects.toThrow("lost receipt");
    expect(
      await takeChoice(
        { sql, slack: s.slack, allowed },
        { ...input, value: `${stored.id}:1` },
        async () => {
          throw new Error("A stale button changed the selected label.");
        },
      ),
    ).toBe(false);
    await takeChoice({ sql, slack: s.slack, allowed }, input, async (_text, key) => {
      keys.push(key);
    });
    expect(new Set(keys).size).toBe(1);
    await sql`update conversation_choices set expires_at = now() - interval '1 second', dispatched_at = null where id = ${stored.id}::bigint`;
    expect(await takeChoice({ sql, slack: s.slack, allowed }, input, async () => {})).toBe(false);
  });

  it("binds typed Start to the stored payload and rejects stale, forged and unauthorized approvals", async () => {
    const s = setup();
    const original = await job("initial-gate");
    const sql = ledger.sql();
    await presentBrief(sql, original);
    await deliver(sql, s.slack);
    const [proposal] = await sql<
      JobProposal[]
    >`select * from job_proposals where job_id = ${original.id}`;
    if (!proposal) throw new Error("missing proposal");
    const input = {
      id: String(proposal.id),
      by: "U1",
      channel: "C1",
      threadTs: "initial-gate",
      messageTs: proposal.messageTs ?? "",
      start: true,
    };
    expect((await handleProposal(s.deps, { ...input, by: "U2" }, allowed)).text).toContain(
      "couldn't approve",
    );
    expect(
      (await handleProposal(s.deps, { ...input, messageTs: "forged" }, allowed)).text,
    ).toContain("no longer current");
    expect(
      await handleTypedProposal(
        s.deps,
        { text: "yes, but change scope", by: "U1", channel: "C1", threadTs: "initial-gate" },
        allowed,
      ),
    ).toBeUndefined();
    expect(
      await handleTypedProposal(
        s.deps,
        { text: "start", by: "U1", channel: "C1", threadTs: "initial-gate" },
        allowed,
      ),
    ).toMatchObject({ kind: "accepted", text: "Starting the approved work." });
    expect((await handleProposal(s.deps, input, allowed)).text).toContain("no longer current");
    expect(
      (await sql`select status from job_proposals where job_id = ${original.id}`)[0]?.status,
    ).toBe("approved");
    expect(s.worker.launches).toBe(0);
    const stale = await job("stale");
    const gate = await propose(sql, {
      key: "stale",
      job: stale,
      kind: "start",
      payload: stale.brief,
      message: "Start?",
    });
    await sql`update jobs set brief = brief || '{"goal":"changed scope"}' where id = ${stale.id}`;
    expect(
      await handleProposal(
        s.deps,
        { id: gate.id, by: "U1", channel: "C1", threadTs: "stale", start: true },
        allowed,
      ),
    ).toMatchObject({ kind: "stale" });
  });

  it("proposes a follow-up without sending, then checks current project permissions on Start", async () => {
    const s = setup();
    const original = await job("follow-gate");
    const sql = ledger.sql();
    await launchOrAdopt(s.deps, original.id, "http://127.0.0.1/cb");
    await checkJob(s.deps, original.id, 1);
    await proposeFollowUp(s.deps, `J-${original.id}`, "cap retries at 3", "follow-gate");
    expect(s.worker.sends).toEqual([]);
    const [gate] = await sql<
      JobProposal[]
    >`select * from job_proposals where job_id = ${original.id} and kind = 'followup'`;
    if (!gate) throw new Error("no follow-up proposal");
    expect(gate.message).toBe(
      "I'll make this change on the same branch: cap retries at 3. Should I start?",
    );
    const answer = await handleProposal(
      { ...s.deps, allowedProjects: [] },
      {
        id: String(gate.id),
        by: "U1",
        channel: "C1",
        threadTs: "follow-gate",
        messageTs: gate.messageTs ?? "",
        start: true,
      },
      allowed,
    );
    expect(answer.text).toContain("no projects configured");
    expect(s.worker.sends).toEqual([]);
    expect(await sql`select id from jobs where parent_job_id = ${original.id}`).toHaveLength(0);
  });

  it.each(["project removed", "worker changed", "approver removed"])(
    "cancels an unsent follow-up when retry is refused: %s",
    async (reason) => {
      vi.stubEnv("SYM_SLACK_USERS", "U1");
      try {
        const s = setup();
        const sql = ledger.sql();
        const original = await job(`refused-${reason}`);
        await launchOrAdopt(s.deps, original.id, "http://127.0.0.1/cb");
        await checkJob(s.deps, original.id, 1);
        await proposeFollowUp(s.deps, `J-${original.id}`, "add a test", `refused-${reason}`);
        const [gate] = await sql<
          JobProposal[]
        >`select * from job_proposals where job_id = ${original.id}`;
        if (!gate) throw new Error("missing proposal");
        const send = vi.spyOn(s.worker, "send").mockRejectedValueOnce(new Error("offline"));
        await expect(
          handleProposal(
            s.deps,
            {
              id: String(gate.id),
              by: "U1",
              channel: "C1",
              threadTs: `refused-${reason}`,
              start: true,
            },
            allowed,
          ),
        ).rejects.toThrow("could not start");
        const [child] =
          await sql`select id, status, followup_sent_at from jobs where parent_job_id = ${original.id}`;
        expect(child?.status).toBe("running");
        expect(child?.followupSentAt).toBeNull();
        const retry = { ...s.deps };
        if (reason === "project removed") retry.allowedProjects = [];
        if (reason === "worker changed") retry.workerIdentity = "worker-two";
        if (reason === "approver removed") vi.stubEnv("SYM_SLACK_USERS", "U2");
        await reconcileJobs(retry);
        const closed = await getJob(sql, Number(child?.id));
        expect(closed?.status).toBe("cancelled");
        expect(closed?.finishedAt).not.toBeNull();
        const [proposal] =
          await sql`select status, executed_at from job_proposals where id = ${gate.id}::bigint`;
        expect(proposal?.status).toBe("expired");
        expect(proposal?.executedAt).not.toBeNull();
        const refusal =
          reason === "project removed"
            ? "no projects configured"
            : reason === "worker changed"
              ? "worker or project changed"
              : "access";
        expect(
          s.calls.some((c) => c.method === "chat.update" && String(c.body.text).includes(refusal)),
        ).toBe(true);
        expect(
          s.calls.some(
            (c) =>
              c.method === "chat.postMessage" &&
              c.body.channel === "U1" &&
              String(c.body.text).includes(refusal),
          ),
        ).toBe(true);
        expect(send).toHaveBeenCalledTimes(1);
        vi.stubEnv("SYM_SLACK_USERS", "U1");
        const next = await startFollowUp(
          s.deps,
          `J-${original.id}`,
          "add a test",
          "U1",
          `new-${reason}`,
        );
        expect(next.job?.status).toBe("running");
        expect(s.worker.sends).toHaveLength(1);
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it("preserves a question in a follow-up offer", async () => {
    const s = setup();
    const original = await job("question-offer");
    await launchOrAdopt(s.deps, original.id, "http://127.0.0.1/cb");
    await checkJob(s.deps, original.id, 1);
    await proposeFollowUp(s.deps, `J-${original.id}`, "can you add a test?", "question-offer");
    const [gate] =
      await ledger.sql()`select message from job_proposals where job_id = ${original.id}`;
    expect(gate?.message).toBe(
      "You asked: 'can you add a test?' I'd continue on the same branch. Should I start?",
    );
  });

  it("answers every part of a worker question in its code channel, through the brain's steer tool", async () => {
    const s = setup();
    const original = await job("questions");
    const sql = ledger.sql();
    const question = {
      requestId: "two-parts",
      questions: [
        { id: "count", prompt: "How many attempts?", options: [], multiSelect: false },
        { id: "wait", prompt: "How long between attempts?", options: [], multiSelect: false },
      ],
    };
    const worker = new FakeWorker({ script: [{ status: "waiting", questions: [question] }] });
    const deps = { ...s.deps, worker };
    await launchOrAdopt(deps, original.id, "http://127.0.0.1/cb");
    await updateJob(sql, original.id, {
      codeChannel: true,
      slackChannel: "C-code",
      slackThreadTs: null,
    });
    await checkJob(deps, original.id, 1);
    const asks = s.calls.filter(
      (c) => c.method === "chat.postMessage" && c.body.channel === "C-code",
    );
    expect(asks.map((c) => c.body.text).join(" ")).toContain("How many attempts?");
    expect(asks.map((c) => c.body.text).join(" ")).toContain("How long between attempts?");
    expect(await steerJob(deps, `J-${original.id}`, "3")).toContain("several parts");
    expect(worker.answers).toEqual([]);
    expect(
      await steerJob(deps, `J-${original.id}`, "3 attempts, 10 seconds", "steer", "answer", {
        requestId: "two-parts",
        answers: { count: "3", wait: "10 seconds" },
      }),
    ).toContain("passed your answer");
    expect(worker.answers).toEqual([
      {
        threadId: (await getJob(sql, original.id))?.workerThreadId,
        requestId: "two-parts",
        answers: { count: "3", wait: "10 seconds" },
      },
    ]);
    expect(worker.sends).toEqual([]);
  });

  it("recovers an accepted Start after its task dies before launch", async () => {
    vi.stubEnv("SYM_SLACK_USERS", "U1");
    try {
      const s = setup();
      const sql = ledger.sql();
      const original = await job("dead-before-launch");
      await presentBrief(sql, original);
      await deliver(sql, s.slack);
      await handleTypedProposal(
        s.deps,
        { text: "start", by: "U1", channel: "C1", threadTs: "dead-before-launch" },
        allowed,
      );
      await sql`insert into job_start_callbacks (job_id, callback_url) values (${original.id}, 'http://127.0.0.1/cb')`;
      await sql`update job_proposals set created_at = now() - interval '2 minutes' where job_id = ${original.id}`;
      expect(s.worker.launches).toBe(0);
      await reconcileJobs(s.deps);
      expect(s.worker.launches).toBe(1);
      expect((await getJob(sql, original.id))?.status).toBe("running");
      await reconcileJobs(s.deps);
      expect(s.worker.launches).toBe(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("waits for the choice edit to reach Slack before dispatching a turn", async () => {
    const sql = ledger.sql();
    const stored = await storeChoices(sql, {
      key: "edit-failure",
      channel: "C1",
      threadTs: null,
      message: "Pick",
      choices: ["Explain", "Wait"],
    });
    await sql`update conversation_choices set message_ts = '8.1' where id = ${stored.id}::bigint`;
    const input = { value: `${stored.id}:0`, user: "U1", channel: "C1", messageTs: "8.1" };
    let sent = false;
    await expect(
      takeChoice(
        {
          sql,
          slack: {
            async call() {
              throw new Error("offline");
            },
          },
          allowed,
        },
        input,
        async () => {
          sent = true;
        },
      ),
    ).rejects.toThrow("could not be recorded");
    expect(sent).toBe(false);
    expect(
      (await sql`select chosen_by from conversation_choices where id = ${stored.id}::bigint`)[0]
        ?.chosenBy,
    ).toBe("U1");
  });

  it("keeps old Fix buttons conversational and turns old text submissions into proposals", async () => {
    const s = setup();
    const original = await job("old-fix");
    await launchOrAdopt(s.deps, original.id, "http://127.0.0.1/cb");
    await checkJob(s.deps, original.id, 1);
    const ref = `J-${original.id}`;
    await handleJobAction(
      s.deps,
      { actionId: "sym_job_fix", value: ref, user: { id: "U1" } },
      "C1",
      async () => {},
    );
    expect(
      s.calls.some((c) => JSON.stringify(c.body.blocks ?? []).includes("plain_text_input")),
    ).toBe(false);
    await handleJobAction(
      s.deps,
      {
        actionId: "sym_job_fix_text",
        blockId: `fix-${ref}`,
        value: "add a test",
        messageTs: "9.1",
        user: { id: "U1" },
      },
      "C1",
      async () => {},
    );
    expect(s.worker.sends).toEqual([]);
    expect(
      (await ledger.sql()`select status from job_proposals where job_id = ${original.id}`)[0]
        ?.status,
    ).toBe("pending");
  });
});
