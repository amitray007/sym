import { describe, expect, it } from "vitest";
import { digestMessage } from "../lib/digest/format.ts";
import { digestChannel, queueDigest } from "../lib/digest/post.ts";
import { createSchedule, finishRun, recordRun } from "../lib/schedules/rows.ts";
import { hasDatabase, useLedger } from "./helpers/ledger.ts";

describe("digestMessage", () => {
  it("returns nothing when nothing happened", () => {
    expect(digestMessage({ day: "2026-10-20", jobs: [], runs: [] })).toBeUndefined();
  });

  it("lists finished, failed, waiting, and running jobs", () => {
    const text = digestMessage({
      day: "2026-10-20",
      jobs: [
        { id: 1, title: "Billing sync retry", status: "done" },
        { id: 2, title: "Flaky test", status: "failed" },
        { id: 3, title: "Schema change", status: "waiting_input" },
        { id: 4, title: "Docs", status: "running" },
        { id: 5, title: "Nope", status: "cancelled" },
      ],
      runs: [],
    });
    expect(text).toBe(
      [
        "Daily digest for 2026-10-20",
        "Finished (1):",
        "- J-1 Billing sync retry",
        "Failed (1):",
        "- J-2 Flaky test",
        "Waiting for you (1):",
        "- J-3 Schema change",
        "Still running: 1",
      ].join("\n"),
    );
  });

  it("summarizes schedule runs per schedule", () => {
    const text = digestMessage({
      day: "2026-10-20",
      jobs: [],
      runs: [
        { title: "On-call check", outcome: "all_clear" },
        { title: "Dependency audit", outcome: "all_clear" },
        { title: "Dependency audit", outcome: "needs_attention" },
        { title: "Backup check", outcome: "failed" },
      ],
    });
    expect(text).toContain("On-call check: all clear");
    expect(text).toContain("Dependency audit: 1 all clear, 1 needs attention");
    expect(text).toContain("Backup check: failed");
  });
});

describe.skipIf(!hasDatabase)("queueDigest", () => {
  const ledger = useLedger();
  const now = new Date("2026-10-20T17:00:00Z");

  it("posts nothing on a quiet day", async () => {
    const db = ledger.sql();
    expect(await queueDigest(db, "C9", now)).toBe(false);
  });

  it("queues one post per day, DM for a user ID", async () => {
    const db = ledger.sql();
    const schedule = await createSchedule(db, {
      cron: "0 9 * * *",
      title: "On-call check",
      brief: {},
      channel: "C1",
      owner: "U1",
    });
    const run = await recordRun(db, {
      scheduleId: schedule.id,
      firedAt: new Date("2026-10-20T09:00:00Z"),
    });
    await finishRun(db, run.id, "all_clear");

    expect(await queueDigest(db, "U123", now)).toBe(true);
    expect(await queueDigest(db, "U123", now)).toBe(true);
    const posts = await db<
      { payload: { channel: string; text: string }; display: { target: string } }[]
    >`
      select payload, display from outbox where idempotency_key = 'digest:2026-10-20'
    `;
    expect(posts).toHaveLength(1);
    expect(posts[0]?.payload.channel).toBe("U123");
    expect(posts[0]?.payload.text).toContain("On-call check: all clear");
    expect(posts[0]?.display.target).toBe("dm");
  });
});

describe("digestChannel", () => {
  const packWith = (digest?: string) =>
    ({
      config: { channels: { default: "C0DEFAULT", ...(digest ? { digest } : {}) } },
    }) as unknown as Parameters<typeof digestChannel>[0];

  it("prefers the pack's digest channel", () => {
    expect(digestChannel(packWith("C0PACK"), { SYM_DIGEST_CHANNEL: "C0ENV" })).toBe("C0PACK");
  });

  it("falls back to SYM_DIGEST_CHANNEL, and to nothing", () => {
    expect(digestChannel(packWith(), { SYM_DIGEST_CHANNEL: " C0ENV " })).toBe("C0ENV");
    expect(digestChannel(undefined, {})).toBeUndefined();
    expect(digestChannel(undefined, { SYM_DIGEST_CHANNEL: "  " })).toBeUndefined();
  });
});
