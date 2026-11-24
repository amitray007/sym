import { defineTool } from "eve/tools";
import { z } from "zod";
import { isWorkerCaller, NOT_FOR_WORKERS } from "../../lib/callers.ts";
import { ownTurnUser } from "../../lib/requester.ts";
import { ledgerDeps } from "../../lib/runtime.ts";
import {
  channelOf,
  OWN_TURN_ONLY,
  parsePing,
  removeStandingApproval,
} from "../../lib/slack/standing-approvals.ts";

// Taking an approval back needs no click: it only makes Sym ask more.
export default defineTool({
  description:
    "Use the returned state to answer in one short line. Do not name internal tools. " +
    "When a person tells you to ask them again before posting in a channel, or before a group " +
    "ping there, remove that standing approval. Pass the ping to remove only that ping; leave it " +
    "out to remove the whole channel.",
  inputSchema: z.object({
    channel: z.string().min(1).max(500).describe("A #channel, channel mention, or link."),
    ping: z.string().min(1).max(200).optional().describe("One group ping to stop allowing."),
  }),
  label: { start: () => "Remove a standing approval" },
  async execute({ channel: input, ping: pingInput }, ctx) {
    if (isWorkerCaller(ctx.session.auth.current)) return NOT_FOR_WORKERS;
    const person = ownTurnUser(ctx.session);
    if (!person) return OWN_TURN_ONLY;
    const ping = pingInput === undefined ? undefined : parsePing(pingInput);
    if (pingInput !== undefined && !ping) return `I can't read "${pingInput}" as a group ping.`;
    const deps = ledgerDeps();
    const channel = await channelOf(deps.slack, input);
    if (!channel) return "I couldn't find that channel.";
    const removed = await removeStandingApproval(deps.sql, {
      grantedBy: person,
      channelId: channel,
      ping,
    });
    if (!removed) return "There was no standing approval to remove there.";
    return ping
      ? `Removed. I'll ask again before pinging ${ping.label} in <#${channel}>.`
      : `Removed. I'll ask again before posts in <#${channel}> that need it.`;
  },
});
