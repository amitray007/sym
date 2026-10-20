import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  finishedSteps,
  type Harness,
  isCard,
  launchesOf,
  messageText,
  newConversation,
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

// Exit criterion 5 (docs/milestone-1.md): after a process restart mid-job, reconcile re-attaches
// and the job finishes with a correct result message. `eve dev` leaves the runs of an earlier
// server dormant unless it starts with --resume, so after the restart no worker_job task watches the
// job. Only the ledger and reconcile can finish it.

let h: Harness;

beforeAll(async () => {
  h = await startHarness({ database: "sym_e2e_recovery" });
  await h.startEve();
});

afterAll(async () => {
  h?.writeReport();
  await h?.close();
});

async function runReconcile(): Promise<void> {
  const response = await fetch(`${h.eveUrl()}/eve/v1/dev/schedules/reconcile`, {
    method: "POST",
  });
  expect(response.status).toBe(200);
}

describe("recovery", () => {
  it("finishes a job after Sym restarts mid-job", async () => {
    const c = newConversation(h);
    const { approval, job, ref } = await startJob(h, c, "Restart job");
    await c.click(approval, "Start");
    const thread = await until(() => threadsOf(h, ref)[0], { label: `${ref} worker thread` });
    const card = await until(() => c.botMessages().find(isCard), { label: `${ref} job card` });
    await workerAdvance(h, thread, [{ status: "running", items: ["Halfway there"] }]);
    await until(
      async () => {
        const [row] = await h.sql<{ lastSummary: string | null }[]>`
          select last_summary from jobs where id = ${job.id}`;
        return row?.lastSummary === "Halfway there" ? true : undefined;
      },
      { label: "the job's progress" },
    );

    // Sym dies mid-job. The worker keeps going and finishes while Sym is down.
    await h.stopEve();
    await workerAdvance(h, thread, finishedSteps(), { callBack: false });
    await h.startEve();

    // The task's watcher lease still holds, so reconcile leaves the job alone.
    await runReconcile();
    await settle(h);
    expect((await waitForJobStatus(h.sql, job.id, "running")).status).toBe("running");

    // Simulated time: the lease runs out, as it would 10 minutes after the last check.
    await h.sql`update jobs set watch_until = now() - interval '1 minute' where id = ${job.id}`;
    await runReconcile();

    const done = await waitForJobStatus(h.sql, job.id, "done");
    const result = await resultMessage(c, ref);
    await settle(h);

    expect(result.text).toContain(SAMPLE_CONTRACT.summary);
    expect(result.text).toContain(SAMPLE_CONTRACT.pr_url);
    expect(done.prUrl).toBe(SAMPLE_CONTRACT.pr_url);
    // The same card collapsed in place. No second card, and one result message.
    expect(messageText(card)).toContain(`[${ref}] Restart job · Done`);
    expect(c.botMessages().filter((m) => (m.text ?? "").startsWith(`*${ref} done`))).toHaveLength(
      1,
    );
    expect(h.slack.messages.filter((m) => messageText(m).includes(`[${ref}]`))).toHaveLength(1);
    expect(launchesOf(h, ref)).toHaveLength(1);
  });
});
