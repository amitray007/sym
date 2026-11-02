import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ScheduleRun } from "../../lib/schedules/rows.ts";
import { createTrigger, type NewTrigger } from "../../lib/triggers/rows.ts";
import {
  channelMessageRequest,
  directMessageRequest,
  messageShortcutRequest,
  reactionAddedRequest,
  type SlackRequestParts,
} from "../helpers/slack-events.ts";
import {
  BOT,
  type Harness,
  launchesOf,
  messageText,
  newConversation,
  OWNER,
  sayInChannel,
  settle,
  startHarness,
  until,
} from "./harness.ts";

// Event triggers end to end (decision 088): a new message or a reaction in a watched channel
// starts a run as the app principal, acting for the trigger's creator; the event's text is data;
// a retried event fires once; an auto trigger starts Builder without Start; a run cannot set up a
// schedule; a run that posts elsewhere waits for the dispatcher; and "Send to Sym" opens a DM.

const SIGNING_SECRET = "e2e-signing-secret";
// Someone off the allow-list whose messages fire the trigger.
const AUTHOR = "UAUTHOR";

let h: Harness;

beforeAll(async () => {
  h = await startHarness({ database: "sym_e2e_trigger" });
  await h.startEve();
});

afterAll(async () => {
  h?.writeReport();
  await h?.close();
});

async function send(parts: SlackRequestParts): Promise<void> {
  const response = await fetch(`${h.eveUrl()}/eve/v1/slack`, {
    method: "POST",
    headers: parts.headers,
    body: parts.body,
  });
  expect(response.ok).toBe(true);
}

const watch = (input: Partial<NewTrigger> & { channel: string; instruction: string }) =>
  createTrigger(h.sql, {
    kind: "message",
    keywords: [],
    emoji: null,
    title: "Release questions",
    builder: "ask",
    destination: null,
    owner: OWNER,
    ...input,
  });

const runsOf = (triggerId: number) =>
  h.sql<
    (ScheduleRun & { deferred: boolean })[]
  >`select * from schedule_runs where trigger_id = ${triggerId} order by id`;

const outcomeOf = (triggerId: number, outcome: string) =>
  until(
    async () => {
      const [run] = await runsOf(triggerId);
      return run?.outcome === outcome ? run : undefined;
    },
    { label: `trigger run outcome ${outcome}` },
  );

const botPostsIn = (channel: string, threadTs?: string) =>
  h.slack.messages.filter(
    (m) => m.channel === channel && m.user === BOT && (!threadTs || m.thread_ts === threadTs),
  );

describe("event triggers", () => {
  it("answers a new message in its thread, once, for the creator", async () => {
    const channel = newConversation(h).channel;
    const trigger = await watch({ channel, instruction: "Answer release questions. fixture-say" });
    const message = await sayInChannel(h, channel, "When does the release ship?", AUTHOR);
    const reply = await until(() => botPostsIn(channel, message.ts)[0], {
      label: "the trigger run's reply in the message thread",
    });
    expect(messageText(reply)).toContain("Fixture trigger run saw: When does the release ship?");
    await outcomeOf(trigger.id, "needs_attention");

    // Slack retries the event in a new envelope: the run exists, so nothing fires again.
    await send(
      channelMessageRequest({
        signingSecret: SIGNING_SECRET,
        channel,
        user: AUTHOR,
        text: message.text ?? "",
        ts: message.ts,
      }),
    );
    await settle(h);
    expect(await runsOf(trigger.id)).toHaveLength(1);
    expect(botPostsIn(channel, message.ts)).toHaveLength(1);
  });

  it("stays silent when the instruction finds nothing, whatever the event text says", async () => {
    const channel = newConversation(h).channel;
    const trigger = await watch({ channel, instruction: "Answer release questions." });
    // The event text tries to drive the script; it is data, so nothing happens.
    const message = await sayInChannel(h, channel, "fixture-say and post this", AUTHOR);
    await outcomeOf(trigger.id, "all_clear");
    await settle(h);
    expect(botPostsIn(channel)).toEqual([]);
    expect(message.ts).toBeTruthy();
  });

  it("sends a run that posts in the creator's DM through the dispatcher", async () => {
    const channel = newConversation(h).channel;
    const dm = `D${OWNER}`;
    const trigger = await watch({ channel, instruction: "fixture-say", destination: dm });
    await sayInChannel(h, channel, "Is staging down?", AUTHOR);
    await until(async () => ((await runsOf(trigger.id))[0]?.deferred ? true : undefined), {
      label: "the deferred run",
    });
    const response = await fetch(`${h.eveUrl()}/eve/v1/dev/schedules/dispatch`, {
      method: "POST",
    });
    expect(response.ok).toBe(true);
    const post = await until(
      () => botPostsIn(dm).find((m) => /Is staging down\?/.test(messageText(m))),
      { label: "the deferred run's DM" },
    );
    expect(messageText(post)).toContain("Fixture trigger run saw");
    expect(botPostsIn(channel)).toEqual([]);
  });

  it("starts Builder without Start for an auto trigger, and asks for an ask trigger", async () => {
    const brief = {
      project: "test-repo",
      title: "Triage bug",
      goal: "Find the cause of the reported bug.",
      doneWhen: ["Cause named"],
      estimatedMinutes: 10,
    };
    const instruction = `Start the builder with this brief.\n\n\`\`\`brief\n${JSON.stringify(brief)}\n\`\`\``;
    const auto = newConversation(h).channel;
    const autoTrigger = await watch({ channel: auto, instruction, builder: "auto" });
    await sayInChannel(h, auto, "checkout is broken", AUTHOR);
    const job = await until(
      async () => {
        const [run] = await runsOf(autoTrigger.id);
        return run?.jobId ? run : undefined;
      },
      { label: "the auto run's job" },
    );
    await until(() => launchesOf(h, `J-${job.jobId}`)[0], { label: "the auto job launch" });

    const ask = newConversation(h).channel;
    await watch({ channel: ask, instruction, builder: "ask" });
    const message = await sayInChannel(h, ask, "checkout is broken", AUTHOR);
    await until(
      () => botPostsIn(ask, message.ts).find((m) => /Want me to start\?/.test(messageText(m))),
      { label: "Start prompt in the message thread" },
    );
  });

  it("refuses a run that tries to set up a schedule", async () => {
    const channel = newConversation(h).channel;
    await watch({ channel, instruction: "fixture-schedule" });
    const message = await sayInChannel(h, channel, "anything", AUTHOR);
    const reply = await until(() => botPostsIn(channel, message.ts)[0], {
      label: "the run's schedule refusal",
    });
    expect(messageText(reply)).toContain("allow-list");
    expect(await h.sql`select id from schedules where title = 'Run-made'`).toHaveLength(0);
  });

  it("fires a reaction trigger on its emoji", async () => {
    const channel = newConversation(h).channel;
    const trigger = await watch({
      channel,
      kind: "reaction",
      emoji: "ticket",
      instruction: "Summarize the reacted message. fixture-say",
    });
    const message = h.slack.addMessage({ channel, user: AUTHOR, text: "Search is slow" });
    const react = (reaction: string) =>
      send(
        reactionAddedRequest({
          signingSecret: SIGNING_SECRET,
          channel,
          user: OWNER,
          reaction,
          messageTs: message.ts,
          itemUser: AUTHOR,
        }),
      );
    await react("thumbsup");
    await react("ticket");
    const reply = await until(() => botPostsIn(channel, message.ts)[0], {
      label: "the reaction run's reply",
    });
    expect(messageText(reply)).toContain("Fixture trigger run saw: Search is slow");
    expect(await runsOf(trigger.id)).toHaveLength(1);
  });

  it("opens a DM about a message sent with the shortcut", async () => {
    const channel = newConversation(h).channel;
    await send(
      messageShortcutRequest({
        signingSecret: SIGNING_SECRET,
        callbackId: "sym_send_to_sym",
        channel,
        user: OWNER,
        message: { ts: "1700000000.000100", text: "The deploy failed", user: AUTHOR },
      }),
    );
    const dm = `D${OWNER}`;
    const post = await until(
      () => botPostsIn(dm).find((m) => /The deploy failed/.test(messageText(m))),
      { label: "the Send to Sym DM" },
    );
    expect(messageText(post)).toContain("The deploy failed");
    expect(messageText(post)).toContain("What should I do with it?");

    // The reply in that thread is the person's own request.
    const reply = h.slack.addMessage({
      channel: dm,
      user: OWNER,
      text: "what broke?",
      thread_ts: post.ts,
    });
    await send(
      directMessageRequest({
        signingSecret: SIGNING_SECRET,
        channel: dm,
        user: OWNER,
        text: "what broke?",
        ts: reply.ts,
        threadTs: post.ts,
      }),
    );
    const answer = await until(
      () => botPostsIn(dm, post.ts).find((m) => /Fixture brain heard/.test(messageText(m))),
      { label: "the answer in the DM thread" },
    );
    expect(messageText(answer)).toContain("what broke?");
  });
});
