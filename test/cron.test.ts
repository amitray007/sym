import { describe, expect, it } from "vitest";
import { isValidCron, nextFire, parseCron } from "../lib/schedules/cron.ts";

const at = (iso: string) => new Date(iso);
const next = (cron: string, after: string) => nextFire(cron, at(after))?.toISOString();

describe("nextFire", () => {
  // Expected values were worked out by hand from a calendar, not from the code.
  it.each([
    ["* * * * *", "2026-10-20T10:15:30Z", "2026-10-20T10:16:00.000Z"],
    ["* * * * *", "2026-10-20T10:15:00Z", "2026-10-20T10:16:00.000Z"],
    ["0 17 * * *", "2026-10-20T16:59:00Z", "2026-10-20T17:00:00.000Z"],
    ["0 17 * * *", "2026-10-20T17:00:00Z", "2026-10-21T17:00:00.000Z"],
    ["*/15 * * * *", "2026-10-20T10:46:00Z", "2026-10-20T11:00:00.000Z"],
    ["5,35 9-10 * * *", "2026-10-20T09:36:00Z", "2026-10-20T10:05:00.000Z"],
    ["10-30/10 * * * *", "2026-10-20T10:11:00Z", "2026-10-20T10:20:00.000Z"],
    // 2026-10-20 is a Tuesday. Next weekday 09:00 after Friday 2026-10-23 17:00 is Monday the 26th.
    ["0 9 * * 1-5", "2026-10-20T10:00:00Z", "2026-10-21T09:00:00.000Z"],
    ["0 9 * * 1-5", "2026-10-23T17:00:00Z", "2026-10-26T09:00:00.000Z"],
    // Sunday as 0 and as 7.
    ["0 0 * * 0", "2026-10-20T00:00:00Z", "2026-10-25T00:00:00.000Z"],
    ["0 0 * * 7", "2026-10-20T00:00:00Z", "2026-10-25T00:00:00.000Z"],
    // The year rolls over.
    ["30 8 1 1 *", "2026-10-20T00:00:00Z", "2027-01-01T08:30:00.000Z"],
    ["0 0 1 * *", "2026-12-31T23:59:00Z", "2027-01-01T00:00:00.000Z"],
    // A leap day exists in 2028 only.
    ["0 0 29 2 *", "2026-10-20T00:00:00Z", "2028-02-29T00:00:00.000Z"],
    // Day 31 skips the 30-day months.
    ["0 12 31 * *", "2026-10-31T12:00:00Z", "2026-12-31T12:00:00.000Z"],
    // Both day fields set: either may match. Sunday 2026-11-01 comes before the 15th.
    ["0 0 15 * 0", "2026-10-26T00:00:00Z", "2026-11-01T00:00:00.000Z"],
  ])("%s after %s fires at %s", (cron, after, expected) => {
    expect(next(cron, after)).toBe(expected);
  });

  it("returns undefined for a date that never exists", () => {
    expect(next("0 0 31 2 *", "2026-10-20T00:00:00Z")).toBeUndefined();
  });
});

describe("parseCron", () => {
  it("expands lists, ranges, and steps", () => {
    const cron = parseCron("0,30 8-10/2 * * 1-3");
    expect([...cron.minutes]).toEqual([0, 30]);
    expect([...cron.hours]).toEqual([8, 10]);
    expect([...cron.daysOfWeek]).toEqual([1, 2, 3]);
    expect(cron.dowRestricted).toBe(true);
    expect(cron.domRestricted).toBe(false);
  });

  it.each([
    "",
    "* * * *",
    "* * * * * *",
    "60 * * * *",
    "* 24 * * *",
    "* * 0 * *",
    "* * * 13 *",
    "* * * * 8",
    "5-1 * * * *",
    "*/0 * * * *",
    "a * * * *",
    "1//2 * * * *",
    "* * * * MON",
  ])("rejects %j", (expression) => {
    expect(isValidCron(expression)).toBe(false);
  });
});
