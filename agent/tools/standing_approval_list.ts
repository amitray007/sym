import { defineTool } from "eve/tools";
import { z } from "zod";
import { isWorkerCaller, NOT_FOR_WORKERS } from "../../lib/callers.ts";
import { ownTurnUser } from "../../lib/requester.ts";
import { ledger } from "../../lib/runtime.ts";
import {
  describePings,
  listStandingApprovals,
  OWN_TURN_ONLY,
} from "../../lib/slack/standing-approvals.ts";

export default defineTool({
  description:
    "Use the returned facts to answer naturally. Do not paste tool returns verbatim or name internal tools. " +
    "List where this person told you to post without asking first, and which group pings may go " +
    "with those posts.",
  inputSchema: z.object({}),
  label: { start: () => "List standing approvals" },
  async execute(_input, ctx) {
    if (isWorkerCaller(ctx.session.auth.current)) return NOT_FOR_WORKERS;
    const person = ownTurnUser(ctx.session);
    if (!person) return OWN_TURN_ONLY;
    const approvals = await listStandingApprovals(ledger(), person);
    if (!approvals.length) return "No standing approvals. I ask before posts that need it.";
    return approvals
      .map((approval) => `<#${approval.channelId}>: posts${describePings(approval.pings)}`)
      .join("\n");
  },
});
