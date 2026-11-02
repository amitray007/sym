import { describe, expect, it } from "vitest";
import { dispatchMessage, scheduleLine, scheduleList } from "../lib/schedules/format.ts";
import { ScheduleInput, scheduleTiming } from "../lib/schedules/input.ts";
import type { Schedule } from "../lib/schedules/rows.ts";

const row: Schedule = {
  id: 3,
  cron: "0 9 * * 1-5",
  runAt: null,
  title: "Open PR check",
  instruction: "List the open pull requests of example-app that waited over two days.",
  builder: "ask",
  channel: "C1",
  owner: "U1",
  status: "active",
  leaseUntil: null,
  lastFiredAt: null,
  nextFireAt: new Date("2026-10-21T09:00:00Z"),
  createdAt: new Date("2026-10-20T08:00:00Z"),
  packKey: null,
};

describe("schedule text", () => {
  it("writes one line per schedule, with a cron or a one-time run", () => {
    expect(scheduleLine(row)).toBe(
      "Open PR check: 0 9 * * 1-5 UTC - active - next 2026-10-21T09:00:00.000Z",
    );
    expect(scheduleLine({ ...row, status: "paused", nextFireAt: null })).toBe(
      "Open PR check: 0 9 * * 1-5 UTC - paused",
    );
    const once = { ...row, cron: null, runAt: new Date("2026-10-21T15:00:00Z"), nextFireAt: null };
    expect(scheduleLine(once)).toBe("Open PR check: once at 2026-10-21T15:00:00.000Z - active");
  });

  it("lists the destination, the builder mode, and the instruction", () => {
    expect(scheduleList([])).toBe("There are no schedules.");
    const text = scheduleList([row, { ...row, id: 4, channel: "D1", builder: "auto" }]);
    expect(text).toContain("Posts in <#C1>. Builder work asks for Start.");
    expect(text).toContain("Posts in a DM with <@U1>. Builder work starts without a click.");
    expect(text).toContain(`Does: ${row.instruction}`);
    const long = scheduleList([{ ...row, instruction: "x".repeat(500) }]);
    expect(long).toContain(`${"x".repeat(300)}…`);
    expect(long).not.toContain("x".repeat(301));
  });
});

describe("the run message", () => {
  it("gives the instruction, the schedule reference, and the quiet rule, with no order", () => {
    const message = dispatchMessage(row);
    expect(message).toMatch(/^Scheduled run of S-3: Open PR check\./);
    expect(message).toContain("<@U1> set this up, and this run acts for them");
    expect(message).toContain(`Instruction:\n${row.instruction}`);
    expect(message).toContain('schedule "S-3"');
    expect(message).toContain("Start Builder work only when the instruction asks for it.");
    expect(message).toContain("no_reply");
    expect(message).toContain("read-only");
    expect(message).not.toContain("```brief");
    expect(message).not.toMatch(/call worker_job with exactly/i);
  });

  it("names the builder mode in plain words", () => {
    expect(dispatchMessage(row)).toContain("nothing runs until someone presses Start");
    expect(dispatchMessage({ ...row, builder: "auto" })).toContain(
      "It starts without a Start click.",
    );
  });
});

describe("schedule_create input", () => {
  const base = { title: "Open PR check", instruction: "List the open pull requests." };

  it("defaults the builder mode to ask", () => {
    expect(ScheduleInput.parse({ ...base, cron: "0 9 * * 1-5" }).builder).toBe("ask");
  });

  it.each(["", "every day", "0 9 * *", "61 9 * * *"])("rejects the cron %j", (cron) => {
    expect(ScheduleInput.safeParse({ ...base, cron }).success).toBe(false);
  });

  it("takes a one-time UTC time and rejects a bad one", () => {
    expect(ScheduleInput.safeParse({ ...base, at: "2026-11-04T15:00:00Z" }).success).toBe(true);
    expect(ScheduleInput.safeParse({ ...base, at: "3pm" }).success).toBe(false);
  });

  it("needs exactly one of cron and at", () => {
    expect(scheduleTiming({ cron: "0 9 * * *" })).toEqual({ cron: "0 9 * * *" });
    expect(scheduleTiming({ at: "2026-11-04T15:00:00Z" })).toEqual({
      runAt: new Date("2026-11-04T15:00:00Z"),
    });
    expect(scheduleTiming({})).toBeUndefined();
    expect(scheduleTiming({ cron: "0 9 * * *", at: "2026-11-04T15:00:00Z" })).toBeUndefined();
  });
});
