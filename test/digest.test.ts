import { describe, expect, it } from "vitest";
import { digestMessage } from "../lib/digest/format.ts";
import { digestChannel, digestEnabled, queueDigest } from "../lib/digest/post.ts";
import { createSchedule, finishRun, recordRun } from "../lib/schedules/rows.ts";
import { hasDatabase, useLedger } from "./helpers/ledger.ts";

it("links titles in a digest and escapes unlinked titles", () => {
  expect(
    digestMessage({
      day: "2026-10-30",
      jobs: [
        {
          id: 1,
          title: "Billing sync retry",
          status: "done",
          slackChannel: "C1",
          slackThreadTs: "170.1",
        },
        { id: 2, title: "Docs <review>", status: "failed" },
      ],
      runs: [],
    }),
  ).toBe(
    "Docs &lt;review&gt; failed.\n<https://slack.com/app_redirect?channel=C1&message_ts=170.1|Billing sync retry> finished.\nAsk me for the details.",
  );
});

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
        "Schema change needs you.",
        "Flaky test failed.",
        "Billing sync retry finished.",
        "Docs is still running.",
        "Ask me for the details.",
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

describe("SYM_DIGEST", () => {
  it("is off unless set to an on value", () => {
    expect(digestEnabled({})).toBe(false);
    expect(digestEnabled({ SYM_DIGEST: "off" })).toBe(false);
    expect(digestEnabled({ SYM_DIGEST: "maybe" })).toBe(false);
    expect(digestEnabled({ SYM_DIGEST: " On " })).toBe(true);
  });
});
