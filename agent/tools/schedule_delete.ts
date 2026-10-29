import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { isWorkerCaller, NOT_FOR_WORKERS } from "../../lib/callers.ts";
import { ownerResponse } from "../../lib/owner.ts";
import { ledger, pack } from "../../lib/runtime.ts";
import { deleteSchedule, parseScheduleRef } from "../../lib/schedules/rows.ts";

export default defineTool({
  description:
    "Use the returned facts to answer naturally. Do not paste tool returns verbatim or name internal tools. Delete a schedule. It never runs again.",
  inputSchema: z.object({ schedule: z.string().describe("A schedule reference such as S-3.") }),
  approval: { request: always(), response: ownerResponse(pack) },
  label: { start: ({ schedule }) => `Delete ${schedule}` },
  async execute({ schedule: ref }, ctx) {
    if (isWorkerCaller(ctx.session.auth.current)) return NOT_FOR_WORKERS;
    const id = parseScheduleRef(ref);
    if (id === undefined) return `${ref} is not a schedule reference.`;
    const row = await deleteSchedule(ledger(), id);
    return row ? `Deleted ${ref}: ${row.title}` : `There is no schedule ${ref}.`;
  },
});
