import { defineTool } from "eve/tools";
import { z } from "zod";
import { ledger } from "../../lib/runtime.ts";
import { scheduleList } from "../../lib/schedules/format.ts";
import { listSchedules, scheduleRef } from "../../lib/schedules/rows.ts";

export default defineTool({
  description:
    "Use the returned facts to answer naturally. Do not paste tool returns verbatim or name internal tools. List the schedules: reference, title, cron in UTC or one-time run, status, next run, where runs post, the Builder mode, and the instruction.",
  inputSchema: z.object({}),
  label: { start: () => "List schedules" },
  async execute() {
    const rows = await listSchedules(ledger());
    return {
      summary: scheduleList(rows),
      schedules: rows.map((row) => ({ ...row, ref: scheduleRef(row.id) })),
      note: "Use these facts to answer naturally. Do not paste this return verbatim.",
    };
  },
});
