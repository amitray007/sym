import { defineTool } from "eve/tools";
import { z } from "zod";
import { ledgerDeps, pack } from "../../lib/runtime.ts";
import { scheduleManager } from "../../lib/schedules/access.ts";
import { parseTriggerRef, rotateWebhookSecret, triggerRef } from "../../lib/triggers/rows.ts";
import { TRIGGER_NOT_ALLOWED } from "../../lib/triggers/setup.ts";
import { WEBHOOKS_OFF, webhookKey } from "../../lib/triggers/webhook.ts";
import { sendRevealLink } from "../../lib/triggers/webhook-reveal.ts";

// Rotates a webhook trigger's signing secret (decision 090). The old secret stops working at
// once, and so does any unused link to it; a new one-time link goes only to the creator's DM.
// Only the creator may rotate: whoever holds the secret can start runs that act for the creator.

export const NOT_YOUR_WEBHOOK =
  "Only the person who set up that webhook trigger can rotate its secret, or it does not exist.";

export default defineTool({
  description:
    "Use the returned state and next step to answer naturally. Do not paste tool returns verbatim or name internal tools. " +
    "Rotate a webhook trigger's signing secret when its creator asks, for example after a leak " +
    "or when the secret's link expired. The old secret stops working at once; Sym DMs the " +
    "creator a one-time link to the new one. Never open or repeat that link or a secret.",
  inputSchema: z.object({
    trigger: z.string().describe("A webhook trigger reference such as T-3."),
  }),
  label: { start: () => "Rotate webhook secret" },
  async execute({ trigger: ref }, ctx) {
    const manager = scheduleManager(
      ctx.session.auth.current,
      pack(),
      process.env.SYM_SLACK_USERS,
      TRIGGER_NOT_ALLOWED,
    );
    if ("refusal" in manager) return manager.refusal;
    if (!webhookKey()) return WEBHOOKS_OFF;
    const id = parseTriggerRef(ref);
    if (id === undefined) return "I couldn't identify that trigger.";
    const deps = ledgerDeps();
    const row = await rotateWebhookSecret(deps.sql, id, manager.requester);
    if (!row) return NOT_YOUR_WEBHOOK;
    const sent = await sendRevealLink(deps, row);
    return {
      trigger: triggerRef(row.id),
      secretSent: sent,
      answer: sent
        ? "Rotated the secret. The old one stopped working; I DM'd you a one-time link to the new one."
        : "Rotated the secret, so the old one stopped working, but I couldn't DM you its link. Ask me to rotate it again.",
    };
  },
});
