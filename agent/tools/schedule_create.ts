import { defineTool } from "eve/tools";
import { getSessionThread } from "../../lib/ledger/threads.ts";
import { ledger, ledgerDeps, pack } from "../../lib/runtime.ts";
import { scheduleManager } from "../../lib/schedules/access.ts";
import { scheduleDestination } from "../../lib/schedules/destination.ts";
import { scheduleLine } from "../../lib/schedules/format.ts";
import { ScheduleInput, scheduleTiming } from "../../lib/schedules/input.ts";
import { createSchedule, ScheduleTimingError, scheduleRef } from "../../lib/schedules/rows.ts";

// Creates a schedule (docs/architecture.md, flow 2; decision 085). The person who sets it up
// consents to its runs, so the row is active at once. Each run gives the brain the instruction.

export default defineTool({
  description:
    "Use the returned state and next step to answer naturally. Do not paste tool returns verbatim or name internal tools. " +
    "Schedule an instruction to run on a cron or once at a time. Convert the person's local " +
    "time to UTC first and say so. Each run reads the instruction and does what it asks with " +
    "your tools. It starts right away; no approval.",
  inputSchema: ScheduleInput,
  label: { start: ({ title }) => `Schedule: ${title}` },
  async execute(input, ctx) {
    const sql = ledger();
    const manager = scheduleManager(ctx.session.auth.current, pack(), process.env.SYM_SLACK_USERS);
    if ("refusal" in manager) return manager.refusal;
    const timing = scheduleTiming(input);
    if (!timing) return "Give either a cron or a one-time `at` time, not both.";
    const thread = await getSessionThread(sql, ctx.session.id);
    const destination = await scheduleDestination(ledgerDeps(), {
      requester: manager.requester,
      current: thread?.channelId,
      destination: input.destination,
    });
    if ("refusal" in destination) return destination.refusal;
    try {
      const created = await createSchedule(
        sql,
        {
          ...timing,
          title: input.title,
          instruction: input.instruction,
          builder: input.builder,
          channel: destination.channel,
          owner: manager.requester,
        },
        new Date(),
      );
      return { schedule: scheduleRef(created.id), answer: `Created ${scheduleLine(created)}` };
    } catch (error) {
      if (error instanceof ScheduleTimingError) return error.message;
      throw error;
    }
  },
});
