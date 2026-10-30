import {
  defaultSlackAuth,
  defineSlackRenderer,
  type SlackAnswerSubmission,
  type SlackContext,
  type SlackEventContext,
  type SlackInboundMessageContext,
  type SlackMessage,
  type SlackRenderHandler,
  slackChannel,
} from "eve/channels/slack";
import { takeChoice } from "../../lib/delivery/choices.ts";
import { queueReply } from "../../lib/delivery/replies.ts";
import {
  FEEDBACK_ACTION_ID,
  jobIdOfMessage,
  jobIdOfThread,
  kindOfButton,
  kindOfReaction,
  recordFeedback,
} from "../../lib/feedback/feedback.ts";
import { publishLiveHome } from "../../lib/home/live.ts";
import { Brief } from "../../lib/jobs/brief.ts";
import { closeJob } from "../../lib/jobs/followup.ts";
import { fullBrief } from "../../lib/jobs/messages.ts";
import { pendingQuestionContext } from "../../lib/jobs/questions.ts";
import { jobListAnswer } from "../../lib/jobs/status.ts";
import { CHOICE_ACTION_ID } from "../../lib/ledger/choices.ts";
import { getJob, type Job, jobRef, recentJobs } from "../../lib/ledger/jobs.ts";
import { getListenMode } from "../../lib/ledger/listen.ts";
import { sentPostTimestamps } from "../../lib/ledger/outbox.ts";
import { DISMISS_ACTION_ID, START_ACTION_ID } from "../../lib/ledger/proposals.ts";
import { lastTurnUser, recordSessionThread } from "../../lib/ledger/threads.ts";
import { isApprovalAction, mayDecideAsOwner, ownerUserId } from "../../lib/owner.ts";
import {
  changePersona,
  describePersona,
  personaStatus,
  storedPersonaOrNone,
} from "../../lib/persona-setting.ts";
import { parseSymCommand, slackText, USAGE } from "../../lib/quiet/command.ts";
import { formatClock, getQuietUntil, setQuietUntil } from "../../lib/quiet/quiet.ts";
import {
  captureReactionTarget,
  recordThreadMessage,
  recordTurnMessage,
} from "../../lib/reactions/react.ts";
import { ledger, ledgerDeps, pack, slackFromEnv, withJobDeps } from "../../lib/runtime.ts";
import { scheduleList } from "../../lib/schedules/format.ts";
import { listSchedules } from "../../lib/schedules/rows.ts";
import { namesBot, threadPeople, triageThreadMessage } from "../../lib/slack/addressing.ts";
import { SlackApiError } from "../../lib/slack/api.ts";
import {
  codeChannelsOn,
  ensureConversationBar,
  jobOfCodeChannel,
  jobSessionStatus,
  setChannelStatus,
} from "../../lib/slack/code-channel.ts";
import { handleCodeChannelAction } from "../../lib/slack/code-channel-actions.ts";
import { isSlackUserAllowed, sayPrivately } from "../../lib/slack/guard.ts";
import {
  handleJobAction,
  handleProposal,
  handleTypedProposal,
  JOB_ACTION_IDS,
} from "../../lib/slack/job-actions.ts";
import {
  MAYBE_NOTE,
  nameOf,
  type Person,
  participantsNote,
  type Role,
} from "../../lib/slack/participants.ts";
import {
  createStrangerCooldown,
  strangerKey,
  strangerLine,
  strangerRepliesOn,
} from "../../lib/slack/strangers.ts";
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
      return `Quiet until ${formatClock(until, zone)}. I will still bring you questions, approvals, and failures.`;
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
      return `Ask me what is running, or tell me to go quiet.\n${USAGE}`;
  }
}

// A neutral status until a tool label or workflow yield supplies a known step.
async function showLoadingMessages(channel: SlackContext): Promise<boolean> {
  try {
    if (!channel.slack.threadTs) return false;
    const response = await channel.slack.request("assistant.threads.setStatus", {
      channel_id: channel.slack.channelId,
      thread_ts: channel.slack.threadTs,
      status: "Working...",
      loading_messages: ["Working..."],
    });
    return response.ok === true;
  } catch (error) {
    console.warn("Sym could not set the loading messages.", String(error));
    return false;
  }
}

// A modal answer (`view_submission`) is always a question.
function isApprovalSubmission(submission: SlackAnswerSubmission): boolean {
  return (
    submission.type === "block_actions" &&
    submission.actions.some((action) => isApprovalAction(action.actionId))
  );
}

const fromAllowedHuman = (message: SlackMessage) =>
  !message.author?.isBot && isAllowed(message.author?.userId);

// The line for someone off the allow-list (decision 053). Persona and owner come from the same
// sources as the loading messages. A failed persona read gives the straight line.
async function strangerText(straight = false): Promise<string> {
  const ownerId = ownerUserId(pack());
  let stored: Awaited<ReturnType<typeof storedPersonaOrNone>> = "plain";
  try {
    if (!straight) stored = await storedPersonaOrNone(ledger);
  } catch {
    // The straight line is the safe answer when the setting cannot be read.
  }
  if (straight || stored === "plain")
    return strangerLine({ sources: { stored: "plain" }, ownerId });
  return strangerLine({
    sources: { stored, env: process.env.SYM_PERSONA, pack: pack(), warn: () => {} },
    ownerId,
  });
}

const strangerCooldown = createStrangerCooldown();

// Tells a person off the allow-list, privately, to ask the owner. Only a human who tagged Sym,
// wrote to it in a direct message, or named it in a thread with a session gets a line, and
// only one per person and channel per hour. The message never reaches the model. This never throws.
async function replyToStranger(
  ctx: SlackInboundMessageContext,
  message: SlackMessage,
  trigger: "tag" | "direct" | "thread",
): Promise<void> {
  const userId = message.author?.userId;
  if (!userId || message.author?.isBot) return;
  try {
    if (!strangerRepliesOn(process.env.SYM_STRANGER_REPLIES)) return;
    if (trigger === "thread") {
      const named = ctx.isBotMentioned() || namesBot(message.text, botName());
      if (!named || !(await ctx.isSubscribed())) return;
    }
    // One line per person and channel an hour, so new threads earn no extra lines. The line
    // shows in the thread for a reply, and in the channel for a top-level tag.
    if (!strangerCooldown.claim(strangerKey(userId, message.channelId))) return;
    const inThread = trigger !== "direct" && message.threadTs !== message.ts;
    const threadTs = inThread ? message.threadTs : undefined;
    const delivered = await sayPrivately(
      ctx.slack,
      { channel: message.channelId, user: userId, ...(threadTs ? { threadTs } : {}) },
      await strangerText(),
    );
    if (!delivered) strangerCooldown.release(strangerKey(userId, message.channelId));
  } catch (error) {
    strangerCooldown.release(strangerKey(userId, message.channelId));
    console.warn("Sym could not answer a person off the allow-list.", errorName(error));
  }
}

const errorName = (error: unknown) => (error instanceof Error ? error.name : "unknown_error");

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
  | "model.started"
  | "call.started"
  | "call.progress"
  | "call.settled"
  | "turn.paused";

function stayQuiet<T extends StatusEvent>(): SlackRenderHandler<T> {
  return async (event, ctx, next) => {
    if (isQuietTurn(quietKey(ctx.channel))) return;
    await next(event);
  };
}

// Eve names a content part's kind on its first delta only, so the renderer remembers it. A part
// ends with its content.completed, which removes it.
const partKinds = new Map<string, string>();
const PART_KINDS_MAX = 1000;

// Eve's defaults keep this bookkeeping in the channel state: turn.started resets the first two,
// and a reply clears the saved status so a later step does not show it again. Eve 0.87 took the
// fields out of the public state type, so Sym's own paths reset them through this view.
type TurnBookkeeping = {
  pendingTaskResults?: unknown;
  pendingToolCallMessage?: unknown;
  threadStatus?: unknown;
  postedInThread?: boolean;
};

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
    async "turn.started"(event, ctx, next) {
      const channel = ctx.channel;
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
      await captureReactionTarget(ledger(), ctx.session.id, ctx.session.turn.id).catch(
        (error: unknown) => {
          console.warn("Sym could not capture the reaction target.", errorName(error));
        },
      );
      // Eve's handler resets the turn state and shows "Thinking...". A quiet turn keeps the
      // reset and skips the status.
      if (quiet) {
        const state = channel.state as TurnBookkeeping;
        state.pendingTaskResults = null;
        state.pendingToolCallMessage = null;
        return;
      }
      await next(event);
      await showLoadingMessages(channel);
    },
    "model.started": stayQuiet<"model.started">(),
    "call.started": stayQuiet<"call.started">(),
    "call.progress": stayQuiet<"call.progress">(),
    "call.settled": stayQuiet<"call.settled">(),
    "turn.paused": stayQuiet<"turn.paused">(),
    async "call.requested"(event, ctx, next) {
      const key = quietKey(ctx.channel);
      if (isQuietTurn(key)) {
        if (event.data.capability.name === "no_reply") return;
        endQuietTurn(key);
      }
      await next(event);
    },
    // Reasoning keeps a quiet turn quiet. Reply text that is not blank ends it.
    async "content.delta"(event, ctx, next) {
      const { partId, kind, delta } = event.data;
      if (kind) {
        // A part that never completes, such as one a cancel cut off, leaves its entry behind.
        if (partKinds.size >= PART_KINDS_MAX) partKinds.clear();
        partKinds.set(partId, kind);
      }
      const key = quietKey(ctx.channel);
      if (isQuietTurn(key)) {
        if (partKinds.get(partId) !== "text" || delta.trim() === "") return;
        endQuietTurn(key);
      }
      await next(event);
    },
    async "turn.settled"(event, ctx, next) {
      const quiet = isQuietTurn(quietKey(ctx.channel));
      endQuietTurn(quietKey(ctx.channel));
      // A failed or cancelled quiet turn still gets Eve's notice.
      if (!quiet || event.data.outcome !== "completed") await next(event);
      // Eve sets a code channel back to active when the brain's turn ends. The channel shows its
      // job, so Sym sets the job's own status again, such as suspended while a question waits.
      if (ctx.channel.state.codeChannel && ctx.channel.state.channelId) {
        await restoreJobStatus(ctx.channel.state.channelId);
      }
    },
    // Conversation replies use the durable outbox. Feedback controls belong to job results.
    // A refused block falls back to text; long replies use a document.
    async "content.completed"(event, ctx, next) {
      const { partId, kind, phase, value } = event.data;
      partKinds.delete(partId);
      if (kind === "reasoning" && isQuietTurn(quietKey(ctx.channel))) return;
      if (phase !== "reply" || kind !== "text" || typeof value !== "string" || !value) {
        return next(event);
      }
      endQuietTurn(quietKey(ctx.channel));
      (ctx.channel.state as TurnBookkeeping).threadStatus = null;
      const slack = {
        async call(method: string, body: Record<string, unknown>) {
          const response = await ctx.channel.slack.request(method, body);
          if (response.ok === false)
            throw new SlackApiError(
              method,
              typeof response.error === "string" ? response.error : "unknown_error",
            );
          return response as Record<string, unknown>;
        },
      };
      const posted = await queueReply(ledger(), slack, {
        key: `reply:${ctx.session.id}:${ctx.session.turn.id}:${partId}`,
        channel: ctx.channel.slack.channelId,
        threadTs: ctx.channel.slack.threadTs || null,
        text: value,
      });
      if (posted) (ctx.channel.state as TurnBookkeeping).postedInThread = true;
    },
  },
  taskCard(card, next) {
    const calls = card.calls.filter((call) => call.name !== "worker_job");
    if (calls.length === card.calls.length) return next(card);
    // Eve's default returns null for a card with no task left.
    return next({ ...card, calls });
  },
});

async function restoreJobStatus(channelId: string): Promise<void> {
  try {
    const job = await jobOfCodeChannel(ledger(), channelId);
    const status = job && jobSessionStatus(job);
    const slack = slackFromEnv();
    if (job && status && slack) await setChannelStatus({ sql: ledger(), slack }, job, status);
  } catch (error) {
    console.warn("Sym could not restore a code channel's status.", String(error));
  }
}

// A code channel belongs to one job (decision 067). Each turn there tells the brain which one, so
// "how is it going" or "also fix the docs" acts on that job. A failed lookup adds nothing.
async function codeChannelNote(channelId: string): Promise<string | undefined> {
  try {
    const job = await jobOfCodeChannel(ledger(), channelId);
    if (job) return jobConversationNote(job);
    const slack = slackFromEnv();
    if (slack) await ensureConversationBar({ sql: ledger(), slack }, channelId);
    return undefined;
  } catch (error) {
    console.warn("Sym could not read the job of a code channel.", String(error));
    return undefined;
  }
}

async function jobConversationNote(job: Job): Promise<string> {
  const ref = jobRef(job.id);
  const questions = await pendingQuestionContext({ sql: ledger() }, job.id);
  return [
    `This conversation is about ${ref} (${JSON.stringify(job.title)}), now ${job.status}. Job and schedule references are handles for tools; never write them to people. Name the work in a few words, or say "this" here. Accept a reference if a person types one. Read each message in context. Choose chat, job_steer for explicit direction or a pending answer, job_followup to propose more work after completion, job_stop for an explicit stop request, job_close when the person is done, or no_reply for side talk. Do not turn every reply into steering. Follow-ups always need a stored Start approval.`,
    `Stored job scope (details on request): ${fullBrief(Brief.parse(job.brief))}`,
    questions,
  ]
    .filter(Boolean)
    .join("\n");
}

async function threadJobNote(channel: string, thread: string): Promise<string | undefined> {
  const id = await jobIdOfThread(ledger(), channel, thread);
  const job = id ? await getJob(ledger(), id) : undefined;
  return job ? jobConversationNote(job) : undefined;
}

async function typedDecision(
  ctx: SlackInboundMessageContext,
  message: SlackMessage,
  replyAfter?: string,
): Promise<boolean> {
  const by = message.author?.userId;
  if (!by) return false;
  const text = ctx.isBotMentioned()
    ? message.text.replace(/<@[UW][A-Z0-9]+(?:\|[^>]*)?>/, "").trim()
    : message.text;
  // Most conversation messages need no worker connection or database query for approvals.
  if (
    !/^(start|yes(?: please)?|go(?: ahead)?|do it|not now|no|cancel|never mind)[.!]*$/i.test(
      text.trim(),
    )
  )
    return false;
  const answer = await withJobDeps((deps) =>
    handleTypedProposal(
      deps,
      {
        text,
        by,
        ...(replyAfter ? { replyAfter } : {}),
        channel: message.channelId,
        threadTs: ctx.slack.codeChannel ? null : message.threadTs,
      },
      isAllowed,
    ),
  );
  if (answer === undefined) return false;
  if (answer.kind !== "accepted") {
    await sayPrivately(
      ctx.slack,
      { channel: message.channelId, user: by, threadTs: message.threadTs },
      answer.text,
    );
  }
  // The proposal's edit is the visible acknowledgement; no second notifying post.
  return true;
}

export default slackChannel({
  renderers: [symRenderer],
  // Off unless SYM_CODE_CHANNELS is on: Eve then serves each code channel as one session, and the
  // generated manifest asks for the code channel scopes and events.
  codeChannels: codeChannelsOn(),
  // Undefined keeps Slack's own host. Tests and the local e2e point it at a fake Slack server.
  ...(process.env.SLACK_API_BASE_URL
    ? { api: { apiBaseUrl: process.env.SLACK_API_BASE_URL } }
    : {}),
  // A session's first turn reads the whole thread. Later turns read what came after Sym's last
  // post, because the session already holds the rest (docs/eve.md, decision 050).
  threadContext: { since: isLastPostBoundary },
  async onAppMention(ctx, message) {
    if (!fromAllowedHuman(message)) {
      await replyToStranger(ctx, message, "tag");
      return null;
    }
    if (await typedDecision(ctx, message)) return null;
    setQuiet(message, false);
    const auth = defaultSlackAuth(message, ctx);
    if (ctx.slack.codeChannel) {
      const note = await codeChannelNote(message.channelId);
      return note ? { auth, context: [note] } : { auth };
    }
    await noteSession(ctx, message);
    if (message.threadTs === message.ts) return { auth };
    const note = await participantsContext(
      ctx,
      message.author?.userId ?? "",
      await peopleOf(ctx).then((people) => people.ids),
    ).catch(() => undefined);
    const jobNote = await threadJobNote(message.channelId, message.threadTs);
    const context = [note, jobNote].filter((value): value is string => Boolean(value));
    return context.length ? { auth, context } : { auth };
  },
  async onDirectMessage(ctx, message) {
    if (!fromAllowedHuman(message)) {
      await replyToStranger(ctx, message, "direct");
      return null;
    }
    if (await typedDecision(ctx, message)) return null;
    setQuiet(message, false);
    await noteSession(ctx, message);
    const note = await threadJobNote(message.channelId, message.threadTs);
    return { auth: defaultSlackAuth(message, ctx), ...(note ? { context: [note] } : {}) };
  },
  // Replies in a thread that already has a session continue it without a new mention, when they
  // are meant for Sym. Side talk between people starts no turn (decision 050).
  async onMessage(ctx, message) {
    if (!fromAllowedHuman(message)) {
      await replyToStranger(ctx, message, "thread");
      return null;
    }
    // Everything in a code channel is meant for Sym: it needs no tag, triage, or listen mode.
    if (ctx.slack.codeChannel) {
      if (await typedDecision(ctx, message)) return null;
      const auth = defaultSlackAuth(message, ctx);
      const note = await codeChannelNote(message.channelId);
      return note ? { auth, context: [note] } : { auth };
    }
    if (!(await ctx.isSubscribed())) return null;
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
    const jobNote = await threadJobNote(channelId, threadTs);
    const addressing = triageThreadMessage({
      senderId,
      text: message.text,
      mentionsBot: ctx.isBotMentioned(),
      botName: botName(),
      listenMode,
      people,
      partnerId,
      jobThread: Boolean(jobNote),
    });
    if (addressing === "skip") return null;
    if (ctx.isBotMentioned()) {
      if (await typedDecision(ctx, message)) return null;
    } else if (partnerId === senderId) {
      // Refresh before binding a bare decision. A partial thread window cannot prove that
      // nothing came between this reply and Sym's proposal, so it never grants approval.
      const refreshed = await ctx.thread.refresh().then(
        () => true,
        () => false,
      );
      const messages = ctx.thread.recentMessages;
      const previous = [...messages]
        .filter((item) => Number(item.ts) < Number(message.ts))
        .sort((a, b) => Number(b.ts) - Number(a.ts))[0];
      if (
        refreshed &&
        messages.length < 50 &&
        previous?.isMe &&
        (await typedDecision(ctx, message, previous.ts))
      )
        return null;
    }
    const note = await participantsContext(ctx, senderId, people.ids).catch(() => undefined);
    const context = [
      ...(addressing === "maybe" ? [MAYBE_NOTE] : []),
      ...(note ? [note] : []),
      ...(jobNote ? [jobNote] : []),
    ];
    setQuiet(message, addressing === "maybe");
    return context.length > 0 ? { auth, context } : { auth };
  },
  // `/sym status`, `/sym jobs`, `/sym quiet`: ephemeral answers from the ledger, no model call.
  async onSlashCommand(command, ctx) {
    if (command.command !== "/sym") return;
    const where = { channel: command.channelId, user: command.user.id };
    if (!isAllowed(command.user.id)) {
      // No cooldown: they ran a command. With the switch off, the straight line.
      const straight = !strangerRepliesOn(process.env.SYM_STRANGER_REPLIES);
      await sayPrivately(ctx.slack, where, await strangerText(straight));
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
  // The job buttons and text boxes (lib/slack/job-actions.ts) and the feedback buttons. Open PR
  // is a URL button, so its click needs no work.
  async onInteraction(action, ctx) {
    const choice = action.actionId.startsWith(`${CHOICE_ACTION_ID}_`);
    const proposal = [START_ACTION_ID, DISMISS_ACTION_ID].includes(action.actionId);
    if (choice || proposal) {
      if (!isAllowed(action.user.id)) return;
      const { channelId, threadTs } = ctx.slack;
      const slack = slackFromEnv();
      try {
        if (choice && slack && action.value && action.messageTs) {
          const note = ctx.slack.codeChannel
            ? await codeChannelNote(channelId)
            : await threadJobNote(channelId, threadTs);
          await takeChoice(
            { sql: ledger(), slack, allowed: isAllowed },
            {
              value: action.value,
              user: action.user.id,
              channel: channelId,
              messageTs: action.messageTs,
            },
            (text, idempotencyKey) =>
              // Eve's typed-approval intake reads only string messages. Parts are conversation
              // data even when an old label equals a newer approval option.
              ctx.send(
                [
                  {
                    type: "text",
                    text: `<@${action.user.id}> chose this conversation option: ${JSON.stringify(text)}`,
                  },
                ],
                { idempotencyKey, ...(note ? { context: [note] } : {}) },
              ),
          );
        } else if (proposal && action.value && action.messageTs) {
          const outcome = await withJobDeps((deps) =>
            handleProposal(
              deps,
              {
                id: action.value ?? "",
                by: action.user.id,
                channel: channelId,
                threadTs: ctx.slack.codeChannel ? null : threadTs,
                ...(action.messageTs ? { messageTs: action.messageTs } : {}),
                start: action.actionId === START_ACTION_ID,
              },
              isAllowed,
            ),
          );
          if (outcome.kind !== "accepted")
            await sayPrivately(
              ctx.slack,
              { channel: channelId, user: action.user.id, threadTs },
              outcome.text,
            );
        }
      } catch (error) {
        console.warn("Sym couldn't handle a conversation choice.", String(error));
        await sayPrivately(
          ctx.slack,
          { channel: channelId, user: action.user.id, threadTs },
          "I couldn't finish that choice. Reply here and I'll check its state.",
        );
      }
      return;
    }
    const jobAction = JOB_ACTION_IDS.includes(action.actionId);
    if (!jobAction && action.actionId !== FEEDBACK_ACTION_ID) return;
    if (!isAllowed(action.user.id)) return;
    if (action.actionId === "sym_job_stop" && !mayDecideAsOwner(action.user.id, pack())) return;
    const { channelId, threadTs } = ctx.slack;
    if (action.actionId === FEEDBACK_ACTION_ID) {
      const kind = kindOfButton(action.value);
      if (!kind) return;
      try {
        await recordFeedback(
          ledger(),
          {
            jobId: await jobIdOfThread(ledger(), channelId, threadTs),
            slackUser: action.user.id,
            kind,
            value: action.value ?? "",
            channel: channelId,
            messageTs: action.messageTs ?? null,
          },
          pack(),
        );
      } catch (error) {
        console.warn("Sym could not record feedback.", String(error));
      }
      return;
    }
    const where = { channel: channelId, user: action.user.id, threadTs };
    try {
      await withJobDeps((deps) =>
        handleJobAction(deps, action, channelId, async (text) => {
          await sayPrivately(ctx.slack, where, text);
        }),
      );
    } catch (error) {
      console.warn("Sym could not handle a job button.", String(error));
      await sayPrivately(ctx.slack, where, "Sym could not do that. Try again in a moment.");
    }
  },
  // Reactions on Sym's messages are feedback. A reaction on another message is not.
  async onEvent(ctx, event) {
    if (event.type === "code_channel_action") {
      await handleCodeChannelAction(
        {
          ...ledgerDeps(),
          closeJob: (ref, by) => withJobDeps((deps) => closeJob(deps, ref, by)),
        },
        event,
        ctx.envelope.event_id ?? crypto.randomUUID(),
      );
      return;
    }
    // Opening the Home tab publishes the dashboard (decision 052).
    if (event.type === "app_home_opened") {
      if (event.tab === "home" && typeof event.user === "string") {
        await publishLiveHome(ctx.slack, event.user);
      }
      return;
    }
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
      await recordFeedback(
        ledger(),
        {
          jobId,
          slackUser: user,
          kind: kindOfReaction(name),
          value: name,
          channel: item.channel,
          messageTs: item.ts,
        },
        pack(),
      );
    } catch (error) {
      console.warn("Sym could not record a reaction.", String(error));
    }
  },
  // Answers count from allowed people. A tool approval is an owner decision, so it counts only
  // from the owner (lib/owner.ts). Without a configured owner, the allow-list decides.
  onAnswers(ctx, submission) {
    if (!isAllowed(submission.user.id)) return null;
    if (isApprovalSubmission(submission) && !mayDecideAsOwner(submission.user.id, pack())) {
      return null;
    }
    return { auth: ctx.defaultAuth };
  },
});
