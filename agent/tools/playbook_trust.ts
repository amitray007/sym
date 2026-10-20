import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { isWorkerCaller, NOT_FOR_WORKERS } from "../../lib/callers.ts";
import { NAME_PATTERN, playbookRef } from "../../lib/learning/rows.ts";
import {
  approvedPlaybook,
  cleanStreak,
  setStartMode,
  trustRuns,
} from "../../lib/learning/trust.ts";
import { jobRef } from "../../lib/ledger/jobs.ts";
import { getSessionThread } from "../../lib/ledger/threads.ts";
import {
  mayDecideAsOwner,
  OWNER_ONLY,
  ownerResponse,
  slackUserOfPrincipal,
} from "../../lib/owner.ts";
import { ledger, pack } from "../../lib/runtime.ts";

// The trust ladder (decision 059): the owner lets an approved playbook's jobs start without the
// Start click, or puts the playbook back to asking. Trusting needs the clean runs; going back to
// asking always works. The owner approves the call, and only the owner can.
export default defineTool({
  description:
    "Change whether jobs that follow an approved playbook ask for Start. Use mode 'auto' when " +
    "the owner asks to trust a playbook, usually after Sym said its last jobs ended clean, and " +
    "'ask' when the owner wants the Start click back.",
  inputSchema: z.object({
    name: z.string().regex(NAME_PATTERN).describe("The approved playbook's name."),
    mode: z.enum(["auto", "ask"]),
  }),
  approval: {
    request: always(),
    response: ownerResponse(pack),
    prompt: ({ input }) =>
      input.mode === "auto"
        ? [
            `Trust the playbook ${input.name}?`,
            "Jobs whose brief follows it will start without the Start click. A 👎, a Fix, or a run",
            "with concerns puts it back to asking. Production and customer data stay read-only.",
          ].join("\n")
        : `Make jobs that follow the playbook ${input.name} ask for Start again?`,
  },
  label: { start: ({ name, mode }) => `${mode === "auto" ? "Trust" : "Stop trusting"} ${name}` },
  async execute(input, ctx) {
    if (isWorkerCaller(ctx.session.auth.current)) return NOT_FOR_WORKERS;
    const caller = slackUserOfPrincipal(ctx.session.auth.current?.principalId);
    if (!mayDecideAsOwner(caller, pack())) return OWNER_ONLY;
    const sql = ledger();
    const thread = await getSessionThread(sql, ctx.session.id);
    if (!thread?.userId) return "Sym cannot tell who decides this. Ask in Slack.";
    const playbook = await approvedPlaybook(sql, input.name);
    if (!playbook) return `There is no approved playbook named ${input.name}.`;
    const ref = playbookRef(playbook.id);
    if (input.mode === "auto") {
      const streak = await cleanStreak(sql, playbook.id);
      const needed = trustRuns();
      if (streak.length < needed) {
        return `${ref} ${playbook.name} has ${streak.length} clean runs in a row; trust needs ${needed}.`;
      }
      const changed = await setStartMode(sql, playbook.id, "auto", thread.userId);
      return changed
        ? `${ref} ${playbook.name} is trusted. Its jobs start without the Start click (clean runs: ${streak
            .slice(0, needed)
            .map(jobRef)
            .join(", ")}).`
        : `${ref} ${playbook.name} is already trusted.`;
    }
    const changed = await setStartMode(sql, playbook.id, "ask", thread.userId);
    return changed
      ? `${ref} ${playbook.name} asks for Start again.`
      : `${ref} ${playbook.name} already asks for Start.`;
  },
});
