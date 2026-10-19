import { describe, expect, it } from "vitest";
import { dispatchMessage, scheduleLine, scheduleList } from "../lib/schedules/format.ts";
import { ScheduleInput } from "../lib/schedules/input.ts";
import type { Schedule } from "../lib/schedules/rows.ts";

const row: Schedule = {
  id: 3,
  cron: "0 9 * * 1-5",
  title: "On-call check",
  brief: { project: "p", goal: "g" },
  channel: "C1",
  owner: "U1",
  status: "active",
  approvedBy: "U1",
  approvedAt: new Date("2026-10-20T08:00:00Z"),
  leaseUntil: null,
  lastFiredAt: null,
  nextFireAt: new Date("2026-10-21T09:00:00Z"),
  createdAt: new Date("2026-10-20T08:00:00Z"),
};

describe("schedule text", () => {
  it("writes one line per schedule", () => {
    expect(scheduleLine(row)).toBe(
      "S-3: 0 9 * * 1-5 UTC - On-call check - active - next 2026-10-21T09:00:00.000Z",
    );
    expect(scheduleLine({ ...row, status: "paused", nextFireAt: null })).toBe(
      "S-3: 0 9 * * 1-5 UTC - On-call check - paused",
    );
    expect(scheduleList([])).toBe("There are no schedules.");
    expect(scheduleList([row, { ...row, id: 4 }]).split("\n")).toHaveLength(2);
  });

  it("tells the brain to run the stored brief and use no_reply", () => {
    const message = dispatchMessage(row);
    expect(message).toContain("schedule 3");
    expect(message).toContain('"project": "p"');
    expect(message).toContain("no_reply");
  });
});

describe("schedule_create input", () => {
  const brief = { project: "p", title: "On-call check", goal: "g", doneWhen: ["d"] };

  it("accepts a valid cron and fills brief defaults", () => {
    const parsed = ScheduleInput.parse({ cron: "0 9 * * 1-5", title: "On-call check", brief });
    expect(parsed.brief.baseRef).toBe("main");
    expect(parsed.brief.openPullRequest).toBe(false);
  });

  it.each(["", "every day", "0 9 * *", "61 9 * * *"])("rejects the cron %j", (cron) => {
    expect(ScheduleInput.safeParse({ cron, title: "On-call check", brief }).success).toBe(false);
  });

  it("rejects a brief without a done-when check", () => {
    const bad = { ...brief, doneWhen: [] };
    expect(
      ScheduleInput.safeParse({ cron: "0 9 * * *", title: "On-call check", brief: bad }).success,
    ).toBe(false);
  });
});
