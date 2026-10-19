import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { isWorkerCaller, NOT_FOR_WORKERS } from "../../lib/callers.ts";
import { playbookLine } from "../../lib/learning/format.ts";
import {
  getPlaybook,
  playbookRef,
  rejectPlaybook,
  retirePlaybook,
} from "../../lib/learning/rows.ts";
import { getSessionThread } from "../../lib/ledger/threads.ts";
import { ledger } from "../../lib/runtime.ts";

// Retires an approved row so new sessions stop loading it. On a proposed row it rejects the
// proposal. The row stays in the history.
export default defineTool({
  description:
    "Retire an approved playbook or rule so new sessions stop loading it, or reject a proposed " +
    "one. The owner approves the call.",
  inputSchema: z.object({ id: z.number().int().positive() }),
  approval: {
    request: always(),
    prompt: ({ input }) => `Retire or reject ${playbookRef(input.id)}?`,
  },
  label: { start: ({ id }) => `Retire ${playbookRef(id)}` },
  async execute({ id }, ctx) {
    if (isWorkerCaller(ctx.session.auth.current)) return NOT_FOR_WORKERS;
    const sql = ledger();
    const thread = await getSessionThread(sql, ctx.session.id);
    if (!thread?.userId) return "Sym cannot tell who decides this. Ask in Slack.";
    const row = await getPlaybook(sql, id);
    if (!row) return `${playbookRef(id)} does not exist.`;
    const now = new Date();
    const done =
      row.status === "proposed"
        ? await rejectPlaybook(sql, id, thread.userId, now)
        : await retirePlaybook(sql, id, thread.userId, now);
    return done ? `Now ${playbookLine(done)}` : `${playbookLine(row)} cannot change.`;
  },
});
