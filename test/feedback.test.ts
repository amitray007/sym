import { describe, expect, it } from "vitest";
import {
  FEEDBACK_ACTION_ID,
  feedbackBlocks,
  jobIdOfMessage,
  jobIdOfThread,
  kindOfButton,
  kindOfReaction,
  recordFeedback,
} from "../lib/feedback/feedback.ts";
import { createJob, updateJob } from "../lib/ledger/jobs.ts";
import { enqueuePost, markPostSent } from "../lib/ledger/outbox.ts";
import { quietMigration } from "../lib/quiet/migration.ts";
import { hasDatabase, useLedger } from "./helpers/ledger.ts";

describe("feedback parts", () => {
  it("maps button values and reactions to kinds", () => {
    expect(kindOfButton("up")).toBe("thumbs_up");
    expect(kindOfButton("down")).toBe("thumbs_down");
    expect(kindOfButton("sideways")).toBeUndefined();
    expect(kindOfButton(undefined)).toBeUndefined();
    expect(kindOfReaction("+1")).toBe("thumbs_up");
    expect(kindOfReaction("+1::skin-tone-3")).toBe("thumbs_up");
    expect(kindOfReaction("thumbsdown")).toBe("thumbs_down");
    expect(kindOfReaction("-1")).toBe("thumbs_down");
    expect(kindOfReaction("tada")).toBe("reaction");
  });

  it("builds native feedback buttons with a Sym action_id", () => {
    const [block] = feedbackBlocks() as { type: string; elements: Record<string, unknown>[] }[];
    expect(block?.type).toBe("context_actions");
    expect(block?.elements[0]).toMatchObject({
      type: "feedback_buttons",
      action_id: FEEDBACK_ACTION_ID,
      positive_button: { value: "up" },
      negative_button: { value: "down" },
    });
    expect(FEEDBACK_ACTION_ID.startsWith("eve_input:")).toBe(false);
  });
});

describe.skipIf(!hasDatabase)("feedback rows", () => {
  const ledger = useLedger();

  const newJob = async (key: string, thread: string) => {
    await ledger.sql().unsafe(quietMigration.sql);
    return createJob(ledger.sql(), {
      requestKey: key,
      kind: "code-change",
      title: "Feedback job",
      slackChannel: "C0FB",
      slackThreadTs: thread,
      brief: { project: "p" },
      worker: "t3",
    });
  };

  it("records a click with its job, and ignores a repeat reaction", async () => {
    const sql = ledger.sql();
    const job = await newJob("fb-1", "1700000000.000200");
    expect(await jobIdOfThread(sql, "C0FB", "1700000000.000200")).toBe(job.id);
    expect(await jobIdOfThread(sql, "C0FB", "1700000000.999999")).toBeNull();

    const first = await recordFeedback(sql, {
      jobId: job.id,
      slackUser: "U1",
      kind: "thumbs_down",
      value: "down",
      channel: "C0FB",
      messageTs: "1700000000.000300",
    });
    expect(first).toMatchObject({ jobId: job.id, kind: "thumbs_down", slackUser: "U1" });

    const repeat = await recordFeedback(sql, {
      jobId: job.id,
      slackUser: "U1",
      kind: "thumbs_down",
      value: "down",
      channel: "C0FB",
      messageTs: "1700000000.000300",
    });
    expect(repeat).toBeUndefined();

    const other = await recordFeedback(sql, {
      slackUser: "U1",
      kind: "reaction",
      value: "tada",
      messageTs: "1700000000.000300",
    });
    expect(other).toMatchObject({ jobId: null, kind: "reaction", value: "tada" });
    const rows = await sql`select * from feedback where slack_user = 'U1'`;
    expect(rows).toHaveLength(2);
  });

  it("keeps every fix, even with the same text", async () => {
    const sql = ledger.sql();
    for (let i = 0; i < 2; i++) {
      await recordFeedback(sql, { slackUser: "U2", kind: "fix", value: "Use tabs." });
    }
    const rows = await sql`select * from feedback where slack_user = 'U2'`;
    expect(rows).toHaveLength(2);
  });

  it("rejects an unknown kind in the database", async () => {
    await expect(
      recordFeedback(ledger.sql(), { slackUser: "U3", kind: "bogus" as never }),
    ).rejects.toThrow();
  });

  it("finds the job of a message by card ts or outbox ts", async () => {
    const sql = ledger.sql();
    const job = await newJob("fb-2", "1700000000.000400");
    await updateJob(sql, job.id, { cardTs: "1700000000.000500" });
    expect(await jobIdOfMessage(sql, "C0FB", "1700000000.000500")).toBe(job.id);
    expect(await jobIdOfMessage(sql, "C0OTHER", "1700000000.000500")).toBeNull();

    const post = await enqueuePost(sql, {
      idempotencyKey: "fb-2:msg",
      jobId: job.id,
      method: "chat.postMessage",
      payload: { channel: "C0FB", text: "hi" },
      display: { level: 1, target: "thread", reason: "short" },
    });
    await markPostSent(sql, post.id, "1700000000.000600");
    expect(await jobIdOfMessage(sql, "C0FB", "1700000000.000600")).toBe(job.id);
    expect(await jobIdOfMessage(sql, "C0FB", "1700000000.000700")).toBeNull();
  });
});
