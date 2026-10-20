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
  messageText,
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

describe("job card buttons", () => {
  // A click on one of Sym's buttons, or Enter in one of its text boxes, from the owner.
  const press = (
    c: ReturnType<typeof newConversation>,
    messageTs: string,
    actionId: string,
    extra: { value?: string; blockId?: string; actionType?: string } = {},
  ) =>
    send(
      blockActionsRequest({
        signingSecret: SIGNING_SECRET,
        channel: c.channel,
        user: OWNER,
        messageTs,
        threadTs: c.rootTs,
        actionId,
        ...extra,
      }),
    );
  const textBox = (c: ReturnType<typeof newConversation>, actionId: string) =>
    until(() => c.botMessages().find((m) => JSON.stringify(m.blocks ?? []).includes(actionId)), {
      label: `the ${actionId} box`,
    });
  const reconcile = async () => {
    const response = await fetch(`${h.eveUrl()}/eve/v1/dev/schedules/reconcile`, {
      method: "POST",
    });
    if (!response.ok) throw new Error(`reconcile answered ${response.status}`);
  };

  it("steers from the card, then fixes and closes from the result", async () => {
    const c = newConversation(h);
    const { approval, job, ref } = await startJob(h, c, "Fix me");
    await c.click(approval, "Start");
    const thread = await until(() => threadsOf(h, ref)[0], { label: `${ref} worker thread` });
    await workerAdvance(h, thread, [{ status: "running", items: ["Working"] }]);
    const card = await until(() => c.botMessages().find(isCard), { label: `${ref} job card` });

    // Steer: the button posts a text box, and Enter in it steers the worker thread.
    await press(c, card.ts, "sym_job_steer", { value: ref });
    const steerBox = await textBox(c, "sym_job_steer_text");
    await press(c, steerBox.ts, "sym_job_steer_text", {
      value: "skip the staging test",
      blockId: `steer-${ref}`,
      actionType: "plain_text_input",
    });
    await until(() => thread.sends.find((m) => m.mode === "steer"), { label: "the steer send" });
    expect(thread.sends.at(-1)?.message).toContain("skip the staging test");
    await until(
      () => {
        const now = h.slack.messages.find((m) => m.ts === steerBox.ts);
        return now && !JSON.stringify(now.blocks).includes("sym_job_steer_text") ? true : undefined;
      },
      { label: "the answered steer box" },
    );

    // The result has Looks good, Fix, and Close.
    await workerAdvance(h, thread, finishedSteps());
    await waitForJobStatus(h.sql, job.id, "done");
    const result = await resultMessage(c, ref);
    expect(JSON.stringify(result.blocks)).toContain("sym_job_fix");
    await press(c, result.ts, "sym_job_ok", { value: ref });
    await until(
      async () =>
        (await h.sql`select 1 from feedback where job_id = ${job.id} and value = 'looks_good'`)[0],
      { label: "the Looks good row" },
    );

    // Fix: a text box, then a follow-up job on the same worker thread.
    await press(c, result.ts, "sym_job_fix", { value: ref });
    const fixBox = await textBox(c, "sym_job_fix_text");
    await press(c, fixBox.ts, "sym_job_fix_text", {
      value: "also log each retry",
      blockId: `fix-${ref}`,
      actionType: "plain_text_input",
    });
    const [child] = await until(
      async () => {
        const rows = await h.sql<{ id: number }[]>`
          select id::int from jobs where parent_job_id = ${job.id}
        `;
        return rows.length > 0 ? rows : undefined;
      },
      { label: "the follow-up job" },
    );
    const childRef = `J-${child?.id}`;
    expect(thread.sends.at(-1)).toMatchObject({ mode: "auto" });
    expect(thread.sends.at(-1)?.message).toContain("also log each retry");
    // The parent's result loses its Fix button.
    await until(
      () => {
        const now = h.slack.messages.find((m) => m.ts === result.ts);
        return now && !JSON.stringify(now.blocks).includes("sym_job_fix") ? true : undefined;
      },
      { label: "the edited parent result" },
    );

    // No task watches the follow-up; reconcile drives it to its own result once its short
    // start lease ends. The test ends the lease instead of waiting a minute.
    await h.sql`update jobs set watch_until = now() - interval '1 second' where id = ${Number(child?.id)}`;
    thread.steps.push({
      status: "completed",
      items: [contractMessage({ ...SAMPLE_CONTRACT, summary: "Logged each retry." })],
    });
    await reconcile();
    await waitForJobStatus(h.sql, Number(child?.id), "done");
    const childResult = await resultMessage(c, childRef);
    expect(messageText(childResult)).toContain("Logged each retry.");

    // Close settles the worker thread and removes the result buttons.
    await press(c, childResult.ts, "sym_job_close", { value: childRef });
    await until(() => (thread.organized.includes("settle") ? true : undefined), {
      label: "the settle call",
    });
    await until(
      () => {
        const now = h.slack.messages.find((m) => m.ts === childResult.ts);
        const json = JSON.stringify(now?.blocks ?? []);
        return now && !json.includes("sym_job_close") && json.includes("Closed by")
          ? true
          : undefined;
      },
      { label: "the closed result" },
    );
  });

  it("shows Stop on the live card, and Stop cancels the job", async () => {
    const c = newConversation(h);
    const { approval, job, ref } = await startJob(h, c, "Stop me");
    await c.click(approval, "Start");
    const thread = await until(() => threadsOf(h, ref)[0], { label: `${ref} worker thread` });
    await workerAdvance(h, thread, [{ status: "running", items: ["Working"] }]);
    const card = await until(() => c.botMessages().find(isCard), { label: `${ref} job card` });
    expect(JSON.stringify(card.blocks)).toContain('"action_id":"sym_job_stop"');

    // A stranger's click does nothing.
    await send(
      blockActionsRequest({
        signingSecret: SIGNING_SECRET,
        channel: c.channel,
        user: OUTSIDER,
        messageTs: card.ts,
        threadTs: c.rootTs,
        actionId: "sym_job_stop",
        value: ref,
      }),
    );
    await new Promise((r) => setTimeout(r, 2_500));
    expect((await waitForJobStatus(h.sql, job.id, "running")).status).toBe("running");
    expect(h.t3.calls.some((call) => call.name === "t3_thread_interrupt")).toBe(false);

    const before = h.slack.ephemerals.length;
    await send(
      blockActionsRequest({
        signingSecret: SIGNING_SECRET,
        channel: c.channel,
        user: OWNER,
        messageTs: card.ts,
        threadTs: c.rootTs,
        actionId: "sym_job_stop",
        value: ref,
      }),
    );
    await waitForJobStatus(h.sql, job.id, "cancelled");
    const answer = await until(() => h.slack.ephemerals.slice(before)[0], {
      label: "the Stop answer",
    });
    expect(answer.text).toBe(`Stopped ${ref}.`);
    expect(answer.target_user).toBe(OWNER);
    expect(h.t3.calls.some((call) => call.name === "t3_thread_interrupt")).toBe(true);

    // The collapsed card has no Stop button.
    await until(
      () => {
        const now = h.slack.messages.find((m) => m.ts === card.ts);
        return now && !JSON.stringify(now.blocks).includes("sym_job_stop") ? true : undefined;
      },
      { label: "the collapsed card" },
    );
  });

  it("records a feedback click and a reaction on the card against the job", async () => {
    const c = newConversation(h);
    const { approval, job, ref } = await startJob(h, c, "Rate me");
    await c.click(approval, "Start");
    const thread = await until(() => threadsOf(h, ref)[0], { label: `${ref} worker thread` });
    const card = await until(() => c.botMessages().find(isCard), { label: `${ref} job card` });

    await send(
      blockActionsRequest({
        signingSecret: SIGNING_SECRET,
        channel: c.channel,
        user: OWNER,
        messageTs: card.ts,
        threadTs: c.rootTs,
        actionId: "sym_feedback",
        value: "down",
        actionType: "feedback_buttons",
      }),
    );
    for (const user of [OWNER, OWNER, OUTSIDER]) {
      await send(
        reactionAddedRequest({
          signingSecret: SIGNING_SECRET,
          channel: c.channel,
          user,
          reaction: "+1",
          messageTs: card.ts,
        }),
      );
    }
    await until(
      async () => {
        const rows = await h.sql`select * from feedback where job_id = ${job.id}`;
        return rows.length >= 2 ? rows : undefined;
      },
      { label: "feedback rows" },
    );
    await new Promise((r) => setTimeout(r, 2_500));
    const rows = await h.sql<{ slackUser: string; kind: string; value: string }[]>`
      select slack_user, kind, value from feedback where job_id = ${job.id} order by kind`;
    // The repeated reaction counts once. The outsider's reaction is ignored. The click and the
    // reaction arrive as separate requests, so the order is by kind, not by arrival.
    expect(rows).toEqual([
      { slackUser: OWNER, kind: "thumbs_down", value: "down" },
      { slackUser: OWNER, kind: "thumbs_up", value: "+1" },
    ]);

    await workerAdvance(h, thread, finishedSteps());
    await waitForJobStatus(h.sql, job.id, "done");
    expect(messageText(card)).toContain(ref);
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
