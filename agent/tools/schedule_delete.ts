import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { isWorkerCaller, NOT_FOR_WORKERS } from "../../lib/callers.ts";
import { ownerResponse } from "../../lib/owner.ts";
import { ledger, pack } from "../../lib/runtime.ts";
import { deleteSchedule, getSchedule, parseScheduleRef } from "../../lib/schedules/rows.ts";

// The approval prompt reads only the tool input, so the input repeats the title, and execute
// refuses when it differs from the stored schedule.

export default defineTool({
  description:
    "Use the returned facts to answer naturally. Do not paste tool returns verbatim or name internal tools. Delete a schedule. It never runs again. Pass the reference and its exact title from schedule_list.",
  inputSchema: z.object({
    schedule: z.string().describe("A schedule reference such as S-3."),
    title: z.string().describe("The schedule's exact title, as schedule_list shows it."),
  }),
  approval: {
    request: always(),
    response: ownerResponse(pack),
    prompt: ({ input }) => `Delete the schedule "${input.title}"? It will not run again.`,
  },
  label: { start: ({ title }) => `Delete ${title}` },
  async execute({ schedule: ref, title }, ctx) {
    if (isWorkerCaller(ctx.session.auth.current)) return NOT_FOR_WORKERS;
    const id = parseScheduleRef(ref);
    if (id === undefined) return "I couldn't identify that schedule.";
    const stored = await getSchedule(ledger(), id);
    if (stored && stored.title.trim() !== title.trim()) {
      return `The title shown doesn't match ${stored.title}. Nothing was deleted.`;
    }
    const row = await deleteSchedule(ledger(), id);
    return {
      schedule: ref,
      answer: row ? `Deleted ${row.title}.` : "I couldn't find that schedule.",
    };
  },
});
