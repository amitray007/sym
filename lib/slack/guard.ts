import type { Pack } from "../pack/load.ts";
import { isAllowedSlackUser } from "../pack/policy.ts";

// Who may use Sym, and the private replies the Slack channel sends (docs/slack.md).

// The pack's owner and allow-list decide. Without a pack, SYM_SLACK_USERS does: comma-separated
// Slack user IDs. Nobody is allowed when neither is set. A drop logs one line with the Slack user
// ID only, never the message text.
export function isSlackUserAllowed(
  pack: Pack | undefined,
  usersEnv: string | undefined,
  userId: string | undefined,
  warn: (line: string) => void = console.warn,
): boolean {
  if (!userId) return false;
  const allowed = pack
    ? isAllowedSlackUser(pack, userId)
    : (usersEnv ?? "")
        .split(",")
        .map((id) => id.trim())
        .includes(userId);
  if (!allowed) warn(`Sym dropped an inbound Slack request from ${userId}: not on the allow-list.`);
  return allowed;
}

export interface EphemeralSlack {
  request(operation: string, body: unknown): Promise<{ ok?: boolean; error?: string }>;
}

// An ephemeral reply only the person who asked sees. A failed reply is logged, never thrown,
// because a handler that throws leaves the person with nothing. The log holds Slack's error code
// and never the message text.
export async function sayPrivately(
  slack: EphemeralSlack,
  where: { channel: string; user: string; threadTs?: string },
  text: string,
  warn: (line: string) => void = console.warn,
): Promise<void> {
  try {
    const response = await slack.request("chat.postEphemeral", {
      channel: where.channel,
      user: where.user,
      text,
      ...(where.threadTs ? { thread_ts: where.threadTs } : {}),
    });
    if (response.ok === false) {
      warn(`Sym could not send an ephemeral reply: ${response.error ?? "unknown_error"}.`);
    }
  } catch (error) {
    warn(`Sym could not send an ephemeral reply: ${errorCode(error)}.`);
  }
}

// A thrown Slack error may carry the request body. Keep only a short code-like word.
function errorCode(error: unknown): string {
  const code = (error as { code?: unknown; data?: { error?: unknown } } | null)?.data?.error;
  if (typeof code === "string" && /^[a-z_]+$/.test(code)) return code;
  return error instanceof Error ? error.name : "unknown_error";
}
