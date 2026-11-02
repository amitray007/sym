import { defineTool } from "eve/tools";
import { z } from "zod";
import { ledger } from "../../lib/runtime.ts";
import { triggerList } from "../../lib/triggers/format.ts";
import { listTriggers, type Trigger, triggerRef } from "../../lib/triggers/rows.ts";
import { webhookUrl } from "../../lib/triggers/webhook.ts";

// A webhook trigger's URL is shown; its secret never is (decision 090).
const urlOf = (trigger: Trigger) =>
  trigger.kind === "webhook" && trigger.hookId ? webhookUrl(trigger.hookId) : undefined;

export default defineTool({
  description:
    "Use the returned facts to answer naturally. Do not paste tool returns verbatim or name internal tools. List the triggers: reference, title, what fires each (a new message with keywords, a reaction emoji, a webhook URL, or a GitHub or Linear filter) and in which channel, status, where runs post, the Builder mode, and the instruction. Webhook secrets are never listed.",
  inputSchema: z.object({}),
  label: { start: () => "List triggers" },
  async execute() {
    const rows = await listTriggers(ledger());
    return {
      summary: triggerList(rows, urlOf),
      triggers: rows.map((row) => ({ ...row, ref: triggerRef(row.id), url: urlOf(row) ?? null })),
      note: "Use these facts to answer naturally. Do not paste this return verbatim.",
    };
  },
});
