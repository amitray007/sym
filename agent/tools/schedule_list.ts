import { defineTool } from "eve/tools";
import { z } from "zod";
import { ledger } from "../../lib/runtime.ts";
import { scheduleList } from "../../lib/schedules/format.ts";
import { listSchedules } from "../../lib/schedules/rows.ts";

export default defineTool({
  description: "List the schedules: reference, cron in UTC, title, status, and next run.",
  inputSchema: z.object({}),
  label: { start: () => "List schedules" },
  async execute() {
    return scheduleList(await listSchedules(ledger()));
  },
});
