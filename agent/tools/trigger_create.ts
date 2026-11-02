import { defineTool } from "eve/tools";
import { getSessionThread } from "../../lib/ledger/threads.ts";
import { ledger, ledgerDeps, pack } from "../../lib/runtime.ts";
import { scheduleManager } from "../../lib/schedules/access.ts";
import { triggerLine } from "../../lib/triggers/format.ts";
import { TriggerInput } from "../../lib/triggers/input.ts";
import { triggerRef } from "../../lib/triggers/rows.ts";
import { setUpTrigger, TRIGGER_NOT_ALLOWED } from "../../lib/triggers/setup.ts";

// Creates an event trigger (docs/architecture.md, flow 2b; decision 088). The person who sets it
// up consents to its runs, so the row is active at once. Each run gives the brain the instruction
// and the Slack event.

export default defineTool({
  description:
    "Use the returned state and next step to answer naturally. Do not paste tool returns verbatim or name internal tools. " +
    "Set up a trigger: when a new message (optionally with keywords) or a reaction with an emoji " +
    "appears in a channel, run an instruction with your tools. It watches a channel that the " +
    "person and you are both in. It starts right away; no approval.",
  inputSchema: TriggerInput,
  label: { start: ({ title }) => `Trigger: ${title}` },
  async execute(input, ctx) {
    const sql = ledger();
    const manager = scheduleManager(
      ctx.session.auth.current,
      pack(),
      process.env.SYM_SLACK_USERS,
      TRIGGER_NOT_ALLOWED,
    );
    if ("refusal" in manager) return manager.refusal;
    const thread = await getSessionThread(sql, ctx.session.id);
    const result = await setUpTrigger(
      { ...ledgerDeps(), usersEnv: process.env.SYM_SLACK_USERS },
      { ...input, requester: manager.requester, current: thread?.channelId },
    );
    if ("refusal" in result) return result.refusal;
    return {
      trigger: triggerRef(result.trigger.id),
      answer: `Created ${triggerLine(result.trigger)}. I'm in that channel, so Slack sends me its events.`,
    };
  },
});
