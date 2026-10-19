import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { isWorkerCaller, NOT_FOR_WORKERS } from "../../lib/callers.ts";
import { playbookLine } from "../../lib/learning/format.ts";
import { approvePlaybook, getPlaybook, playbookRef } from "../../lib/learning/rows.ts";
import { getSessionThread } from "../../lib/ledger/threads.ts";
import { mayDecideAsOwner, OWNER_ONLY, slackUserOfPrincipal } from "../../lib/owner.ts";
import { ledger, pack } from "../../lib/runtime.ts";

// Approves a proposed row. The approval prompt can read only the tool input, so the input
// repeats the body, and execute refuses when it differs from the stored row. The owner
// approves exactly the text that loads.
export default defineTool({
  description:
    "Show a proposed playbook or rule to the owner for approval. Pass the ID and the exact body " +
    "from playbook_propose or playbook_list. The owner approves the call, and approval makes the " +
    "row load in new sessions. It replaces the approved version of the same name.",
  inputSchema: z.object({
    id: z.number().int().positive(),
    body: z.string().min(1).describe("The exact body of the proposal."),
  }),
  approval: {
    request: always(),
    prompt: ({ input }) =>
      [
        `Approve ${playbookRef(input.id)}?`,
        "New sessions will follow this text as reviewed guidance:",
        input.body,
      ].join("\n"),
  },
  label: { start: ({ id }) => `Review ${playbookRef(id)}` },
  async execute(input, ctx) {
    if (isWorkerCaller(ctx.session.auth.current)) return NOT_FOR_WORKERS;
    const caller = slackUserOfPrincipal(ctx.session.auth.current?.principalId);
    if (!mayDecideAsOwner(caller, pack())) return OWNER_ONLY;
    const sql = ledger();
    const thread = await getSessionThread(sql, ctx.session.id);
    if (!thread?.userId) return "Sym cannot tell who approves this. Ask in Slack.";
    const row = await getPlaybook(sql, input.id);
    if (!row) return `${playbookRef(input.id)} does not exist.`;
    if (row.status !== "proposed") return `${playbookLine(row)} is not waiting for review.`;
    if (row.body !== input.body.trim()) {
      return `The text of ${playbookRef(row.id)} differs from what was shown. Nothing was approved.`;
    }
    const approved = await approvePlaybook(sql, row.id, thread.userId, new Date());
    return approved
      ? `Approved ${playbookLine(approved)}. New sessions load it.`
      : `${playbookRef(row.id)} was not approved.`;
  },
});
