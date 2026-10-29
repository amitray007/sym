import { defineTool } from "eve/tools";
import { z } from "zod";
import { ledger } from "../../lib/runtime.ts";
import { scheduleList } from "../../lib/schedules/format.ts";
import { listSchedules } from "../../lib/schedules/rows.ts";

export default defineTool({
  description:
    "Use the returned facts to answer naturally. Do not paste tool returns verbatim or name internal tools. List the schedules: reference, cron in UTC, title, status, and next run.",
  inputSchema: z.object({}),
  label: { start: () => "List schedules" },
  async execute() {
    const rows = await listSchedules(ledger());
    return {
      summary: scheduleList(rows),
      schedules: rows,
      note: "Use these facts to answer naturally. Do not paste this return verbatim. Pending schedules need owner approval of the exact saved brief and frequency.",
    };
  },
});
