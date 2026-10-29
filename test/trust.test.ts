import { afterEach, describe, expect, it, vi } from "vitest";
import type { Sql } from "../lib/db.ts";
import { recordFeedback } from "../lib/feedback/feedback.ts";
import type { Brief } from "../lib/jobs/brief.ts";
import { checkJob, type JobDeps, launchOrAdopt, startJob } from "../lib/jobs/run.ts";
import { approvePlaybook, propose } from "../lib/learning/rows.ts";
import { linkPlaybook, markUnclean, recordOutcome } from "../lib/learning/trust.ts";
import { createJob } from "../lib/ledger/jobs.ts";
import { FakeWorker } from "./fakes/worker.ts";
import { hasDatabase, useLedger } from "./helpers/ledger.ts";
import { TEST_PROJECTS } from "./helpers/projects.ts";

const NOW = new Date("2026-10-21T08:00:00Z");

describe.skipIf(!hasDatabase)("playbook outcomes after retiring auto-start", () => {
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

  it("records clean runs without offering auto-start or changing legacy trust data", async () => {
    vi.stubEnv("SYM_OWNER_SLACK_USER", "U0OWNER");
    vi.stubEnv("SYM_TRUST_RUNS", "2");
    const sql = ledger.sql();
    const guide = await approved(sql, "retired-trust");
    for (let i = 0; i < 6; i++) {
      const row = await job(sql, `retired-${i}`, guide.name);
      await end(sql, row.id, true);
    }
    expect(await notices(sql, "trust:")).toEqual([]);
    await sql`update playbooks set start_mode = 'auto', trust_changed_by = 'historic-owner' where id = ${guide.id}`;
    const row = await job(sql, "legacy-feedback", guide.name);
    await end(sql, row.id, false);
    await markUnclean(sql, row.id, "feedback", undefined);
    const [stored] =
      await sql`select start_mode, trust_changed_by from playbooks where id = ${guide.id}`;
    expect(stored).toEqual({ startMode: "auto", trustChangedBy: "historic-owner" });
    expect(await notices(sql, "trust-off:")).toEqual([]);
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

  it("ignores a cancelled job, and preserves negative feedback when a running job ends", async () => {
    vi.stubEnv("SYM_OWNER_SLACK_USER", "U0OWNER");
    const sql = ledger.sql();
    await approved(sql, "tidy-logs");
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
    await end(sql, running.id, true);
    const rows =
      await sql`select outcome from jobs where id in ${sql([running.id, done.id])} order by id`;
    expect(rows.map((row) => row.outcome)).toEqual(["unclean", "clean"]);
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
    expect(
      (await sql`select playbook_id::int from jobs where id = ${started.id}`)[0]?.playbookId,
    ).toBe(playbook.id);
  });
});
