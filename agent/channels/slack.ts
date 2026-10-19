import {
  defaultSlackAuth,
  defineSlackRenderer,
  type SlackMessage,
  slackChannel,
} from "eve/channels/slack";
import { recordSessionThread } from "../../lib/ledger/threads.ts";
import { ledger } from "../../lib/runtime.ts";

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

// Sym's own job card replaces Eve's task card for worker jobs (docs/slack.md), so a job
// thread shows one card. Each turn also records its Slack thread, because tools and schedules
// cannot read the channel's session state and a job posts to the thread it was asked in.
const symRenderer = defineSlackRenderer({
  events: {
    async "turn.started"(event, channel, ctx, next) {
      const { channelId, threadTs, teamId, triggeringUserId } = channel.state;
      if (channelId) {
        await recordSessionThread(ledger(), {
          sessionId: ctx.session.id,
          teamId: teamId ?? null,
          channelId,
          threadTs: threadTs ?? null,
          userId: triggeringUserId ?? null,
        }).catch((error: unknown) => {
          console.warn("Sym could not record the Slack thread of a session.", String(error));
        });
      }
      await next(event);
    },
  },
  taskCard(view, next) {
    const tasks = view.tasks.filter((task) => task.name !== "t3_job");
    if (tasks.length === view.tasks.length) return next(view);
    if (tasks.length === 0) return null;
    return next({ ...view, tasks });
  },
});

export default slackChannel({
  renderers: [symRenderer],
  // Undefined keeps Slack's own host. Tests and the local e2e point it at a fake Slack server.
  ...(process.env.SLACK_API_BASE_URL
    ? { api: { apiBaseUrl: process.env.SLACK_API_BASE_URL } }
    : {}),
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
