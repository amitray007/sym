import {
  defaultSlackAuth,
  defineSlackRenderer,
  postCompletedSlackReply,
  type SlackInputResponseSubmission,
  type SlackMessage,
  slackChannel,
} from "eve/channels/slack";
import {
  FEEDBACK_ACTION_ID,
  feedbackBlocks,
  jobIdOfMessage,
  jobIdOfThread,
  kindOfButton,
  kindOfReaction,
  recordFeedback,
} from "../../lib/feedback/feedback.ts";
import { STOP_ACTION_ID } from "../../lib/jobs/card.ts";
import { jobListAnswer } from "../../lib/jobs/status.ts";
import { stopJob } from "../../lib/jobs/steer.ts";
import { recentJobs } from "../../lib/ledger/jobs.ts";
import { recordSessionThread } from "../../lib/ledger/threads.ts";
import { isApprovalAction, mayDecideAsOwner } from "../../lib/owner.ts";
import { parseSymCommand, slackText, USAGE } from "../../lib/quiet/command.ts";
import { formatClock, getQuietUntil, setQuietUntil } from "../../lib/quiet/quiet.ts";
import { ledger, pack, withJobDeps } from "../../lib/runtime.ts";
import { scheduleList } from "../../lib/schedules/format.ts";
import { listSchedules } from "../../lib/schedules/rows.ts";
import { isSlackUserAllowed, sayPrivately } from "../../lib/slack/guard.ts";

// The Slack channel (docs/slack.md). It reads SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET from the
// environment. A valid signature proves Slack sent the event, not that the sender may use Sym,
// so every inbound handler checks the allow-list and fails closed.

// Who may use Sym is decided in lib/slack/guard.ts: the pack's owner and allow-list, else
// SYM_SLACK_USERS. A drop logs the Slack user ID only.
const isAllowed = (userId: string | undefined) =>
  isSlackUserAllowed(pack(), process.env.SYM_SLACK_USERS, userId);

const STATUS_WINDOW_MS = 24 * 60 * 60 * 1000;

// `/sym ...` answers from the ledger without a model call (docs/slack.md).
async function answerSymCommand(text: string, now: Date): Promise<string> {
  const command = parseSymCommand(text);
  const zone = pack()?.config.timeZone;
  switch (command.type) {
    case "status": {
      const jobs = await recentJobs(ledger(), new Date(now.getTime() - STATUS_WINDOW_MS));
      const until = await getQuietUntil(ledger());
      const quiet =
        until && until.getTime() > now.getTime()
          ? `\nQuiet until ${formatClock(until, zone)}.`
          : "";
      return slackText(jobListAnswer(jobs, now)) + quiet;
    }
    case "schedules":
      // Creating or changing a schedule needs an approval, so it goes through Sym in a thread.
      return slackText(scheduleList(await listSchedules(ledger())));
    case "quiet": {
      if (command.arg.kind === "off") {
        await setQuietUntil(ledger(), null);
        return "Quiet mode is off.";
      }
      const until = new Date(now.getTime() + command.arg.minutes * 60_000);
      await setQuietUntil(ledger(), until);
      return `Quiet until ${formatClock(until, zone)}. Questions, approvals, and failures still post.`;
    }
    case "usage":
      return USAGE;
  }
}

// A modal answer (`view_submission`) is always a question.
function isApprovalSubmission(submission: SlackInputResponseSubmission): boolean {
  return (
    submission.type === "block_actions" &&
    submission.actions.some((action) => isApprovalAction(action.actionId))
  );
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
    // Feedback buttons ride inside each final reply (docs/learning.md), so they add no message
    // and no notification. postCompletedSlackReply keeps Eve's fallbacks: a refused or long
    // reply still goes out as plain Markdown or a snippet, without the buttons.
    async "message.completed"(event, channel, _ctx, next) {
      if (event.finishReason === "tool-calls" || !event.message) return next();
      await postCompletedSlackReply(channel, {
        blocks: [{ type: "markdown", text: event.message }, ...feedbackBlocks()] as never,
        markdown: event.message,
      });
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
  // `/sym status`, `/sym jobs`, `/sym quiet`: ephemeral answers from the ledger, no model call.
  async onSlashCommand(command, ctx) {
    if (command.command !== "/sym") return;
    const where = { channel: command.channelId, user: command.user.id };
    if (!isAllowed(command.user.id)) {
      await sayPrivately(ctx.slack, where, "You are not on Sym's allow-list.");
      return;
    }
    try {
      await sayPrivately(ctx.slack, where, await answerSymCommand(command.text, new Date()));
    } catch (error) {
      console.warn("Sym could not answer a slash command.", String(error));
      await sayPrivately(ctx.slack, where, "Sym could not answer that. Try again in a moment.");
    }
  },
  // The Stop button on a job card and the feedback buttons. Open PR is a URL button, so its
  // click needs no work. Steer needs a modal and is not a button yet.
  async onInteraction(action, ctx) {
    if (action.actionId !== STOP_ACTION_ID && action.actionId !== FEEDBACK_ACTION_ID) return;
    if (!isAllowed(action.user.id)) return;
    const { channelId, threadTs } = ctx.slack;
    if (action.actionId === FEEDBACK_ACTION_ID) {
      const kind = kindOfButton(action.value);
      if (!kind) return;
      try {
        await recordFeedback(ledger(), {
          jobId: await jobIdOfThread(ledger(), channelId, threadTs),
          slackUser: action.user.id,
          kind,
          value: action.value ?? "",
          channel: channelId,
          messageTs: action.messageTs ?? null,
        });
      } catch (error) {
        console.warn("Sym could not record feedback.", String(error));
      }
      return;
    }
    const where = { channel: channelId, user: action.user.id, threadTs };
    const ref = action.value ?? "";
    if (!/^J-\d+$/.test(ref)) return;
    try {
      const answer = await withJobDeps((deps) => stopJob(deps, ref));
      await sayPrivately(ctx.slack, where, slackText(answer));
    } catch (error) {
      console.warn("Sym could not stop a job.", String(error));
      await sayPrivately(ctx.slack, where, `Sym could not stop ${ref}. Try again in a moment.`);
    }
  },
  // Reactions on Sym's messages are feedback. A reaction on another message is not.
  async onEvent(ctx, event) {
    if (event.type !== "reaction_added") return;
    const user = typeof event.user === "string" ? event.user : undefined;
    const name = typeof event.reaction === "string" ? event.reaction : undefined;
    const item = event.item as { type?: string; channel?: string; ts?: string } | undefined;
    if (!user || !name || item?.type !== "message" || !item.channel || !item.ts) return;
    if (!isAllowed(user)) return;
    try {
      const jobId = await jobIdOfMessage(ledger(), item.channel, item.ts);
      const botId = ctx.envelope.authorizations?.find((a) => a.is_bot)?.user_id;
      if (jobId === null && (!botId || event.item_user !== botId)) return;
      await recordFeedback(ledger(), {
        jobId,
        slackUser: user,
        kind: kindOfReaction(name),
        value: name,
        channel: item.channel,
        messageTs: item.ts,
      });
    } catch (error) {
      console.warn("Sym could not record a reaction.", String(error));
    }
  },
  // Answers count from allowed people. A tool approval is an owner decision, so it counts only
  // from the owner (lib/owner.ts). Without a configured owner, the allow-list decides.
  onInputResponse(ctx, submission) {
    if (!isAllowed(submission.user.id)) return null;
    if (isApprovalSubmission(submission) && !mayDecideAsOwner(submission.user.id, pack())) {
      return null;
    }
    return { auth: ctx.defaultAuth };
  },
});
