import { afterEach, describe, expect, it, vi } from "vitest";
import repeatedWork from "../agent/tools/repeated_work.ts";
import repeatedWorkPropose from "../agent/tools/repeated_work_propose.ts";
import { respondAsFixture } from "../lib/brain/fixture.ts";
import type { Sql } from "../lib/db.ts";
import {
  briefsText,
  markRepeatScan,
  proposeRepeated,
  queueRepeatNotice,
  REPEAT_MIN,
  recentBriefs,
  repeatScanDue,
} from "../lib/learning/repeat.ts";
import { propose } from "../lib/learning/rows.ts";
import { createJob } from "../lib/ledger/jobs.ts";
import { hasDatabase, useLedger } from "./helpers/ledger.ts";

const NOW = new Date("2026-10-21T06:30:00Z");

async function finishedJob(
  sql: Sql,
  key: string,
  title: string,
  options: { kind?: string; status?: string; daysAgo?: number } = {},
): Promise<number> {
  const job = await createJob(sql, {
    requestKey: key,
    kind: options.kind ?? "code-change",
    title,
    brief: { project: "example-app", goal: `Do ${title}`, doneWhen: ["tests pass"] },
    worker: "t3",
  });
  const finished = new Date(NOW.getTime() - (options.daysAgo ?? 1) * 86_400_000);
  await sql`update jobs set status = ${options.status ?? "done"}, finished_at = ${finished}
    where id = ${job.id}`;
  return job.id;
}

describe("briefsText", () => {
  it("lists each job with its project, goal, and checks, then the existing playbooks", () => {
    const text = briefsText(
      [
        {
          id: 7,
          project: "example-app",
          title: "Bump deps",
          goal: "Update",
          doneWhen: ["ci green"],
        },
      ],
      [],
    );
    expect(text).toBe(
      [
        "Finished jobs, newest first (1):",
        "J-7 [example-app] Bump deps",
        "  goal: Update",
        "  done when: ci green",
        "Existing playbooks: none",
      ].join("\n"),
    );
  });

  it("says so when nothing finished", () => {
    expect(briefsText([], [])).toBe("No finished jobs in the last 60 days.");
  });
});

describe.skipIf(!hasDatabase)("repeated work in the ledger", () => {
  const ledger = useLedger();

  it("reads only recent finished jobs that people asked for", async () => {
    const sql = ledger.sql();
    const done = await finishedJob(sql, "r-done", "Rotate logs");
    await finishedJob(sql, "r-failed", "Rotate logs", { status: "failed" });
    await finishedJob(sql, "r-check", "Rotate logs", { kind: "scheduled-check" });
    await finishedJob(sql, "r-old", "Rotate logs", { daysAgo: 90 });
    const ids = (await recentBriefs(sql, NOW)).map((brief) => brief.id);
    expect(ids).toContain(done);
    expect(ids).toHaveLength(1);
  });

  it("is due only after enough jobs finished since the last review", async () => {
    const sql = ledger.sql();
    await markRepeatScan(sql, NOW);
    expect(await repeatScanDue(sql, new Date(NOW.getTime() + 3600_000))).toBe(false);
    for (let i = 0; i < REPEAT_MIN; i++) {
      const id = await finishedJob(sql, `due-${i}`, "Due job");
      await sql`update jobs set finished_at = ${new Date(NOW.getTime() + 60_000)} where id = ${id}`;
    }
    expect(await repeatScanDue(sql, new Date(NOW.getTime() + 3600_000))).toBe(true);
  });

  it("checks the evidence before it saves a proposal", async () => {
    const sql = ledger.sql();
    const jobs = [
      await finishedJob(sql, "p-1", "Refresh fixtures"),
      await finishedJob(sql, "p-2", "Refresh fixtures"),
      await finishedJob(sql, "p-3", "Refresh fixtures"),
    ];
    const old = await finishedJob(sql, "p-old", "Refresh fixtures", { daysAgo: 90 });
    const input = { name: "refresh-fixtures", body: "1. Ask for <project>.", jobIds: jobs };

    expect(
      await proposeRepeated(sql, { ...input, jobIds: [jobs[0] ?? 0, jobs[0] ?? 0] }, NOW),
    ).toMatch(/at least 3 different jobs/);
    expect(
      await proposeRepeated(sql, { ...input, jobIds: [jobs[0] ?? 0, jobs[1] ?? 0, old] }, NOW),
    ).toBe(`These are not recent finished jobs: J-${old}.`);

    const row = await proposeRepeated(sql, input, NOW);
    expect(row).toMatchObject({
      name: "refresh-fixtures",
      kind: "playbook",
      status: "proposed",
      source: "repeat",
      evidence: jobs,
    });
    expect(await proposeRepeated(sql, input, NOW)).toMatch(/already has a proposal/);
  });

  it("refuses a name that already has an approval from another source", async () => {
    const sql = ledger.sql();
    const jobs = [
      await finishedJob(sql, "a-1", "Prune caches"),
      await finishedJob(sql, "a-2", "Prune caches"),
      await finishedJob(sql, "a-3", "Prune caches"),
    ];
    await propose(sql, { name: "prune-caches", kind: "playbook", body: "x", source: "owner" });
    expect(
      await proposeRepeated(sql, { name: "prune-caches", body: "y", jobIds: jobs }, NOW),
    ).toMatch(/already has a proposal/);
  });

  it("queues one review notice per proposal", async () => {
    const sql = ledger.sql();
    const jobs = [
      await finishedJob(sql, "n-1", "Sync docs"),
      await finishedJob(sql, "n-2", "Sync docs"),
      await finishedJob(sql, "n-3", "Sync docs"),
    ];
    const row = await proposeRepeated(
      sql,
      { name: "sync-docs", body: "Steps.", jobIds: jobs },
      NOW,
    );
    if (typeof row === "string") throw new Error(row);
    await queueRepeatNotice(sql, "U0OWNER", [row]);
    await queueRepeatNotice(sql, "U0OWNER", [row]);
    const posts = await sql<
      { payload: { channel: string; text: string }; display: { target: string } }[]
    >`
      select payload, display from outbox where idempotency_key = ${`repeat:P-${row.id}`}
    `;
    expect(posts).toHaveLength(1);
    expect(posts[0]?.payload.channel).toBe("U0OWNER");
    expect(posts[0]?.payload.text).toContain(`P-${row.id} sync-docs (from J-${jobs[0]}, `);
    expect(posts[0]?.display.target).toBe("dm");
  });
});

describe("repeated-work tools", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  const as = (principalId: string) => ({
    session: { id: "s1", auth: { current: { principalId } } },
  });
  // biome-ignore lint/suspicious/noExplicitAny: a test context with only the fields the tools read
  const run = (tool: any, input: unknown, ctx: unknown) => tool.execute(input, ctx);
  const proposal = { proposals: [{ name: "x", body: "y", jobs: ["J-1", "J-2", "J-3"] }] };

  it("refuse worker threads", async () => {
    const refusal = "Worker threads cannot call this tool.";
    expect(await run(repeatedWork, {}, as("sym-worker"))).toBe(refusal);
    expect(await run(repeatedWorkPropose, proposal, as("sym-worker"))).toBe(refusal);
  });

  it("refuse a person who is not the owner", async () => {
    vi.stubEnv("SYM_OWNER_SLACK_USER", "U0OWNER");
    const other = as("slack:T1:U0OTHER");
    expect(await run(repeatedWork, {}, other)).toBe("Only the owner can decide this.");
    expect(await run(repeatedWorkPropose, proposal, other)).toBe("Only the owner can decide this.");
  });
});

describe("fixture brain", () => {
  const request = (text: string, extra: Record<string, unknown> = {}) =>
    ({
      lastUserMessage: text,
      messages: [{ role: "user", text }],
      toolResults: [],
      tools: [{ name: "no_reply" }],
      ...extra,
    }) as unknown as Parameters<typeof respondAsFixture>[0];

  it("reads recent jobs for a review, then proposes a title seen three times", () => {
    expect(respondAsFixture(request("Repeated-work review.\nCall repeated_work."))).toEqual({
      toolCalls: [{ name: "repeated_work", input: {} }],
    });
    const output = [
      "J-3 [example-app] Sync docs",
      "J-2 [example-app] Sync docs",
      "J-1 [example-app] Sync docs",
    ].join("\n");
    const text = "Repeated-work review.";
    const next = respondAsFixture(
      request(text, {
        messages: [
          { role: "user", text },
          { role: "tool", text: output },
        ],
        toolResults: [{ name: "repeated_work", output }],
      }),
    );
    expect(next).toMatchObject({
      toolCalls: [
        {
          name: "repeated_work_propose",
          input: { proposals: [{ name: "sync-docs", jobs: ["J-3", "J-2", "J-1"] }] },
        },
      ],
    });
  });
});
