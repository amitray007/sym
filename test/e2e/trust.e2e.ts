import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { jobRef } from "../../lib/ledger/jobs.ts";
import {
  briefMention,
  finishedSteps,
  type Harness,
  jobInThread,
  newConversation,
  OWNER,
  settle,
  startHarness,
  threadsOf,
  until,
  waitForJobStatus,
  workerAdvance,
} from "./harness.ts";

// Interactive work still needs Start for trusted playbooks (decision 071). The job remains
// linked to its playbook and records its clean outcome after the approved work ends.

let h: Harness;

beforeAll(async () => {
  h = await startHarness({ database: "sym_e2e_trust", env: { SYM_OWNER_SLACK_USER: OWNER } });
  await h.startEve();
});

afterAll(async () => {
  h?.writeReport();
  await h?.close();
});

describe("trusted playbooks", () => {
  it("requires Start for an interactive trusted job and counts its clean end", async () => {
    const [playbook] = await h.sql<{ id: number }[]>`
      insert into playbooks (name, kind, body, version, source, status, decided_by, decided_at,
        start_mode)
      values ('sync-retry', 'playbook', 'Steps.', 1, 'owner', 'approved', ${OWNER}, now(), 'auto')
      returning id::int
    `;
    // Preserve a historical auto row; it no longer grants authority.
    await h.sql`
      insert into jobs (request_key, kind, title, brief, worker, status, finished_at, playbook_id,
        outcome)
      values ('trust-earlier', 'code-change', 'Earlier retry', ${h.sql.json({ project: "test-repo" })},
        't3', 'done', now(), ${playbook?.id ?? 0}, 'clean')
    `;
    const c = newConversation(h);
    await c.mention(briefMention("Trusted retry", { playbook: "sync-retry" }));
    const job = await jobInThread(h.sql, c.channel, c.rootTs);
    const ref = jobRef(job.id);

    const approval = await c.waitForControls(/Want me to start\?/);
    expect(approval.controls.map((control) => control.label)).toEqual(["Start", "Not now"]);
    await settle(h);
    expect(threadsOf(h, ref)).toHaveLength(0);
    expect(h.t3.calls.filter((call) => call.name === "t3_thread_launch")).toHaveLength(0);
    await c.click(approval, "Start");
    const thread = await until(() => threadsOf(h, ref)[0], { label: `${ref} worker thread` });

    await workerAdvance(h, thread, finishedSteps());
    await waitForJobStatus(h.sql, job.id, "done");
    const [row] = await until(
      async () => {
        const rows = await h.sql<
          { outcome: string | null; autoStarted: boolean; playbookId: number }[]
        >`
          select outcome, auto_started, playbook_id::int from jobs where id = ${job.id}
        `;
        return rows[0]?.outcome ? rows : undefined;
      },
      { label: "the recorded outcome" },
    );
    expect(row).toEqual({ outcome: "clean", autoStarted: false, playbookId: playbook?.id });
    expect(
      (await h.sql`select start_mode from playbooks where id = ${playbook?.id ?? 0}`)[0]?.startMode,
    ).toBe("auto");
    expect(await h.sql`select id from outbox where idempotency_key like 'trust:%'`).toHaveLength(0);
  });
});
