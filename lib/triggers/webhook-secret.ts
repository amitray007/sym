import { chooseDisplay } from "../display.ts";
import type { SlackApi } from "../slack/api.ts";
import { type Trigger, triggerRef } from "./rows.ts";
import {
  DELIVERY_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  webhookSecret,
  webhookUrl,
} from "./webhook.ts";

// Shows a webhook trigger's URL and secret to its creator once, in their DM (decision 090). The
// post goes straight to Slack, not through the outbox, so the secret never lands in Postgres; it
// never reaches the brain, a tool result, a channel, or a log either. A DM that fails loses the
// secret, and the creator rotates it for a new one.

export async function sendWebhookSecret(
  slack: SlackApi | undefined,
  trigger: Trigger,
  key: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (!slack || !trigger.hookId) return false;
  // Every Slack post goes through the display rule. A setup answer needs the person's action.
  const display = chooseDisplay({
    kind: "webhook-secret",
    needsAction: true,
    isNew: true,
    estMinutes: 0,
    steps: 0,
    lines: 8,
    surface: "dm",
    quiet: false,
  });
  if (display.level === 0) return false;
  try {
    const opened = await slack.call("conversations.open", { users: trigger.owner });
    const channel = (opened.channel as { id?: unknown } | undefined)?.id;
    if (typeof channel !== "string" || !channel.startsWith("D")) return false;
    const secret = webhookSecret(key, trigger.hookId, trigger.secretVersion);
    await slack.call("chat.postMessage", {
      channel,
      text: secretText(trigger, webhookUrl(trigger.hookId, env), secret),
      unfurl_links: false,
      unfurl_media: false,
    });
    return true;
  } catch {
    // Slack's error can echo the request body, which holds the secret. Log nothing.
    return false;
  }
}

export function secretText(trigger: Trigger, url: string, secret: string): string {
  return [
    `Webhook for *${trigger.title}* (${triggerRef(trigger.id)}). I show this secret once.`,
    `URL: ${url}`,
    `Secret: \`${secret}\``,
    `Sign each POST: set \`${TIMESTAMP_HEADER}\` to the Unix time in seconds and ` +
      `\`${SIGNATURE_HEADER}\` to \`sha256=\` plus the hex HMAC-SHA256 of ` +
      "`<timestamp>.<raw body>` with the secret. Optional: a unique " +
      `\`${DELIVERY_HEADER}\`, so a retry runs once.`,
    "Keep the secret out of Slack threads, including this one: anything I read there reaches " +
      "my model. If it leaks, ask me to rotate it.",
  ].join("\n");
}
