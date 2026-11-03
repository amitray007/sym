import { defineTool } from "eve/tools";
import { getSessionThread } from "../../lib/ledger/threads.ts";
import { ledger, ledgerDeps, pack } from "../../lib/runtime.ts";
import { scheduleManager } from "../../lib/schedules/access.ts";
import { triggerLine } from "../../lib/triggers/format.ts";
import { TriggerInput } from "../../lib/triggers/input.ts";
import { triggerRef } from "../../lib/triggers/rows.ts";
import { setUpTrigger, TRIGGER_NOT_ALLOWED } from "../../lib/triggers/setup.ts";
import { webhookKey, webhookUrl } from "../../lib/triggers/webhook.ts";
import { sendRevealLink } from "../../lib/triggers/webhook-reveal.ts";

// Creates an event trigger (docs/architecture.md, flows 2b and 2c; decisions 088 and 090). The
// person who sets it up consents to its runs, so the row is active at once. Each run gives the
// brain the instruction and the event. A webhook trigger's secret shows only on a one-time page
// linked from the person's DM, never in Slack or this tool's result.

export default defineTool({
  description:
    "Use the returned state and next step to answer naturally. Do not paste tool returns verbatim or name internal tools. " +
    "Set up a trigger: when a new message (optionally with keywords) or a reaction with an emoji " +
    "appears in a channel that the person and you are both in, or when a signed request reaches " +
    "a webhook URL, run an instruction with your tools. It starts right away; no approval. For a " +
    "webhook, Sym DMs the person the URL and a one-time link to the secret; never ask for, " +
    "open, or repeat that link or the secret.",
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
    const deps = { ...ledgerDeps(), usersEnv: process.env.SYM_SLACK_USERS };
    const result = await setUpTrigger(deps, {
      ...input,
      requester: manager.requester,
      current: thread?.channelId,
    });
    if ("refusal" in result) return result.refusal;
    const { trigger } = result;
    if (trigger.kind === "webhook" && trigger.hookId && webhookKey()) {
      const sent = await sendRevealLink(deps, trigger);
      return {
        trigger: triggerRef(trigger.id),
        url: webhookUrl(trigger.hookId),
        secretSent: sent,
        answer: sent
          ? `Created ${triggerLine(trigger)}. I DM'd you the URL and a one-time link to the signing secret; it works once, within 15 minutes.`
          : `Created ${triggerLine(trigger)}, but I couldn't DM you the secret's link. Ask me to rotate the secret to get one.`,
      };
    }
    return {
      trigger: triggerRef(trigger.id),
      answer: `Created ${triggerLine(trigger)}. I'm in that channel, so Slack sends me its events.`,
    };
  },
});
