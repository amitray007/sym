import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { quietMigration } from "../../lib/quiet/migration.ts";
import {
  blockActionsRequest,
  reactionAddedRequest,
  type SlackRequestParts,
  slashCommandRequest,
} from "../helpers/slack-events.ts";
import {
  finishedSteps,
  type Harness,
  isCard,
  messageText,
  newConversation,
  OWNER,
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
    expect(refused.text).toContain("not on Sym's allow-list");
    expect(await h.sql`select * from settings`).toHaveLength(0);
  });
});

describe("job card buttons", () => {
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
      select slack_user, kind, value from feedback where job_id = ${job.id} order by id`;
    // The repeated reaction counts once. The outsider's reaction is ignored.
    expect(rows).toEqual([
      { slackUser: OWNER, kind: "thumbs_down", value: "down" },
      { slackUser: OWNER, kind: "thumbs_up", value: "+1" },
    ]);

    await workerAdvance(h, thread, finishedSteps());
    await waitForJobStatus(h.sql, job.id, "done");
    expect(messageText(card)).toContain(ref);
  });
});
