import { defineTool } from "eve/tools";
import { z } from "zod";
import { ledger } from "../../lib/runtime.ts";
import { triggerList } from "../../lib/triggers/format.ts";
import { listTriggers, triggerRef } from "../../lib/triggers/rows.ts";

export default defineTool({
  description:
    "Use the returned facts to answer naturally. Do not paste tool returns verbatim or name internal tools. List the triggers: reference, title, what fires each (a new message with keywords, or a reaction emoji) and in which channel, status, where runs post, the Builder mode, and the instruction.",
  inputSchema: z.object({}),
  label: { start: () => "List triggers" },
  async execute() {
    const rows = await listTriggers(ledger());
    return {
      summary: triggerList(rows),
      triggers: rows.map((row) => ({ ...row, ref: triggerRef(row.id) })),
      note: "Use these facts to answer naturally. Do not paste this return verbatim.",
    };
  },
});
