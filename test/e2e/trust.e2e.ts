import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { jobRef } from "../../lib/ledger/jobs.ts";
import {
  briefMention,
  finishedSteps,
  type Harness,
  hitlControls,
  jobInThread,
  newConversation,
  OWNER,
  startHarness,
  threadsOf,
  until,
  waitForJobStatus,
  workerAdvance,
} from "./harness.ts";

// The trust ladder end to end (decision 059): a brief that follows a playbook the owner trusts
// starts without the Start click, says why, and records a clean outcome when it ends.

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
  it("start a job without the Start click and count its clean end", async () => {
    const [playbook] = await h.sql<{ id: number }[]>`
      insert into playbooks (name, kind, body, version, source, status, decided_by, decided_at,
        start_mode)
      values ('sync-retry', 'playbook', 'Steps.', 1, 'owner', 'approved', ${OWNER}, now(), 'auto')
      returning id::int
    `;
    // Trust covers projects the playbook already ran clean on.
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

    const thread = await until(() => threadsOf(h, ref)[0], { label: `${ref} worker thread` });
    const brief = await until(
      () => c.botMessages().find((m) => (m.text ?? "").includes("Starting without Start")),
      { label: "the trusted brief" },
    );
    expect(brief.text).toContain("sync-retry");
    // No Start prompt was ever posted.
    expect(c.botMessages().some((m) => hitlControls(m.blocks ?? []).length > 0)).toBe(false);

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
    expect(row).toEqual({ outcome: "clean", autoStarted: true, playbookId: playbook?.id });
  });
});
