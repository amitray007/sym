import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { isWorkerCaller, NOT_FOR_WORKERS } from "../../lib/callers.ts";
import { Brief } from "../../lib/jobs/brief.ts";
import { getSessionThread } from "../../lib/ledger/threads.ts";
import { ownerResponse } from "../../lib/owner.ts";
import { checkProject } from "../../lib/projects/allowed.ts";
import { allowedFromEnv, ledger, pack } from "../../lib/runtime.ts";
import { sameAsStored } from "../../lib/schedules/approval.ts";
import { scheduleLine } from "../../lib/schedules/format.ts";
import { approveSchedule, getSchedule, parseScheduleRef } from "../../lib/schedules/rows.ts";

// Approves a schedule that waits for approval, such as one seeded from the pack's schedules.yaml
// (decision 055). The approval prompt reads only the tool input, so the input repeats the cron
// and the brief from schedule_list, and execute refuses when they differ from the stored row.
export default defineTool({
  description:
    "Use the returned state and next step to answer naturally. Do not paste tool returns verbatim or name internal tools. " +
    "Approve a schedule that waits for approval. Pass the reference, the cron, and the exact " +
    "brief from schedule_list. The owner approves the call once, and the approval covers every run.",
  inputSchema: z.object({
    ref: z.string().describe("Schedule reference such as S-3."),
    cron: z.string().describe("The cron in UTC, exactly as schedule_list shows it."),
    brief: Brief.describe("The exact brief from schedule_list."),
  }),
  approval: {
    request: always(),
    response: ownerResponse(pack),
    prompt: ({ input }) =>
      [
        `Approve schedule ${input.ref}?`,
        `Cron (UTC): ${input.cron}`,
        `Project: ${input.brief.project}`,
        `Goal: ${input.brief.goal}`,
        `Done when: ${input.brief.doneWhen.join("; ")}`,
        "Runs without asking again. Production and customer data stay read-only.",
      ].join("\n"),
  },
  label: { start: ({ ref }) => `Approve ${ref}` },
  async execute(input, ctx) {
    if (isWorkerCaller(ctx.session.auth.current)) return NOT_FOR_WORKERS;
    const id = parseScheduleRef(input.ref);
    if (id === undefined) return `"${input.ref}" is not a schedule reference.`;
    const sql = ledger();
    const thread = await getSessionThread(sql, ctx.session.id);
    if (!thread?.userId) return "Sym cannot tell who approves this. Ask in Slack.";
    const row = await getSchedule(sql, id);
    if (!row) return `S-${id} does not exist.`;
    if (row.status !== "pending_approval") {
      return `${scheduleLine(row)} is not waiting for approval.`;
    }
    if (!sameAsStored(row, input)) {
      return `The cron or brief of S-${id} differs from what was shown. Nothing was approved.`;
    }
    const project = (row.brief as { project?: unknown } | null)?.project;
    const refusal = checkProject(allowedFromEnv(), typeof project === "string" ? project : "");
    if (refusal) return refusal;
    const active = await approveSchedule(sql, id, thread.userId, new Date());
    return active ? `Approved ${scheduleLine(active)}` : `S-${id} was not approved.`;
  },
});
