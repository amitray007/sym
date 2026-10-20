import {
  defaultSlackAuth,
  defineSlackRenderer,
  postCompletedSlackReply,
  type SlackContext,
  type SlackEventContext,
  type SlackInboundMessageContext,
  type SlackInputResponseSubmission,
  type SlackMessage,
  type SlackRenderHandler,
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
import { getListenMode } from "../../lib/ledger/listen.ts";
import { sentPostTimestamps } from "../../lib/ledger/outbox.ts";
import { lastTurnUser, recordSessionThread } from "../../lib/ledger/threads.ts";
import { isApprovalAction, mayDecideAsOwner, ownerUserId } from "../../lib/owner.ts";
import { loadingMessages } from "../../lib/persona.ts";
import {
  changePersona,
  describePersona,
  personaStatus,
  storedPersonaOrNone,
} from "../../lib/persona-setting.ts";
import { parseSymCommand, slackText, USAGE } from "../../lib/quiet/command.ts";
import { formatClock, getQuietUntil, setQuietUntil } from "../../lib/quiet/quiet.ts";
import { recordThreadMessage, recordTurnMessage } from "../../lib/reactions/react.ts";
import { ledger, pack, withJobDeps } from "../../lib/runtime.ts";
import { scheduleList } from "../../lib/schedules/format.ts";
import { listSchedules } from "../../lib/schedules/rows.ts";
import { threadPeople, triageThreadMessage } from "../../lib/slack/addressing.ts";
import { isSlackUserAllowed, sayPrivately } from "../../lib/slack/guard.ts";
import {
  MAYBE_NOTE,
  nameOf,
  type Person,
  participantsNote,
  type Role,
} from "../../lib/slack/participants.ts";
import {
  endQuietTurn,
  isLastPostBoundary,
  isQuietTurn,
  markOutboxPosts,
  markQuietTurn,
  markThreadSession,
  threadKey,
} from "../../lib/slack/thread-state.ts";

// The Slack channel (docs/slack.md). It reads SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET from the
// environment. A valid signature proves Slack sent the event, not that the sender may use Sym,
// so every inbound handler checks the allow-list and fails closed.

// Who may use Sym is decided in lib/slack/guard.ts: the pack's owner and allow-list, else
// SYM_SLACK_USERS. A drop logs the Slack user ID only.
const isAllowed = (userId: string | undefined) =>
  isSlackUserAllowed(pack(), process.env.SYM_SLACK_USERS, userId);

// The name people use for Sym in words, for messages that do not tag it (decision 050).
const botName = () => process.env.SYM_BOT_NAME?.trim() || "sym";

const STATUS_WINDOW_MS = 24 * 60 * 60 * 1000;

// `/sym ...` answers from the ledger without a model call (docs/slack.md).
async function answerSymCommand(text: string, now: Date, userId: string): Promise<string> {
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
    case "persona": {
      // Anyone allowed may read it. Only the owner may change it (decision 046).
      if (command.name) {
        return changePersona({ sql: ledger(), pack: pack(), userId, name: command.name });
      }
      const stored = await storedPersonaOrNone(ledger);
      return describePersona(personaStatus(pack(), stored, process.env.SYM_PERSONA));
    }
    case "usage":
      return USAGE;
  }
}

// The status line while the brain works. Eve sets one fixed text; Slack also takes a list to
// rotate (`loading_messages`), so each persona brings its own (decision 046). A failure here
// never blocks the turn.
async function showLoadingMessages(channel: SlackContext): Promise<boolean> {
  try {
    const stored = await storedPersonaOrNone(ledger);
    const sources = { stored, env: process.env.SYM_PERSONA, pack: pack(), warn: () => {} };
    const messages = loadingMessages(sources);
    const [status] = messages;
    if (!status || !channel.slack.threadTs) return false;
    const response = await channel.slack.request("assistant.threads.setStatus", {
      channel_id: channel.slack.channelId,
      thread_ts: channel.slack.threadTs,
      status,
      loading_messages: messages,
    });
    return response.ok === true;
  } catch (error) {
    console.warn("Sym could not set the loading messages.", String(error));
    return false;
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

// Marks whether the next turn of the message's sender in its thread might not be meant for Sym.
function setQuiet(message: SlackMessage, quiet: boolean) {
  const key = threadKey(message.channelId, message.threadTs, message.author?.userId ?? "");
  if (quiet) markQuietTurn(key);
  else endQuietTurn(key);
}

function roleOf(userId: string): Role {
  if (userId === ownerUserId(pack())) return "owner";
  return isSlackUserAllowed(pack(), process.env.SYM_SLACK_USERS, userId, () => {})
    ? "allowed"
    : "not on the allow-list";
}

// Who is in the thread, with a role each, so the brain can tell whose words to act on. The
// sender always counts. A failed fetch gives the sender alone.
async function participantsContext(
  ctx: SlackInboundMessageContext,
  senderId: string,
  ids: readonly string[],
): Promise<string> {
  const all = [senderId, ...ids.filter((id) => id !== senderId)];
  const people: Person[] = await Promise.all(
    all.map(async (id) => ({ id, name: await nameOf(ctx.slack, id), role: roleOf(id) })),
  );
  return participantsNote(people, senderId);
}

// The people in the thread, as far as one fetch of its first messages shows. A failed fetch
// reads as an incomplete list, which the triage treats as a shared thread.
async function peopleOf(ctx: SlackInboundMessageContext) {
  const ids = await ctx.thread.listParticipants().catch(() => []);
  return threadPeople(ctx.thread.recentMessages.length, ids);
}

// Records whether the thread has a session, for the thread context rule below.
// It also learns which Sym posts came through the outbox, which the boundary must skip. When the
// lookup fails, the thread has no boundary, so the turn reads the whole thread.
async function noteSession(
  ctx: SlackInboundMessageContext,
  message: SlackMessage,
  subscribed?: boolean,
) {
  const hasSession = subscribed ?? (await ctx.isSubscribed());
  if (!hasSession) return markThreadSession(message.threadTs, false);
  try {
    markOutboxPosts(await sentPostTimestamps(ledger(), message.channelId, message.threadTs));
    markThreadSession(message.threadTs, true);
  } catch (error) {
    console.warn("Sym could not read its outbox posts for a thread.", String(error));
    markThreadSession(message.threadTs, false);
  }
}

// Sym's own job card replaces Eve's task card for worker jobs (docs/slack.md), so a job
// thread shows one card. Each turn also records its Slack thread, because tools and schedules
// cannot read the channel's session state and a job posts to the thread it was asked in.
const quietKey = (channel: SlackEventContext) => {
  const { channelId, threadTs, triggeringUserId } = channel.state;
  return channelId && threadTs && triggeringUserId
    ? threadKey(channelId, threadTs, triggeringUserId)
    : undefined;
};

// A turn that might not be meant for Sym shows no status, so a thread of people talking does
// not light up. Real work ends the quiet: a tool other than no_reply, or reply text. Eve's own
// handlers then set the status as usual. The handlers below only set a status, so a quiet turn
// skips them.
type StatusEvent =
  | "step.started"
  | "reasoning.appended"
  | "reasoning.completed"
  | "action.partial"
  | "action.result"
  | "turn.waiting";

function stayQuiet<T extends StatusEvent>(): SlackRenderHandler<T> {
  return async (data, channel, _ctx, next) => {
    if (isQuietTurn(quietKey(channel))) return;
    await next(data);
  };
}

const symRenderer = defineSlackRenderer({
  // Eve's default sets "Thinking..." as soon as a message arrives. The persona's list replaces it.
  async received(message, channel, next) {
    // Each new message from an allowed person in a known thread becomes the one slack_react
    // reacts on (decision 051). Eve keeps the first message as the session's trigger, so
    // turn.started alone would point every later turn at the thread root. A quiet turn records it
    // too: a reaction can be the whole answer to side talk.
    if (fromAllowedHuman(message)) {
      await recordThreadMessage(ledger(), message.channelId, message.threadTs, message.ts).catch(
        (error: unknown) => {
          console.warn("Sym could not record the message of a turn.", String(error));
        },
      );
    }
    if (isQuietTurn(threadKey(message.channelId, message.threadTs, message.author?.userId ?? ""))) {
      return;
    }
    await next();
    await showLoadingMessages(channel);
  },
  events: {
    async "turn.started"(event, channel, ctx, next) {
      const { channelId, threadTs, teamId, triggeringUserId } = channel.state;
      const quiet = isQuietTurn(quietKey(channel));
      if (channelId) {
        await recordSessionThread(ledger(), {
          sessionId: ctx.session.id,
          teamId: teamId ?? null,
          channelId,
          threadTs: threadTs ?? null,
          // A quiet turn does not make its sender the person Sym serves.
          userId: quiet ? null : (triggeringUserId ?? null),
        })
          // The first message of the session, for slack_react (decision 051).
          .then(() =>
            channel.state.triggeringMessageTs
              ? recordTurnMessage(ledger(), ctx.session.id, channel.state.triggeringMessageTs)
              : undefined,
          )
          .catch((error: unknown) => {
            console.warn("Sym could not record the Slack thread of a session.", String(error));
          });
      }
      // Eve's handler resets the turn state and shows "Thinking...". A quiet turn keeps the
      // reset and skips the status.
      if (quiet) {
        channel.state.pendingTaskResults = null;
        channel.state.pendingToolCallMessage = null;
        return;
      }
      await next(event);
      await showLoadingMessages(channel);
    },
    "step.started": stayQuiet<"step.started">(),
    "reasoning.appended": stayQuiet<"reasoning.appended">(),
    "reasoning.completed": stayQuiet<"reasoning.completed">(),
    "action.partial": stayQuiet<"action.partial">(),
    "action.result": stayQuiet<"action.result">(),
    "turn.waiting": stayQuiet<"turn.waiting">(),
    async "actions.requested"(event, channel, _ctx, next) {
      const key = quietKey(channel);
      if (isQuietTurn(key)) {
        const real = event.actions.some((a) => !("toolName" in a) || a.toolName !== "no_reply");
        if (!real) return;
        endQuietTurn(key);
      }
      await next(event);
    },
    async "message.appended"(event, channel, _ctx, next) {
      if (isQuietTurn(quietKey(channel)) && event.messageDelta.trim() === "") return;
      endQuietTurn(quietKey(channel));
      await next(event);
    },
    async "turn.completed"(event, channel, _ctx, next) {
      const quiet = isQuietTurn(quietKey(channel));
      endQuietTurn(quietKey(channel));
      if (!quiet) await next(event);
    },
    // Feedback buttons ride inside each final reply (docs/learning.md), so they add no message
    // and no notification. postCompletedSlackReply keeps Eve's fallbacks: a refused or long
    // reply still goes out as plain Markdown or a snippet, without the buttons.
    async "message.completed"(event, channel, _ctx, next) {
      if (event.finishReason === "tool-calls" || !event.message) return next();
      endQuietTurn(quietKey(channel));
      await postCompletedSlackReply(channel, {
        blocks: [{ type: "markdown", text: event.message }, ...feedbackBlocks()] as never,
        markdown: event.message,
      });
    },
  },
  taskCard(view, next) {
    const tasks = view.tasks.filter((task) => task.name !== "worker_job");
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
  // A session's first turn reads the whole thread. Later turns read what came after Sym's last
  // post, because the session already holds the rest (docs/eve.md, decision 050).
  threadContext: { since: isLastPostBoundary },
  async onAppMention(ctx, message) {
    if (!fromAllowedHuman(message)) return null;
    setQuiet(message, false);
    await noteSession(ctx, message);
    const auth = defaultSlackAuth(message, ctx);
    if (message.threadTs === message.ts) return { auth };
    const note = await participantsContext(
      ctx,
      message.author?.userId ?? "",
      await peopleOf(ctx).then((people) => people.ids),
    ).catch(() => undefined);
    return note ? { auth, context: [note] } : { auth };
  },
  async onDirectMessage(ctx, message) {
    if (!fromAllowedHuman(message)) return null;
    setQuiet(message, false);
    await noteSession(ctx, message);
    return { auth: defaultSlackAuth(message, ctx) };
  },
  // Replies in a thread that already has a session continue it without a new mention, when they
  // are meant for Sym. Side talk between people starts no turn (decision 050).
  async onMessage(ctx, message) {
    if (!fromAllowedHuman(message) || !(await ctx.isSubscribed())) return null;
    await noteSession(ctx, message, true);
    const senderId = message.author?.userId ?? "";
    const auth = defaultSlackAuth(message, ctx);
    const { channelId, threadTs } = message;
    // A failed lookup could hide a mention-only setting, so it skips the message.
    const listenMode = await getListenMode(ledger(), channelId, threadTs).catch(
      (error: unknown) => {
        console.warn("Sym could not read a thread's listen mode.", String(error));
        return undefined;
      },
    );
    if (!listenMode) return null;
    const [partnerId, people] = await Promise.all([
      lastTurnUser(ledger(), channelId, threadTs).catch(() => undefined),
      peopleOf(ctx),
    ]);
    const addressing = triageThreadMessage({
      senderId,
      text: message.text,
      mentionsBot: ctx.isBotMentioned(),
      botName: botName(),
      listenMode,
      people,
      partnerId,
    });
    if (addressing === "skip") return null;
    const note = await participantsContext(ctx, senderId, people.ids).catch(() => undefined);
    const context = [...(addressing === "maybe" ? [MAYBE_NOTE] : []), ...(note ? [note] : [])];
    setQuiet(message, addressing === "maybe");
    return context.length > 0 ? { auth, context } : { auth };
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
      await sayPrivately(
        ctx.slack,
        where,
        await answerSymCommand(command.text, new Date(), command.user.id),
      );
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
