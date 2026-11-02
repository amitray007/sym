import type { Sql } from "../db.ts";
import type { Pack } from "../pack/load.ts";
import { deliveryKey } from "../schedules/dispatch.ts";
import { attachSession, finishRun, markSending } from "../schedules/rows.ts";
import type { SlackApi } from "../slack/api.ts";
import { isSlackUserAllowed } from "../slack/guard.ts";
import { reachConversation } from "../slack/reach.ts";
import { triggerRunMessage } from "./format.ts";
import { matchesKeywords, normalizeEmoji } from "./match.ts";
import {
  claimDeferredRuns,
  endDeferred,
  getTrigger,
  type RunTarget,
  reserveTriggerRun,
  type Trigger,
  type TriggerEvent,
  triggerRef,
  watchingTriggers,
} from "./rows.ts";

// Fires event triggers (docs/architecture.md, flow 2b; decision 088). A Slack event in a watched
// channel reserves one run per trigger, then sends the run message with the app principal, the
// same proof of a run that a schedule uses, so the run acts for the trigger's creator. The event
// facts travel as untrusted data. A retried event finds its run and sends nothing.

// The app principal a schedule handler passes as `appAuth`. `isScheduleAuth` matches it.
export const APP_AUTH = {
  attributes: {},
  authenticator: "app",
  principalId: "eve:app",
  principalType: "runtime",
} as const;

const DEFAULT_RUNS_PER_HOUR = 20;
const TEXT_MAX = 4000;

// The cap on runs of one trigger per hour, from SYM_TRIGGER_RUNS_PER_HOUR (decision 088).
export function runsPerHour(value = process.env.SYM_TRIGGER_RUNS_PER_HOUR): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_RUNS_PER_HOUR;
}

export interface FireDeps {
  sql: Sql;
  slack?: SlackApi | undefined;
  pack?: Pack | undefined;
  usersEnv?: string | undefined;
  now?: Date;
  maxPerHour?: number;
}

// Starts a run's session at the target and returns its session ID. A sender that cannot reach
// the target returns undefined, and the run waits for the per-minute dispatcher.
export type SendRun = (input: {
  message: string;
  target: RunTarget;
  key: string;
  title: string;
}) => Promise<string | undefined>;

export type FireResult = { trigger: string; status: string };

// A Slack link to a message, in Slack's app_redirect form, which the reach tools also accept.
export function messageLink(channel: string, ts: string): string {
  return `https://slack.com/app_redirect?channel=${encodeURIComponent(channel)}&message_ts=${encodeURIComponent(ts)}`;
}

const clip = (text: string) => (text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX)}…` : text);

export interface MessageEventInput {
  channel: string;
  ts: string;
  threadTs: string;
  author: string | undefined;
  text: string;
}

// A new top-level message in a channel. The caller drops bots, Sym's own posts, edits, and
// thread replies first. `send` reaches only the message's own thread here, so a run that posts
// elsewhere waits for the dispatcher.
export async function fireMessageTriggers(
  deps: FireDeps,
  input: MessageEventInput,
  send: SendRun,
): Promise<FireResult[]> {
  if (input.threadTs !== input.ts) return [];
  const triggers = (await watchingTriggers(deps.sql, input.channel, "message")).filter((t) =>
    matchesKeywords(input.text, t.keywords),
  );
  const facts: TriggerEvent = {
    kind: "message",
    channel: input.channel,
    ts: input.ts,
    threadTs: input.ts,
    author: input.author ?? null,
    text: clip(input.text),
    link: messageLink(input.channel, input.ts),
  };
  return fireAll(deps, triggers, facts, `message:${input.channel}:${input.ts}`, send, {
    // The message's own thread is new, so no session holds it yet.
    threadBusy: false,
    deferElsewhere: true,
  });
}

export interface ReactionEventInput {
  channel: string;
  ts: string;
  emoji: string;
  reactor: string;
  // Sym's own Slack user, from the event's authorizations.
  botUserId: string | undefined;
}

// A reaction added to a message in a channel. A reaction by Sym or another bot fires nothing, so
// a run's own reaction never fires a trigger. Nor does a reaction on Sym's own message: that is
// feedback (decision 051).
export async function fireReactionTriggers(
  deps: FireDeps,
  input: ReactionEventInput,
  send: SendRun,
): Promise<FireResult[]> {
  const emoji = normalizeEmoji(input.emoji);
  const triggers = (await watchingTriggers(deps.sql, input.channel, "reaction")).filter(
    (t) => t.emoji === emoji,
  );
  if (triggers.length === 0 || !deps.slack) return [];
  if (!input.reactor || input.reactor === input.botUserId) return [];
  if (await isBotUser(deps.slack, input.reactor)) return [];
  const message = await findMessage(deps.slack, input.channel, input.ts);
  if (!message || message.botId || (input.botUserId && message.user === input.botUserId)) {
    return [];
  }
  const facts: TriggerEvent = {
    kind: "reaction",
    channel: input.channel,
    ts: input.ts,
    threadTs: message.threadTs,
    author: message.user ?? null,
    text: clip(message.text),
    link: messageLink(input.channel, input.ts),
    emoji,
    reactor: input.reactor,
  };
  return fireAll(deps, triggers, facts, `reaction:${input.channel}:${input.ts}`, send, {
    // A thread that already talks with Sym keeps its own session.
    threadBusy: await threadHasSession(deps.sql, input.channel, facts.threadTs),
    deferElsewhere: false,
  });
}

// One run per matching trigger, each in its own session, so each acts for its own creator. Eve
// gives a Slack thread one session, so at most one run can live in the event's thread: the
// oldest trigger that posts there, and none when a session already holds the thread. Every other
// trigger that posts in the thread runs in its creator's DM instead (decision 088).
async function fireAll(
  deps: FireDeps,
  triggers: Trigger[],
  facts: TriggerEvent,
  eventKey: string,
  send: SendRun,
  options: { threadBusy: boolean; deferElsewhere: boolean },
): Promise<FireResult[]> {
  let threadTaken = options.threadBusy;
  const results: FireResult[] = [];
  for (const trigger of triggers) {
    let target: RunTarget | undefined;
    if (trigger.destination) target = { channelId: trigger.destination };
    else if (!threadTaken) {
      target = { channelId: facts.channel, threadTs: facts.threadTs };
      threadTaken = true;
    } else {
      const dm = await openDm(deps.slack, trigger.owner);
      target = dm ? { channelId: dm } : undefined;
    }
    if (!target) {
      results.push({ trigger: triggerRef(trigger.id), status: "no_destination" });
      continue;
    }
    const status = await fire(deps, trigger, facts, eventKey, {
      target,
      deferred: options.deferElsewhere && target.threadTs === undefined,
      send,
    });
    results.push({ trigger: triggerRef(trigger.id), status });
  }
  return results;
}

async function openDm(slack: SlackApi | undefined, user: string): Promise<string | undefined> {
  const opened = await slack?.call("conversations.open", { users: user }).catch(() => undefined);
  const channel = (opened?.channel as { id?: unknown } | undefined)?.id;
  return typeof channel === "string" ? channel : undefined;
}

// Sends the deferred runs: message triggers that post outside the message's thread, which the
// message handler cannot reach. Called each minute by the dispatcher, which can send anywhere.
export async function sendDeferredRuns(
  deps: FireDeps,
  send: SendRun,
  options: { maxAgeMs?: number; leaseMs?: number } = {},
): Promise<number> {
  const now = deps.now ?? new Date();
  let sent = 0;
  const claimed = await claimDeferredRuns(deps.sql, now, {
    maxAgeMs: options.maxAgeMs ?? 10 * 60_000,
    leaseMs: options.leaseMs ?? 2 * 60_000,
  });
  for (const run of claimed) {
    const trigger = run.triggerId === null ? undefined : await getTrigger(deps.sql, run.triggerId);
    if (trigger?.status !== "active" || !run.event || !(await creatorMayRun(deps, trigger))) {
      await finishRun(deps.sql, run.id, "failed");
      await endDeferred(deps.sql, run.id);
      continue;
    }
    if (await sendRun(deps, trigger, run.id, run.event.facts, run.event.target, send)) sent++;
    await endDeferred(deps.sql, run.id);
  }
  return sent;
}

// The runs carry the creator's consent, and reach only what the creator reaches (decision 081):
// the creator must still be allowed and still be a member of the watched channel. A failed
// check, or no Slack to ask, fails closed.
async function creatorMayRun(deps: FireDeps, trigger: Trigger): Promise<boolean> {
  const usersEnv = deps.usersEnv ?? process.env.SYM_SLACK_USERS;
  if (!isSlackUserAllowed(deps.pack, usersEnv, trigger.owner, () => {})) return false;
  const reached = await reachConversation(
    { slack: deps.slack, pack: deps.pack, usersEnv },
    trigger.owner,
    trigger.channel,
  );
  return reached !== undefined;
}

async function fire(
  deps: FireDeps,
  trigger: Trigger,
  facts: TriggerEvent,
  eventKey: string,
  options: { target: RunTarget; deferred: boolean; send: SendRun },
): Promise<string> {
  const reserved = await reserveTriggerRun(deps.sql, {
    triggerId: trigger.id,
    eventKey,
    facts,
    target: options.target,
    deferred: options.deferred,
    firedAt: deps.now ?? new Date(),
    maxPerHour: deps.maxPerHour ?? runsPerHour(),
  });
  if (reserved.status === "limited") {
    console.warn(`Skipped ${triggerRef(trigger.id)}: it reached its hourly run limit.`);
  }
  if (reserved.status !== "reserved") return reserved.status;
  // Checked after the reservation, so a retried event finds the failed run and fires nothing.
  if (!(await creatorMayRun(deps, trigger))) {
    console.warn(`Skipped ${triggerRef(trigger.id)}: its creator left the allow-list or channel.`);
    await finishRun(deps.sql, reserved.run.id, "failed");
    if (options.deferred) await endDeferred(deps.sql, reserved.run.id);
    return "creator_not_allowed";
  }
  if (options.deferred) return "deferred";
  const sent = await sendRun(deps, trigger, reserved.run.id, facts, options.target, options.send);
  return sent ? "sent" : "failed";
}

async function sendRun(
  deps: FireDeps,
  trigger: Trigger,
  runId: number,
  facts: TriggerEvent,
  target: RunTarget,
  send: SendRun,
): Promise<boolean> {
  try {
    // The schedule run's hardened path (decision 085): mark the send, so a creator lookup waits
    // for the attach; send with the run's own key; attach under the session lock.
    await markSending(deps.sql, runId);
    const sessionId = await send({
      message: triggerRunMessage(trigger, facts, target),
      target,
      key: deliveryKey(runId),
      title: `Trigger: ${trigger.title}`,
    });
    if (!sessionId) throw new Error("no session");
    await attachSession(deps.sql, runId, sessionId);
    return true;
  } catch (error) {
    console.warn(`Sym could not start a run of ${triggerRef(trigger.id)}.`, String(error));
    await finishRun(deps.sql, runId, "failed").catch(() => {});
    return false;
  }
}

async function threadHasSession(sql: Sql, channel: string, threadTs: string): Promise<boolean> {
  const [row] = await sql`
    select 1 from session_threads
    where channel_id = ${channel} and thread_ts = ${threadTs} limit 1
  `;
  return Boolean(row);
}

// True when Slack says the user is a bot. A failed lookup counts as a bot, so it fires nothing.
async function isBotUser(slack: SlackApi, user: string): Promise<boolean> {
  try {
    const info = await slack.call("users.info", { user });
    return (info.user as { is_bot?: boolean } | undefined)?.is_bot !== false;
  } catch {
    return true;
  }
}

interface FoundMessage {
  text: string;
  user?: string | undefined;
  botId?: string | undefined;
  threadTs: string;
}

type RawMessage = {
  ts?: string;
  text?: string;
  user?: string;
  bot_id?: string;
  thread_ts?: string;
};

// The reacted message: a top-level message from the channel history, else a reply found in its
// thread. Never throws.
async function findMessage(
  slack: SlackApi,
  channel: string,
  ts: string,
): Promise<FoundMessage | undefined> {
  const pick = (messages: unknown): RawMessage | undefined =>
    Array.isArray(messages) ? (messages as RawMessage[]).find((m) => m.ts === ts) : undefined;
  try {
    // Only the one message lies between `oldest` and `latest`.
    const history = await slack.call("conversations.history", {
      channel,
      latest: ts,
      oldest: ts,
      inclusive: true,
    });
    let found = pick(history.messages);
    if (!found) {
      // A reply: its thread from the root up to the reply.
      const replies = await slack.call("conversations.replies", {
        channel,
        ts,
        latest: ts,
        inclusive: true,
        limit: 1000,
      });
      found = pick(replies.messages);
    }
    if (!found) return undefined;
    return {
      text: found.text ?? "",
      user: found.user,
      botId: found.bot_id,
      threadTs: found.thread_ts ?? ts,
    };
  } catch {
    return undefined;
  }
}
