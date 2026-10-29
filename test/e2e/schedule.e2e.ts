import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../lib/ledger/migrate.ts";
import { approveSchedule, createSchedule, type ScheduleRun } from "../../lib/schedules/rows.ts";
import { scheduleRunsMigration } from "../../lib/schedules/runs-migration.ts";
import {
  BOT,
  contractMessage,
  type Harness,
  launchesOf,
  messageText,
  newConversation,
  SAMPLE_CONTRACT,
  settle,
  startHarness,
  threadsOf,
  until,
  waitForJobStatus,
  workerAdvance,
} from "./harness.ts";

// A scheduled run end to end (decisions 024 and 031): the job starts without a Start prompt, a
// clean check posts nothing at all, a check that needs attention posts one message, and a brief
// sent by a person still asks for Start.

let h: Harness;

beforeAll(async () => {
  h = await startHarness({ database: "sym_e2e_schedule" });
  // No-op once the ledger registers the migration.
  await migrate(h.sql, [scheduleRunsMigration]);
  await h.startEve();
});

afterAll(async () => {
  h?.writeReport();
  await h?.close();
});

const BRIEF = {
  project: "test-repo",
  title: "On-call check",
  goal: "Check the on-call dashboard and report anything odd.",
  constraints: [],
  doneWhen: ["Findings listed"],
  baseRef: "main",
  openPullRequest: false,
  estimatedMinutes: 15,
};

async function approvedSchedule(channel: string, stored: unknown) {
  const row = await createSchedule(h.sql, {
    cron: "0 9 * * *",
    title: "On-call check",
    brief: stored,
    channel,
    owner: "UOWNER",
  });
  const active = await approveSchedule(h.sql, row.id, "UOWNER", new Date());
  if (!active) throw new Error("schedule not approved");
  // Make it due now.
  await h.sql`update schedules set next_fire_at = now() - interval '1 minute' where id = ${row.id}`;
  return active;
}

async function dispatch(): Promise<void> {
  const response = await fetch(`${h.eveUrl()}/eve/v1/dev/schedules/dispatch`, { method: "POST" });
  if (!response.ok) throw new Error(`dispatch answered ${response.status}`);
}

async function runOf(scheduleId: number): Promise<ScheduleRun> {
  return until(
    async () => {
      const [row] = await h.sql<ScheduleRun[]>`
        select * from schedule_runs where schedule_id = ${scheduleId} and session_id is not null
        order by id desc limit 1
      `;
      return row;
    },
    { label: "schedule run row" },
  );
}

describe("scheduled runs", () => {
  // Dispatches an approved schedule and runs its job to the end with the given final message.
  async function runSchedule(channel: string, final: string) {
    const schedule = await approvedSchedule(channel, BRIEF);
    await dispatch();
    const run = await runOf(schedule.id);
    const [scheduled] = await until(
      async () => {
        const rows = await h.sql<
          { id: number }[]
        >`select id from jobs where session_id = ${run.sessionId}`;
        return rows.length > 0 ? rows : undefined;
      },
      { label: "scheduled job" },
    );
    const jobId = Number(scheduled?.id);
    const ref = `J-${jobId}`;
    const thread = await until(() => threadsOf(h, ref)[0], { label: `${ref} worker thread` });
    await workerAdvance(h, thread, [{ status: "completed", items: [final] }]);
    await waitForJobStatus(h.sql, jobId, "done");
    return { run, jobId, ref };
  }

  const botPostsIn = (channel: string) =>
    h.slack.messages.filter((m) => m.channel === channel && m.user === BOT);

  it("runs a clean approved check without a prompt and posts nothing", async () => {
    const channel = newConversation(h).channel;
    // No PR: the scheduled brief allows none, and an unexpected PR is a concern worth a post.
    const { run, jobId, ref } = await runSchedule(
      channel,
      contractMessage({ ...SAMPLE_CONTRACT, pr_url: null }),
    );

    const final = await until(
      async () => {
        const [row] = await h.sql<ScheduleRun[]>`select * from schedule_runs where id = ${run.id}`;
        return row?.outcome === "all_clear" ? row : undefined;
      },
      { label: "run outcome all_clear" },
    );
    await settle(h);

    expect(Number(final.jobId)).toBe(jobId);
    expect(launchesOf(h, ref)).toHaveLength(1);
    // Display rule step 2: nothing new means silence. The digest lists the run as all clear.
    expect(botPostsIn(channel)).toEqual([]);
  });

  it("posts one message when a scheduled check needs attention", async () => {
    const channel = newConversation(h).channel;
    const { run, ref } = await runSchedule(
      channel,
      contractMessage({ ...SAMPLE_CONTRACT, open_questions: ["The error rate doubled. Page?"] }),
    );

    await until(
      async () => {
        const [row] = await h.sql<ScheduleRun[]>`select * from schedule_runs where id = ${run.id}`;
        return row?.outcome === "needs_attention" ? row : undefined;
      },
      { label: "run outcome needs_attention" },
    );
    await settle(h);

    const posts = botPostsIn(channel);
    expect(posts).toHaveLength(1);
    const text = posts[0] ? messageText(posts[0]) : "";
    expect(text).toContain("The error rate doubled");
    expect(text).toContain(`Done with ${ref}:`);
  });

  // The model cannot widen a schedule. The dispatcher always sends the stored brief, so these
  // cases send a dispatch-shaped message as a person: the initiator is not the schedule
  // principal, and the brief is the stored one or a wider one. The brief-equality rule has unit
  // tests (test/schedule-approval.test.ts).
  it.each([
    ["the stored brief", {}],
    ["a wider brief", { goal: "Check everything and fix whatever is odd." }],
  ])("still asks for Start when a person sends %s", async (_label, change) => {
    const c = newConversation(h);
    const schedule = await approvedSchedule(c.channel, BRIEF);
    await c.mention(
      `<@${BOT}> Scheduled run of S-${schedule.id}: On-call check.\n` +
        `\`\`\`brief\n${JSON.stringify({ ...BRIEF, ...change })}\n\`\`\``,
    );
    await c.waitForControls(/Want me to start\?/);
  });
});
