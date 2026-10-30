import { defineTool } from "eve/tools";
import { z } from "zod";
import { isWorkerCaller, NOT_FOR_WORKERS } from "../../lib/callers.ts";
import { ledger } from "../../lib/runtime.ts";
import { scheduleLine } from "../../lib/schedules/format.ts";
import { parseScheduleRef, pauseSchedule, resumeSchedule } from "../../lib/schedules/rows.ts";

export default defineTool({
  description:
    "Use the returned state and next step to answer naturally. Do not paste tool returns verbatim or name internal tools. " +
    "Pause a schedule, or resume it with resume=true. A paused schedule keeps its approval. " +
    "A resumed one runs at its next cron time.",
  inputSchema: z.object({
    schedule: z.string().describe("A schedule reference such as S-3."),
    resume: z.boolean().default(false),
  }),
  label: { start: ({ resume }) => `${resume ? "Resume" : "Pause"} schedule` },
  async execute({ schedule: ref, resume }, ctx) {
    if (isWorkerCaller(ctx.session.auth.current)) return NOT_FOR_WORKERS;
    const id = parseScheduleRef(ref);
    if (id === undefined) return "I couldn't identify that schedule.";
    const sql = ledger();
    const row = resume ? await resumeSchedule(sql, id, new Date()) : await pauseSchedule(sql, id);
    if (!row) return `That schedule is not ${resume ? "paused" : "active"}, or does not exist.`;
    return { schedule: ref, answer: `${resume ? "Resumed" : "Paused"} ${scheduleLine(row)}` };
  },
});
