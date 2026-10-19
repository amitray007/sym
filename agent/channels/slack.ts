import { defaultSlackAuth, type SlackMessage, slackChannel } from "eve/channels/slack";

// The Slack channel (docs/slack.md). It reads SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET from the
// environment. A valid signature proves Slack sent the event, not that the sender may use Sym,
// so every inbound handler checks the allow-list and fails closed.

// Milestone 1 allow-list: the owner only. Comma-separated Slack user IDs.
function allowedUsers(): Set<string> {
  return new Set(
    (process.env.SYM_SLACK_USERS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

function isAllowed(userId: string | undefined): boolean {
  return Boolean(userId && allowedUsers().has(userId));
}

const fromAllowedHuman = (message: SlackMessage) =>
  !message.author?.isBot && isAllowed(message.author?.userId);

export default slackChannel({
  // Sym reads the whole job thread (docs/eve.md).
  threadContext: { since: "thread-root" },
  onAppMention(ctx, message) {
    return fromAllowedHuman(message) ? { auth: defaultSlackAuth(message, ctx) } : null;
  },
  onDirectMessage(ctx, message) {
    return fromAllowedHuman(message) ? { auth: defaultSlackAuth(message, ctx) } : null;
  },
  // Replies in a thread that already has a session continue it without a new mention.
  async onMessage(ctx, message) {
    if (!fromAllowedHuman(message) || !(await ctx.isSubscribed())) return null;
    return { auth: defaultSlackAuth(message, ctx) };
  },
  // Approvals and answers count only from allowed people.
  onInputResponse(ctx, submission) {
    return isAllowed(submission.user.id) ? { auth: ctx.defaultAuth } : null;
  },
});
