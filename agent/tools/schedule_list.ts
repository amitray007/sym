import { defineTool } from "eve/tools";
import { z } from "zod";
import { ledger } from "../../lib/runtime.ts";
import { scheduleList } from "../../lib/schedules/format.ts";
import { listSchedules, scheduleRef } from "../../lib/schedules/rows.ts";

const iso = (date: Date | null) => date?.toISOString() ?? null;

export default defineTool({
  description:
    "Use the returned facts to answer naturally. Do not paste tool returns verbatim or name internal tools. List the schedules: reference, title, cron in UTC or one-time run, status, next run, where runs post, the Builder mode, and the instruction.",
  inputSchema: z.object({}),
  label: { start: () => "List schedules" },
  async execute() {
    const rows = await listSchedules(ledger());
    return {
      summary: scheduleList(rows),
      // Eve accepts only plain JSON in a tool return, so dates go out as ISO strings.
      schedules: rows.map(({ leaseUntil: _lease, ...row }) => ({
        ...row,
        runAt: iso(row.runAt),
        lastFiredAt: iso(row.lastFiredAt),
        nextFireAt: iso(row.nextFireAt),
        createdAt: row.createdAt.toISOString(),
        ref: scheduleRef(row.id),
      })),
      note: "Use these facts to answer naturally. Do not paste this return verbatim.",
    };
  },
});
