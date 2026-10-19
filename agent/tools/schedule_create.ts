import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { isWorkerCaller, NOT_FOR_WORKERS } from "../../lib/callers.ts";
import { getSessionThread } from "../../lib/ledger/threads.ts";
import { ownerResponse } from "../../lib/owner.ts";
import { ledger, pack } from "../../lib/runtime.ts";
import { nextFire } from "../../lib/schedules/cron.ts";
import { scheduleLine } from "../../lib/schedules/format.ts";
import { ScheduleInput } from "../../lib/schedules/input.ts";
import { approveSchedule, createSchedule } from "../../lib/schedules/rows.ts";

// Creates a recurring job (docs/architecture.md, flow 2). The owner's approval of this call is
// the approval for every fire, so the prompt shows the cron in UTC and the whole brief. The row
// starts as pending_approval and turns active here, once the owner approves.

export default defineTool({
  description:
    "Schedule a recurring worker job. Convert the person's local time to UTC first and say so. " +
    "The owner approves the schedule once, and the approval covers every run. Each run opens " +
    "a new thread, and you call no_reply when a run finds nothing.",
  inputSchema: ScheduleInput,
  approval: {
    request: always(),
    response: ownerResponse(pack),
    prompt: ({ input }) =>
      [
        `Create schedule "${input.title}"?`,
        `Cron (UTC): ${input.cron}`,
        `Project: ${input.brief.project}`,
        `Goal: ${input.brief.goal}`,
        `Done when: ${input.brief.doneWhen.join("; ")}`,
        "Runs without asking again. Production and customer data stay read-only.",
      ].join("\n"),
  },
  label: { start: ({ title }) => `Schedule: ${title}` },
  async execute(input, ctx) {
    if (isWorkerCaller(ctx.session.auth.current)) return NOT_FOR_WORKERS;
    const sql = ledger();
    const thread = await getSessionThread(sql, ctx.session.id);
    const channel = input.channel ?? thread?.channelId;
    if (!channel) return "No channel. Give a Slack channel ID for the run threads.";
    if (!thread?.userId) return "Sym cannot tell who owns this schedule. Ask in Slack.";
    if (!nextFire(input.cron, new Date())) return `Cron "${input.cron}" never fires.`;

    const created = await createSchedule(sql, {
      cron: input.cron,
      title: input.title,
      brief: input.brief,
      channel,
      owner: thread.userId,
    });
    const active = await approveSchedule(sql, created.id, thread.userId, new Date());
    return active ? `Created ${scheduleLine(active)}` : "The schedule was not approved.";
  },
});
