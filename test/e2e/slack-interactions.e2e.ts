import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { quietMigration } from "../../lib/quiet/migration.ts";
import {
  blockActionsRequest,
  reactionAddedRequest,
  type SlackRequestParts,
  slashCommandRequest,
} from "../helpers/slack-events.ts";
import {
  contractMessage,
  finishedSteps,
  type Harness,
  isCard,
  newConversation,
  OWNER,
  resultMessage,
  SAMPLE_CONTRACT,
  settle,
  startHarness,
  startJob,
  threadsOf,
  until,
  waitForJobStatus,
  workerAdvance,
} from "./harness.ts";

// Slash commands, the Stop button, feedback, and reactions against the real `eve dev` server and
// the fake Slack (docs/slack.md). The signing secret matches the harness.

const SIGNING_SECRET = "e2e-signing-secret";
const OUTSIDER = "UOUTSIDER";

let h: Harness;

beforeAll(async () => {
  h = await startHarness({ database: "sym_e2e_interactions" });
  // The statements are idempotent, so this is harmless once the ledger registers the migration.
  await h.sql.unsafe(quietMigration.sql);
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

async function slash(channel: string, text: string, user = OWNER) {
  const before = h.slack.ephemerals.length;
  await send(slashCommandRequest({ signingSecret: SIGNING_SECRET, channel, user, text }));
  return until(() => h.slack.ephemerals.slice(before)[0], { label: `answer to /sym ${text}` });
}

describe("slash command", () => {
  it("answers status privately and sets and ends quiet mode", async () => {
    const status = await slash("C0SLASH1", "status");
    expect(status.target_user).toBe(OWNER);
    expect(status.channel).toBe("C0SLASH1");
    expect(status.text).toContain("no active jobs");

    const quiet = await slash("C0SLASH1", "quiet 30");
    expect(quiet.text).toMatch(/^Quiet until \d\d:\d\d UTC\./);
    const [row] = await h.sql<
      { value: string }[]
    >`select value from settings where key = 'quiet_until'`;
    const minutes = (new Date(row?.value ?? "").getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(28);
    expect(minutes).toBeLessThanOrEqual(30);

    expect((await slash("C0SLASH1", "status")).text).toContain("Quiet until");

    expect((await slash("C0SLASH1", "quiet off")).text).toBe("Quiet mode is off.");
    expect(await h.sql`select * from settings where key = 'quiet_until'`).toHaveLength(0);
  });

  it("shows usage for an unknown word and refuses a person outside the allow-list", async () => {
    expect((await slash("C0SLASH2", "dance")).text).toContain("Usage:");
    const refused = await slash("C0SLASH2", "status", OUTSIDER);
    expect(refused.target_user).toBe(OUTSIDER);
    // No owner is configured here, so every persona gets the short line (decision 053).
    expect(refused.text).toBe("Sym only works for people on its allow-list.");
    expect(await h.sql`select * from settings`).toHaveLength(0);
  });
});

describe("job conversation", () => {
  const reconcile = async () => {
    const response = await fetch(`${h.eveUrl()}/eve/v1/dev/schedules/reconcile`, {
      method: "POST",
    });
    expect(response.ok).toBe(true);
  };
  it("starts by typing, steers in conversation, approves a follow-up and closes it", async () => {
    const c = newConversation(h);
    const { job, ref } = await startJob(h, c, "Fix me");
    await c.say("start");
    const thread = await until(() => threadsOf(h, ref)[0], { label: "the worker" });
    const note = await until(() => c.botMessages().find(isCard), { label: "the working note" });
    expect(JSON.stringify(note.blocks)).not.toMatch(/sym_job_(steer|stop)/);
    await c.say(`fixture-steer ${ref}: skip the staging test`);
    await until(() => thread.sends.find((m) => m.mode === "steer"), { label: "typed direction" });
    await workerAdvance(h, thread, finishedSteps());
    await waitForJobStatus(h.sql, job.id, "done");
    const result = await resultMessage(c, ref);
    expect(JSON.stringify(result.blocks)).not.toMatch(/sym_job_(ok|fix|close)/);
    await c.say(`fixture-followup ${ref}: also log each retry`);
    const proposal = await c.waitForControls(/same branch/);
    expect(thread.sends.filter((m) => m.mode === "auto")).toHaveLength(0);
    await c.click(proposal, "Start");
    const child = await until(
      async () =>
        (
          await h.sql<{ id: number }[]>`select id::int from jobs where parent_job_id = ${job.id}`
        )[0],
      { label: "the follow-up" },
    );
    await until(() => thread.sends.find((m) => m.mode === "auto"), {
      label: "approved follow-up send",
    });
    await h.sql`update jobs set watch_until = null where id = ${child.id}`;
    thread.steps.push({
      status: "completed",
      items: [contractMessage({ ...SAMPLE_CONTRACT, summary: "Logged each retry." })],
    });
    await reconcile();
    await waitForJobStatus(h.sql, child.id, "done");
    await resultMessage(c, `J-${child.id}`);
    await c.say(`fixture-close J-${child.id}`);
    await until(() => (thread.organized.includes("settle") ? true : undefined), {
      label: "settled worker",
    });
    expect(
      (await h.sql`select closed_at from jobs where id = ${child.id}`)[0]?.closedAt,
    ).toBeTruthy();
  });

  it("keeps Stop owner-confirmed and leaves no Stop control on the note", async () => {
    const c = newConversation(h);
    const { approval, job, ref } = await startJob(h, c, "Stop me");
    await c.click(approval, "Start");
    const thread = await until(() => threadsOf(h, ref)[0], { label: "the worker" });
    await c.say(`fixture-stop ${ref}`);
    const gate = await c.waitForControls(new RegExp(`Stop ${ref}\\?`));
    await c.click(gate, "Approve", OUTSIDER);
    await settle(h, 250);
    expect(thread.interrupts).toHaveLength(0);
    await c.click(gate, "Approve");
    await waitForJobStatus(h.sql, job.id, "cancelled");
    expect(thread.interrupts).toHaveLength(1);
  });

  it("keeps feedback on results and reactions, with no feedback on chat replies", async () => {
    const c = newConversation(h);
    await c.mention("<@UBOT> a short check");
    const chat = await c.waitForPrompt(/Fixture brain heard/);
    expect(JSON.stringify(chat.blocks)).not.toContain("sym_feedback");
    const { approval, job, ref } = await startJob(h, c, "Feedback job");
    await c.click(approval, "Start");
    const thread = await until(() => threadsOf(h, ref)[0], { label: "the worker" });
    await workerAdvance(h, thread, finishedSteps());
    const result = await resultMessage(c, ref);
    expect(JSON.stringify(result.blocks)).toContain("sym_feedback");
    await send(
      blockActionsRequest({
        signingSecret: SIGNING_SECRET,
        channel: c.channel,
        user: OWNER,
        messageTs: result.ts,
        threadTs: c.rootTs,
        actionId: "sym_feedback",
        value: "down",
        actionType: "feedback_buttons",
      }),
    );
    for (const user of [OWNER, OWNER, OUTSIDER])
      await send(
        reactionAddedRequest({
          signingSecret: SIGNING_SECRET,
          channel: c.channel,
          user,
          reaction: "+1",
          messageTs: result.ts,
        }),
      );
    await until(
      async () =>
        (await h.sql`select id from feedback where job_id = ${job.id}`).length === 2
          ? true
          : undefined,
      { label: "feedback rows" },
    );
    expect(
      await h.sql`select slack_user, kind from feedback where job_id = ${job.id} order by kind`,
    ).toEqual([
      { slackUser: OWNER, kind: "thumbs_down" },
      { slackUser: OWNER, kind: "thumbs_up" },
    ]);
  });
});

describe("reactions", () => {
  it("reacts on the message that started each turn, with no text reply (decision 051)", async () => {
    const c = newConversation(h);
    await c.mention("<@UBOT> thanks, fixture-react :tada:");
    const first = await until(
      () => h.slack.reactions.find((r) => r.channel === c.channel && r.timestamp === c.rootTs),
      { label: "the reaction on the first message" },
    );
    expect(first.name).toBe("tada");

    await c.reply("<@UBOT> nice, fixture-react 🙌");
    const reply = await until(
      () =>
        h.slack.reactions.find(
          (r) => r.channel === c.channel && r.timestamp !== c.rootTs && r.name === "raised_hands",
        ),
      { label: "the reaction on the reply" },
    );
    expect(reply.timestamp).not.toBe(c.rootTs);

    await settle(h);
    expect(c.botMessages()).toHaveLength(0);
    const rows = await h.sql`select * from reactions where channel_id = ${c.channel}`;
    expect(rows).toHaveLength(2);
  });
});
