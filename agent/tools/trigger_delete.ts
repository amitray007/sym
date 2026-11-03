import { defineTool } from "eve/tools";
import { z } from "zod";
import { ledger, pack } from "../../lib/runtime.ts";
import { scheduleManager } from "../../lib/schedules/access.ts";
import { deleteTrigger, getTrigger, parseTriggerRef } from "../../lib/triggers/rows.ts";
import { TRIGGER_NOT_ALLOWED } from "../../lib/triggers/setup.ts";

// The input repeats the title, and execute refuses when it differs from the stored trigger, so a
// wrong reference deletes nothing.

export default defineTool({
  description:
    "Use the returned facts to answer naturally. Do not paste tool returns verbatim or name internal tools. Delete a trigger. It never fires again. Pass the reference and its exact title from trigger_list.",
  inputSchema: z.object({
    trigger: z.string().describe("A trigger reference such as T-3."),
    title: z.string().describe("The trigger's exact title, as trigger_list shows it."),
  }),
  label: { start: ({ title }) => `Delete ${title}` },
  async execute({ trigger: ref, title }, ctx) {
    const manager = scheduleManager(
      ctx.session.auth.current,
      pack(),
      process.env.SYM_SLACK_USERS,
      TRIGGER_NOT_ALLOWED,
    );
    if ("refusal" in manager) return manager.refusal;
    const id = parseTriggerRef(ref);
    if (id === undefined) return "I couldn't identify that trigger.";
    const stored = await getTrigger(ledger(), id);
    if (stored && stored.title.trim() !== title.trim()) {
      return `The title shown doesn't match ${stored.title}. Nothing was deleted.`;
    }
    const row = await deleteTrigger(ledger(), id);
    return {
      trigger: ref,
      answer: row ? `Deleted ${row.title}.` : "I couldn't find that trigger.",
    };
  },
});
