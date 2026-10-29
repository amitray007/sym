import { afterEach, describe, expect, it, vi } from "vitest";
import playbookTrust from "../agent/tools/playbook_trust.ts";
import type { Sql } from "../lib/db.ts";
import { recordFeedback } from "../lib/feedback/feedback.ts";
import type { Brief } from "../lib/jobs/brief.ts";
import { checkJob, type JobDeps, launchOrAdopt, startJob } from "../lib/jobs/run.ts";
import { approvePlaybook, propose } from "../lib/learning/rows.ts";
import {
  cleanStreak,
  linkPlaybook,
  markUnclean,
  promoteIfClean,
  recordOutcome,
  setStartMode,
  trustedPlaybookOf,
  trustRuns,
} from "../lib/learning/trust.ts";
import { createJob } from "../lib/ledger/jobs.ts";
import { FakeWorker } from "./fakes/worker.ts";
import { hasDatabase, useLedger } from "./helpers/ledger.ts";
import { TEST_PROJECTS } from "./helpers/projects.ts";

const NOW = new Date("2026-10-21T08:00:00Z");

describe("trustRuns", () => {
  it("is 5 unless SYM_TRUST_RUNS sets 2 or more", () => {
    expect(trustRuns({})).toBe(5);
    expect(trustRuns({ SYM_TRUST_RUNS: "3" })).toBe(3);
    expect(trustRuns({ SYM_TRUST_RUNS: "1" })).toBe(5);
    expect(trustRuns({ SYM_TRUST_RUNS: "x" })).toBe(5);
  });
});

describe("playbook_trust", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  const as = (principalId: string) => ({
    session: { id: "s1", auth: { current: { principalId } } },
  });
  // biome-ignore lint/suspicious/noExplicitAny: a test context with only the fields the tool reads
  const run = (input: unknown, ctx: unknown) => (playbookTrust as any).execute(input, ctx);

  it("refuses worker threads and people who are not the owner", async () => {
    vi.stubEnv("SYM_OWNER_SLACK_USER", "U0OWNER");
    expect(await run({ name: "x", mode: "auto" }, as("sym-worker"))).toBe(
      "Worker threads cannot call this tool.",
    );
    expect(await run({ name: "x", mode: "auto" }, as("slack:T1:U0OTHER"))).toBe(
      "Only the owner can decide this.",
    );
  });
});

describe.skipIf(!hasDatabase)("the trust ladder", () => {
  const ledger = useLedger();
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function approved(sql: Sql, name: string, kind: "playbook" | "rule" = "playbook") {
    const row = await propose(sql, { name, kind, body: "Steps.", source: "owner" });
    const done = await approvePlaybook(sql, row.id, "U0OWNER", NOW);
    if (!done) throw new Error("not approved");
    return done;
  }

  async function job(sql: Sql, key: string, playbook?: string) {
    const row = await createJob(sql, {
      requestKey: key,
      kind: "code-change",
      title: key,
      brief: { project: "test-repo" },
      worker: "t3",
    });
    await linkPlaybook(sql, row.id, playbook);
    return row;
  }

  // Ends a job and records its outcome, as presentEnd does.
  async function end(sql: Sql, id: number, clean: boolean) {
    await sql`update jobs set status = 'done', finished_at = clock_timestamp() where id = ${id}`;
    await recordOutcome(sql, { id, kind: "code-change", status: "done" }, clean, undefined);
  }

  const notices = (sql: Sql, prefix: string) =>
    sql<{ payload: { channel: string; text: string } }[]>`
      select payload from outbox where starts_with(idempotency_key, ${prefix}) order by id
    `;

  it("serializes promotion with a concurrent negative outcome", async () => {
    vi.stubEnv("SYM_TRUST_RUNS", "2");
    const sql = ledger.sql();
    const guide = await approved(sql, "race-guide");
    const first = await job(sql, "race-first", guide.name);
    const second = await job(sql, "race-second", guide.name);
    await end(sql, first.id, true);
    await end(sql, second.id, true);
    await Promise.all([
      promoteIfClean(sql, guide.id, "U0OWNER"),
      markUnclean(sql, second.id, "negative feedback", undefined),
    ]);
    expect((await sql`select start_mode from playbooks where id = ${guide.id}`)[0]?.startMode).toBe(
      "ask",
    );
    expect(await promoteIfClean(sql, guide.id, "U0OWNER")).toBe(false);
  });

  it("links only an approved playbook the brief names", async () => {
    const sql = ledger.sql();
    const deploy = await approved(sql, "deploy-preview");
    await approved(sql, "lint-first", "rule");
    const a = await job(sql, "link-a", "deploy-preview");
    const b = await job(sql, "link-b", "no-such-playbook");
    const c = await job(sql, "link-c", "lint-first");
    const rows = await sql<{ id: number; playbookId: number | null }[]>`
      select id::int, playbook_id::int from jobs where id in ${sql([a.id, b.id, c.id])} order by id
    `;
    expect(rows.map((r) => r.playbookId)).toEqual([deploy.id, null, null]);
  });

  it("suggests trust after enough clean runs, once, and counts only a clean streak", async () => {
    vi.stubEnv("SYM_TRUST_RUNS", "3");
    vi.stubEnv("SYM_OWNER_SLACK_USER", "U0OWNER");
    const sql = ledger.sql();
    const playbook = await approved(sql, "refresh-fixtures");
    const ids: number[] = [];
    for (const [i, clean] of [true, false, true, true].entries()) {
      const row = await job(sql, `streak-${i}`, "refresh-fixtures");
      ids.push(row.id);
      await end(sql, row.id, clean);
    }
    expect(await cleanStreak(sql, playbook.id)).toEqual([ids[3], ids[2]]);
    expect(await notices(sql, `trust:P-${playbook.id}:`)).toEqual([]);

    const third = await job(sql, "streak-4", "refresh-fixtures");
    await end(sql, third.id, true);
    const [notice] = await notices(sql, `trust:P-${playbook.id}:`);
    expect(notice?.payload.channel).toBe("U0OWNER");
    expect(notice?.payload.text).toContain(`the last 3 jobs that followed it ended clean`);

    // Another clean run does not ask again, and an outcome records once.
    const fourth = await job(sql, "streak-5", "refresh-fixtures");
    await end(sql, fourth.id, true);
    await recordOutcome(
      sql,
      { id: fourth.id, kind: "code-change", status: "done" },
      false,
      undefined,
    );
    expect(await notices(sql, `trust:P-${playbook.id}:`)).toHaveLength(1);
    expect((await cleanStreak(sql, playbook.id)).length).toBe(4);
  });

  it("lets a trusted playbook's jobs start, and a 👎 puts it back to asking", async () => {
    vi.stubEnv("SYM_OWNER_SLACK_USER", "U0OWNER");
    const sql = ledger.sql();
    const playbook = await approved(sql, "rotate-keys");
    const before = await job(sql, "trust-0", "rotate-keys");
    expect(await trustedPlaybookOf(sql, before.id, "pr-wake")).toBeUndefined();
    await end(sql, before.id, true);

    expect(await setStartMode(sql, playbook.id, "auto", "U0OWNER")).toBe(true);
    const trusted = await job(sql, "trust-1", "rotate-keys");
    expect((await trustedPlaybookOf(sql, trusted.id, "pr-wake"))?.name).toBe("rotate-keys");
    await end(sql, trusted.id, true);

    await recordFeedback(sql, {
      jobId: trusted.id,
      slackUser: "U0OWNER",
      kind: "thumbs_down",
      value: "down",
      messageTs: "1.1",
    });
    const [mode] = await sql<{ startMode: string }[]>`
      select start_mode from playbooks where id = ${playbook.id}
    `;
    expect(mode?.startMode).toBe("ask");
    const [notice] = await notices(sql, `trust-off:P-${playbook.id}:`);
    expect(notice?.payload.text).toBe(
      `P-${playbook.id} rotate-keys needs your approval before starting again: a 👎 on J-${trusted.id}.`,
    );
    expect(await trustedPlaybookOf(sql, trusted.id, "pr-wake")).toBeUndefined();
  });

  it("trusts only projects the playbook ran clean on", async () => {
    const sql = ledger.sql();
    const playbook = await approved(sql, "warm-cache");
    const first = await job(sql, "project-1", "warm-cache");
    await end(sql, first.id, true);
    await setStartMode(sql, playbook.id, "auto", "U0OWNER");
    const same = await job(sql, "project-2", "warm-cache");
    expect((await trustedPlaybookOf(sql, same.id, "pr-wake"))?.name).toBe("warm-cache");
    const other = await createJob(sql, {
      requestKey: "project-3",
      kind: "code-change",
      title: "other",
      brief: { project: "another-repo" },
      worker: "t3",
    });
    await linkPlaybook(sql, other.id, "warm-cache");
    expect(await trustedPlaybookOf(sql, other.id, "pr-wake")).toBeUndefined();
  });

  it("ignores a cancelled job, and keeps a running job's 👎 out of the streak until it ends", async () => {
    vi.stubEnv("SYM_OWNER_SLACK_USER", "U0OWNER");
    const sql = ledger.sql();
    const playbook = await approved(sql, "tidy-logs");
    const cancelled = await job(sql, "cancel-1", "tidy-logs");
    await sql`update jobs set status = 'cancelled', finished_at = now() where id = ${cancelled.id}`;
    await recordOutcome(
      sql,
      { id: cancelled.id, kind: "code-change", status: "cancelled" },
      false,
      undefined,
    );
    const [none] = await sql<
      { outcome: string | null }[]
    >`select outcome from jobs where id = ${cancelled.id}`;
    expect(none?.outcome).toBeNull();

    const running = await job(sql, "run-1", "tidy-logs");
    await recordFeedback(sql, {
      jobId: running.id,
      slackUser: "U1",
      kind: "thumbs_down",
      value: "down",
      messageTs: "9.1",
    });
    const done = await job(sql, "run-2", "tidy-logs");
    await end(sql, done.id, true);
    expect(await cleanStreak(sql, playbook.id)).toEqual([done.id]);

    // The owner trusts it meanwhile; the 👎'd job then ends and puts it back to asking.
    await setStartMode(sql, playbook.id, "auto", "U0OWNER");
    await end(sql, running.id, true);
    const [mode] = await sql<
      { startMode: string }[]
    >`select start_mode from playbooks where id = ${playbook.id}`;
    expect(mode?.startMode).toBe("ask");
    expect(await cleanStreak(sql, playbook.id)).toEqual([]);
  });

  it("puts a trusted playbook back to asking after a run with concerns", async () => {
    vi.stubEnv("SYM_OWNER_SLACK_USER", "U0OWNER");
    const sql = ledger.sql();
    const playbook = await approved(sql, "bump-deps");
    await setStartMode(sql, playbook.id, "auto", "U0OWNER");
    const row = await job(sql, "concern-1", "bump-deps");
    await end(sql, row.id, false);
    const [mode] = await sql<{ startMode: string }[]>`
      select start_mode from playbooks where id = ${playbook.id}
    `;
    expect(mode?.startMode).toBe("ask");
  });

  it("records the outcome when a linked job ends through the job steps", async () => {
    const sql = ledger.sql();
    const playbook = await approved(sql, "fix-flaky");
    const brief: Brief = {
      project: "test-repo",
      title: "Fix flaky",
      goal: "Fix it.",
      constraints: [],
      doneWhen: ["Tests pass"],
      openPullRequest: false,
      estimatedMinutes: 15,
      playbook: "fix-flaky",
    };
    const worker = new FakeWorker({
      script: [
        {
          status: "completed",
          items: [
            `Done.\n\`\`\`json\n${JSON.stringify({
              summary: "Fixed",
              pr_url: null,
              tests: "ok",
              files_changed: [],
              open_questions: [],
            })}\n\`\`\``,
          ],
        },
      ],
    });
    const deps: JobDeps = { sql, worker, allowedProjects: TEST_PROJECTS };
    const started = await startJob(sql, { requestKey: "steps-1", brief });
    await linkPlaybook(sql, started.id, brief.playbook);
    await launchOrAdopt(deps, started.id, "http://127.0.0.1/cb");
    await checkJob(deps, started.id, 1000);
    const [row] = await sql<{ outcome: string | null }[]>`
      select outcome from jobs where id = ${started.id}
    `;
    // The job has no Slack thread, so nothing posts, but the outcome still counts.
    expect(row?.outcome).toBe("clean");
    expect(await cleanStreak(sql, playbook.id)).toEqual([started.id]);
  });
});
