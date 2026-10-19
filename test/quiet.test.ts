import { describe, expect, it } from "vitest";
import { presentEnd, presentStart } from "../lib/jobs/present.ts";
import { createJob, updateJob } from "../lib/ledger/jobs.ts";
import type { Pack } from "../lib/pack/load.ts";
import { parseSymCommand, slackText } from "../lib/quiet/command.ts";
import { quietMigration } from "../lib/quiet/migration.ts";
import {
  formatClock,
  getQuietUntil,
  inQuietHours,
  isQuiet,
  minuteOfDay,
  parseQuietArg,
  setQuietUntil,
} from "../lib/quiet/quiet.ts";
import { hasDatabase, useLedger } from "./helpers/ledger.ts";

describe("parseQuietArg", () => {
  it.each([
    ["", { kind: "minutes", minutes: 60 }],
    ["90", { kind: "minutes", minutes: 90 }],
    ["45m", { kind: "minutes", minutes: 45 }],
    ["2h", { kind: "minutes", minutes: 120 }],
    ["1.5 hours", { kind: "minutes", minutes: 90 }],
    ["off", { kind: "off" }],
    ["OFF", { kind: "off" }],
    ["0", { kind: "off" }],
    ["99999", { kind: "minutes", minutes: 10_080 }],
  ])("reads %j", (text, expected) => {
    expect(parseQuietArg(text)).toEqual(expected);
  });

  it.each(["soon", "-5", "2 days", "1h30m"])("rejects %j", (text) => {
    expect(parseQuietArg(text)).toBeUndefined();
  });
});

describe("parseSymCommand", () => {
  it.each([
    ["status", { type: "status" }],
    ["  Jobs ", { type: "status" }],
    ["quiet", { type: "quiet", arg: { kind: "minutes", minutes: 60 } }],
    ["quiet 2h", { type: "quiet", arg: { kind: "minutes", minutes: 120 } }],
    ["quiet off", { type: "quiet", arg: { kind: "off" } }],
    ["", { type: "usage" }],
    ["quiet whenever", { type: "usage" }],
    ["status now", { type: "usage" }],
    ["schedule list", { type: "usage" }],
  ])("reads %j", (text, expected) => {
    expect(parseSymCommand(text)).toEqual(expected);
  });

  it("escapes Slack markup", () => {
    expect(slackText("<!channel> a&b")).toBe("&lt;!channel&gt; a&amp;b");
  });
});

describe("inQuietHours", () => {
  const night = { from: "22:00", to: "07:00" };
  const at = (iso: string) => new Date(iso);

  // New York is UTC-5 in January (EST) and UTC-4 in July (EDT). Expected values are written
  // from the local clock, not computed by the code under test.
  it.each([
    ["2026-01-15T03:30:00Z", true], // 22:30 EST
    ["2026-01-15T03:00:00Z", true], // 22:00 EST, the window starts
    ["2026-01-15T02:59:00Z", false], // 21:59 EST
    ["2026-01-15T05:00:00Z", true], // 00:00 EST, after midnight
    ["2026-01-15T11:59:00Z", true], // 06:59 EST
    ["2026-01-15T12:00:00Z", false], // 07:00 EST, the window ended
    ["2026-01-15T17:00:00Z", false], // noon
    ["2026-07-15T02:00:00Z", true], // 22:00 EDT
    ["2026-07-15T01:59:00Z", false], // 21:59 EDT
    ["2026-07-15T10:59:00Z", true], // 06:59 EDT
    ["2026-07-15T11:00:00Z", false], // 07:00 EDT
  ])("%s in New York: %s", (iso, expected) => {
    expect(inQuietHours(at(iso), night, "America/New_York")).toBe(expected);
  });

  it("reads a window inside one day", () => {
    const day = { from: "09:00", to: "17:00" };
    expect(inQuietHours(at("2026-03-02T09:00:00Z"), day, "UTC")).toBe(true);
    expect(inQuietHours(at("2026-03-02T16:59:00Z"), day, "UTC")).toBe(true);
    expect(inQuietHours(at("2026-03-02T17:00:00Z"), day, "UTC")).toBe(false);
    expect(inQuietHours(at("2026-03-02T08:59:00Z"), day, "UTC")).toBe(false);
  });

  it("uses UTC without a time zone, and for an unknown zone", () => {
    expect(inQuietHours(at("2026-03-02T23:00:00Z"), night)).toBe(true);
    expect(inQuietHours(at("2026-03-02T23:00:00Z"), night, "Not/AZone")).toBe(true);
    expect(minuteOfDay(at("2026-03-02T23:30:00Z"), "Not/AZone")).toBe(23 * 60 + 30);
  });

  it("is never quiet without hours or with an empty window", () => {
    expect(inQuietHours(at("2026-03-02T23:00:00Z"), undefined)).toBe(false);
    expect(inQuietHours(at("2026-03-02T23:00:00Z"), { from: "08:00", to: "08:00" })).toBe(false);
  });

  it("formats a clock with its zone", () => {
    expect(formatClock(at("2026-01-15T03:30:00Z"), "America/New_York")).toBe(
      "22:30 America/New_York",
    );
    expect(formatClock(at("2026-01-15T03:30:00Z"))).toBe("03:30 UTC");
  });
});

const packWith = (config: Record<string, unknown>) =>
  ({ dir: "/pack", config, instructions: [], playbooks: [] }) as unknown as Pack;

describe.skipIf(!hasDatabase)("isQuiet", () => {
  const ledger = useLedger();
  const now = new Date("2026-03-02T12:00:00Z");

  it("is not quiet by default", async () => {
    expect(await isQuiet(ledger.sql(), undefined, now)).toBe(false);
  });

  it("is quiet until the saved time, then not, and off clears it", async () => {
    const sql = ledger.sql();
    await sql.unsafe(quietMigration.sql);
    await setQuietUntil(sql, new Date(now.getTime() + 30 * 60_000));
    expect(await isQuiet(sql, undefined, now)).toBe(true);
    expect(await isQuiet(sql, undefined, new Date(now.getTime() + 31 * 60_000))).toBe(false);

    await setQuietUntil(sql, new Date(now.getTime() + 10 * 60_000));
    expect((await getQuietUntil(sql))?.toISOString()).toBe("2026-03-02T12:10:00.000Z");

    await setQuietUntil(sql, null);
    expect(await getQuietUntil(sql)).toBeNull();
    expect(await isQuiet(sql, undefined, now)).toBe(false);
  });

  it("follows the pack's quiet hours in its time zone", async () => {
    const pack = packWith({
      quietHours: { from: "22:00", to: "07:00" },
      timeZone: "Asia/Kolkata",
    });
    // 12:00 UTC is 17:30 in Kolkata (UTC+5:30). 17:00 UTC is 22:30 there.
    expect(await isQuiet(ledger.sql(), pack, now)).toBe(false);
    expect(await isQuiet(ledger.sql(), pack, new Date("2026-03-02T17:00:00Z"))).toBe(true);
  });

  describe("on job posts", () => {
    const newJob = (key: string) =>
      createJob(ledger.sql(), {
        requestKey: key,
        kind: "code-change",
        title: "Quiet job",
        owner: "UOWNER",
        slackChannel: "C0QUIET",
        slackThreadTs: "1700000000.000100",
        brief: {
          project: "p",
          title: "Quiet job",
          goal: "Do it.",
          doneWhen: ["a", "b"],
          estimatedMinutes: 15,
          openPullRequest: false,
          constraints: [],
          baseRef: "main",
        },
        worker: "t3",
      });
    const posts = async () =>
      ledger.sql()<{ idempotencyKey: string }[]>`select idempotency_key from outbox order by id`;

    it("posts no start card in quiet mode, and still posts a failure", async () => {
      const sql = ledger.sql();
      await setQuietUntil(sql, new Date(now.getTime() + 60 * 60_000));
      const job = await newJob("quiet-1");
      const started = await presentStart(sql, job, now);
      expect(started.display?.level).toBe(0);
      expect(await posts()).toEqual([]);

      const failed = await updateJob(sql, job.id, { status: "failed", lastSummary: "Broke." });
      await presentEnd(sql, failed, null, now);
      const keys = (await posts()).map((p) => p.idempotencyKey);
      expect(keys).toEqual([`J-${job.id}:end`]);
    });

    it("keeps a finished job's result for the digest in quiet mode", async () => {
      const sql = ledger.sql();
      const job = await newJob("quiet-2");
      const done = await updateJob(sql, job.id, { status: "done" });
      const before = (await posts()).length;
      await presentEnd(sql, done, null, now);
      expect((await posts()).length).toBe(before);
    });

    it("posts the card again once quiet mode is off", async () => {
      const sql = ledger.sql();
      await setQuietUntil(sql, null);
      const job = await newJob("quiet-3");
      const started = await presentStart(sql, job, now);
      expect(started.display?.level).toBe(3);
    });
  });
});
