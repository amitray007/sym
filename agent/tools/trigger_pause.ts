import { defineTool } from "eve/tools";
import { z } from "zod";
import { ledger, pack } from "../../lib/runtime.ts";
import { scheduleManager } from "../../lib/schedules/access.ts";
import { triggerLine } from "../../lib/triggers/format.ts";
import { parseTriggerRef, setTriggerStatus } from "../../lib/triggers/rows.ts";
import { TRIGGER_NOT_ALLOWED } from "../../lib/triggers/setup.ts";

export default defineTool({
  description:
    "Use the returned state and next step to answer naturally. Do not paste tool returns verbatim or name internal tools. " +
    "Pause a trigger, or resume it with resume=true. A paused trigger ignores events; nothing is replayed.",
  inputSchema: z.object({
    trigger: z.string().describe("A trigger reference such as T-3."),
    resume: z.boolean().default(false),
  }),
  label: { start: ({ resume }) => `${resume ? "Resume" : "Pause"} trigger` },
  async execute({ trigger: ref, resume }, ctx) {
    const manager = scheduleManager(
      ctx.session.auth.current,
      pack(),
      process.env.SYM_SLACK_USERS,
      TRIGGER_NOT_ALLOWED,
    );
    if ("refusal" in manager) return manager.refusal;
    const id = parseTriggerRef(ref);
    if (id === undefined) return "I couldn't identify that trigger.";
    const row = await setTriggerStatus(ledger(), id, resume ? "active" : "paused");
    if (!row) return `That trigger is not ${resume ? "paused" : "active"}, or does not exist.`;
    return { trigger: ref, answer: `${resume ? "Resumed" : "Paused"} ${triggerLine(row)}` };
  },
});
