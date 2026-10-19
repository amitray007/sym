import { describe, expect, it } from "vitest";
import type { Brief } from "../lib/jobs/brief.ts";
import { launchOrAdopt, startJob } from "../lib/jobs/run.ts";
import {
  askOwner,
  capText,
  postProgress,
  QUESTION_MAX,
  SUMMARY_MAX,
  shortHash,
} from "../lib/jobs/worker-calls.ts";
import { getJob, updateJob } from "../lib/ledger/jobs.ts";
import { pendingPosts } from "../lib/ledger/outbox.ts";
import { recordSessionThread } from "../lib/ledger/threads.ts";
import { FakeWorker } from "./fakes/worker.ts";
import { hasDatabase, useLedger } from "./helpers/ledger.ts";

const brief: Brief = {
  project: "test-repo",
  title: "Billing sync retry",
  goal: "Add retry with backoff to the billing sync.",
  constraints: [],
  doneWhen: ["Unit tests cover the retry."],
  baseRef: "main",
  openPullRequest: false,
  estimatedMinutes: 15,
};

describe("capText and shortHash", () => {
  it("flattens whitespace and cuts with an ellipsis", () => {
    expect(capText("a \n b\t c", 20)).toBe("a b c");
    const cut = capText("x".repeat(50), 10);
    expect(cut).toHaveLength(10);
    expect(cut.endsWith("…")).toBe(true);
  });

  it("hashes the same text to the same key and different text to another", () => {
    expect(shortHash("why?")).toBe(shortHash("why?"));
    expect(shortHash("why?")).not.toBe(shortHash("why not?"));
  });
});

describe.skipIf(!hasDatabase)("worker calls", () => {
  const ledger = useLedger();
  let n = 0;

  async function launched(withThread = true) {
    const sql = ledger.sql();
    n += 1;
    const sessionId = `wc-session-${n}`;
    if (withThread) {
      await recordSessionThread(sql, {
        sessionId,
        teamId: "T1",
        channelId: "C1",
        threadTs: "1700000000.0001",
        userId: "UOWNER",
      });
    }
    const job = await startJob(sql, { requestKey: `wc-${n}`, sessionId, brief });
    const deps = { sql, worker: new FakeWorker({ script: [{ status: "running" }] }) };
    const started = await launchOrAdopt(deps, job.id, "http://127.0.0.1:2000/cb");
    return { sql, job: started, ref: `J-${job.id}` };
  }

  describe("postProgress", () => {
    it("records the summary and activity time and moves the card to a new version", async () => {
      const { sql, job, ref } = await launched();
      const now = new Date("2026-01-01T10:00:00Z");

      const result = await postProgress(
        { sql, now: () => now },
        { job: ref, summary: "Tests pass" },
      );

      expect(result.ok).toBe(true);
      const after = await getJob(sql, job.id);
      expect(after?.lastSummary).toBe("Tests pass");
      expect(after?.lastActivityAt).toEqual(now);
      expect(after?.cardVersion).toBe(job.cardVersion + 1);
    });

    it("keeps the card version when the same summary arrives again", async () => {
      const { sql, job, ref } = await launched();
      const now = () => new Date("2026-01-01T10:00:00Z");
      await postProgress({ sql, now }, { job: ref, summary: "Same" });
      const first = await getJob(sql, job.id);
      await postProgress({ sql, now }, { job: ref, summary: "Same" });
      expect((await getJob(sql, job.id))?.cardVersion).toBe(first?.cardVersion);
    });

    it("caps a long summary", async () => {
      const { sql, job, ref } = await launched();
      await postProgress({ sql }, { job: ref, summary: `line\n${"x".repeat(2000)}` });
      const stored = (await getJob(sql, job.id))?.lastSummary ?? "";
      expect(stored).toHaveLength(SUMMARY_MAX);
      expect(stored).not.toContain("\n");
    });

    it("refuses an unknown job, a finished job, and an empty summary", async () => {
      const { sql, job, ref } = await launched();
      expect(await postProgress({ sql }, { job: "J-99999", summary: "x" })).toMatchObject({
        ok: false,
        message: "There is no job J-99999.",
      });
      expect(await postProgress({ sql }, { job: "nonsense", summary: "x" })).toMatchObject({
        ok: false,
      });
      expect(await postProgress({ sql }, { job: ref, summary: "  \n " })).toMatchObject({
        ok: false,
      });

      await updateJob(sql, job.id, { status: "done" });
      const refused = await postProgress({ sql }, { job: ref, summary: "late" });
      expect(refused).toMatchObject({ ok: false });
      expect(refused.message).toContain("already finished");
      expect((await getJob(sql, job.id))?.lastSummary).not.toBe("late");
    });
  });

  describe("askOwner", () => {
    const asks = async (sql: ReturnType<typeof ledger.sql>, ref: string) =>
      (await pendingPosts(sql, 500)).filter((p) => p.idempotencyKey.startsWith(`${ref}:ask:`));

    it("posts one needs-action message in the job thread, once per question", async () => {
      const { sql, ref } = await launched();

      const first = await askOwner({ sql }, { job: ref, question: "Which branch?" });
      await askOwner({ sql }, { job: ref, question: "Which branch?" });
      await askOwner({ sql }, { job: ref, question: "Which database?" });

      expect(first.ok).toBe(true);
      const posts = await asks(sql, ref);
      expect(posts).toHaveLength(2);
      const post = posts.find((p) => JSON.stringify(p.payload).includes("Which branch?"));
      expect(post?.display).toMatchObject({ level: 2, reason: "needs action" });
      expect(post?.payload).toMatchObject({
        channel: "C1",
        thread_ts: "1700000000.0001",
        text: `*${ref} needs an answer:* Which branch?`,
      });
    });

    it("escapes Slack markup and caps the question", async () => {
      const { sql, ref } = await launched();

      await askOwner({ sql }, { job: ref, question: `<!channel> & <@U1>${"y".repeat(1000)}` });

      const [post] = await asks(sql, ref);
      const text = (post?.payload as { text?: string } | undefined)?.text ?? "";
      expect(text).toContain("&lt;!channel&gt; &amp; &lt;@U1&gt;");
      expect(text).not.toContain("<!channel>");
      expect(text.length).toBeLessThan(QUESTION_MAX * 1.2);
    });

    it("refuses an unknown job, a finished job, and a job without a Slack thread", async () => {
      const { sql, job, ref } = await launched();
      const bare = await launched(false);

      expect(await askOwner({ sql }, { job: "J-99999", question: "?" })).toMatchObject({
        ok: false,
      });
      expect(await askOwner({ sql }, { job: bare.ref, question: "Hi?" })).toMatchObject({
        ok: false,
        message: expect.stringContaining("no Slack thread"),
      });
      await updateJob(sql, job.id, { status: "failed" });
      expect(await askOwner({ sql }, { job: ref, question: "Hi?" })).toMatchObject({ ok: false });
      expect(await asks(sql, ref)).toHaveLength(0);
    });
  });
});
