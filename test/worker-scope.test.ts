import { describe, expect, it } from "vitest";
import { askOwner, postProgress } from "../lib/jobs/worker-calls.ts";
import { createJob, getJob } from "../lib/ledger/jobs.ts";
import { pendingPosts } from "../lib/ledger/outbox.ts";
import { hasDatabase, useLedger } from "./helpers/ledger.ts";

const caller = (jobId?: number) => ({
  principalId: "sym-worker",
  attributes: jobId === undefined ? {} : { jobId: String(jobId) },
});

describe.skipIf(!hasDatabase)("worker job scope", () => {
  const ledger = useLedger();
  it("refuses another job and the shared bearer before any progress or Slack write", async () => {
    const sql = ledger.sql();
    const own = await createJob(sql, {
      requestKey: "scope-own",
      kind: "code-change",
      title: "Own job",
      brief: {},
      worker: "t3",
    });
    const victim = await createJob(sql, {
      requestKey: "scope-victim",
      kind: "code-change",
      title: "Victim job",
      brief: {},
      worker: "t3",
      slackChannel: "CPRIVATE",
      slackThreadTs: "1.2",
      owner: "UVICTIM",
    });
    for (const principal of [caller(own.id), caller()]) {
      expect(
        await askOwner({ sql }, { job: `J-${victim.id}`, question: "Injected" }, principal),
      ).toMatchObject({ ok: false });
      expect(
        await postProgress({ sql }, { job: `J-${victim.id}`, summary: "Injected" }, principal),
      ).toMatchObject({ ok: false });
    }
    expect((await getJob(sql, victim.id))?.lastSummary).toBeNull();
    expect((await getJob(sql, victim.id))?.lastActivityAt).toBeNull();
    expect(await pendingPosts(sql)).toHaveLength(0);
    expect(
      await askOwner({ sql }, { job: `J-${victim.id}`, question: "Allowed" }, caller(victim.id)),
    ).toMatchObject({ ok: true });
    expect(
      await postProgress({ sql }, { job: `J-${victim.id}`, summary: "Allowed" }, caller(victim.id)),
    ).toMatchObject({ ok: true });
    expect((await getJob(sql, victim.id))?.lastSummary).toBe("Allowed");
    expect(
      (await pendingPosts(sql)).some(
        (post) => (post.payload as { channel?: string }).channel === "CPRIVATE",
      ),
    ).toBe(true);
  });
});
