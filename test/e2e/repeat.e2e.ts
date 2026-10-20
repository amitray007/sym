import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createJob } from "../../lib/ledger/jobs.ts";
import { BOT, type Harness, OWNER, settle, startHarness, until } from "./harness.ts";

// The repeated-work review end to end (decision 058): the weekly schedule opens a session as the
// app principal, the brain reads recent briefs and proposes a playbook, and the owner gets one
// review notice in the digest channel. The fixture brain proposes any title seen 3 times.

const DIGEST = "C0DIGEST";

let h: Harness;

beforeAll(async () => {
  h = await startHarness({
    database: "sym_e2e_repeat",
    env: { SYM_DIGEST_CHANNEL: DIGEST, SYM_OWNER_SLACK_USER: OWNER },
  });
  await h.startEve();
});

afterAll(async () => {
  h?.writeReport();
  await h?.close();
});

async function finishedJob(key: string, title: string): Promise<number> {
  const job = await createJob(h.sql, {
    requestKey: key,
    kind: "code-change",
    title,
    brief: { project: "test-repo", goal: `Do ${title}`, doneWhen: ["tests pass"] },
    worker: "t3",
  });
  await h.sql`update jobs set status = 'done', finished_at = now() where id = ${job.id}`;
  return job.id;
}

async function fire(): Promise<void> {
  const response = await fetch(`${h.eveUrl()}/eve/v1/dev/schedules/repeat`, { method: "POST" });
  if (!response.ok) throw new Error(`repeat answered ${response.status}`);
}

describe("repeated-work review", () => {
  it("proposes a playbook for repeated work and tells the owner once", async () => {
    const jobs = [
      await finishedJob("e2e-r1", "Sync docs"),
      await finishedJob("e2e-r2", "Sync docs"),
      await finishedJob("e2e-r3", "Sync docs"),
    ];
    await fire();

    const [row] = await until(
      () =>
        h.sql<{ id: number; name: string; status: string; source: string; evidence: number[] }[]>`
        select id, name, status, source, evidence from playbooks where source = 'repeat'
      `.then((rows) => (rows.length > 0 ? rows : undefined)),
      { label: "the repeat proposal" },
    );
    expect(row).toMatchObject({ name: "sync-docs", status: "proposed" });
    expect([...(row?.evidence ?? [])].map(Number).sort()).toEqual([...jobs].sort());

    const notice = await until(
      () => h.slack.messages.find((m) => m.channel === DIGEST && m.user === BOT),
      { label: "the review notice" },
    );
    expect(notice.text).toContain(`P-${row?.id} sync-docs (from `);
    await settle(h);
    // The brain wrote nothing of its own: the notice is the only post.
    expect(h.slack.messages.filter((m) => m.channel === DIGEST && m.user === BOT)).toHaveLength(1);

    // Nothing new finished, so the next fire opens no session and proposes nothing.
    await fire();
    await settle(h);
    const [count] = await h.sql<{ n: string }[]>`select count(*) as n from playbooks`;
    expect(Number(count?.n)).toBe(1);
  });
});
