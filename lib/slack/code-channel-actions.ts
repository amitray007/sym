import { queueReply } from "../delivery/replies.ts";
import { closeCodeChannel } from "./code-channel-close.ts";
import { isSlackUserAllowed, sayPrivately } from "./guard.ts";

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && !!value.trim());
}

// Slack documents the action item, but not its event payload. Log field names only on a shape
// we cannot use. Never put the event's values in a diagnostic.
export async function handleCodeChannelAction(
  deps: Parameters<typeof closeCodeChannel>[0],
  event: Record<string, unknown>,
  eventId: string,
): Promise<void> {
  const key = firstString(
    event.key,
    event.item_key,
    event.action_id,
    object(event.item).key,
    object(event.action).key,
  );
  if (key && key !== "close") return;
  const channel = firstString(event.channel, event.channel_id);
  const user = firstString(event.user, event.user_id);
  if (!key || !channel || !user) {
    console.warn("Sym could not parse a code channel action; fields:", Object.keys(event));
    return;
  }
  const slack = deps.slack;
  if (!slack) return;
  if (!isSlackUserAllowed(deps.pack, deps.usersEnv ?? process.env.SYM_SLACK_USERS, user)) {
    await sayPrivately(
      { request: (method, body) => slack.call(method, body as Record<string, unknown>) },
      { channel, user },
      "You are not on Sym's Slack allow-list.",
    );
    return;
  }
  const text = await closeCodeChannel(deps, channel, user);
  await queueReply(deps.sql, slack, {
    key: `code-channel-close:${eventId}`,
    channel,
    threadTs: null,
    text,
  });
}
