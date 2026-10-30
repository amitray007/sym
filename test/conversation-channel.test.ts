import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Sql } from "../lib/db.ts";
import { presentBrief } from "../lib/jobs/present.ts";
import type { JobDeps } from "../lib/jobs/run.ts";
import { storeChoices } from "../lib/ledger/choices.ts";
import { createJob } from "../lib/ledger/jobs.ts";
import { setListenMode } from "../lib/ledger/listen.ts";
import { recordSessionThread } from "../lib/ledger/threads.ts";
import { SlackApiError } from "../lib/slack/api.ts";
import { FakeWorker } from "./fakes/worker.ts";
import { hasDatabase, useLedger } from "./helpers/ledger.ts";
import { TEST_PROJECTS } from "./helpers/projects.ts";

const runtime = vi.hoisted(() => ({
  sql: undefined as Sql | undefined,
  deps: undefined as JobDeps | undefined,
}));
vi.mock("../lib/runtime.ts", async (original) => ({
  ...(await original<object>()),
  ledger: () => runtime.sql,
  pack: () => undefined,
  slackFromEnv: () => runtime.deps?.slack,
  withJobDeps: (fn: (deps: JobDeps) => unknown) => {
    if (!runtime.deps) throw new Error("Missing test dependencies");
    return fn(runtime.deps);
  },
}));
vi.mock("eve/channels/slack", async (original) => ({
  ...(await original<object>()),
  slackChannel: (config: unknown) => config,
}));

import channelDefinition from "../agent/channels/slack.ts";
import jobClose from "../agent/tools/job_close.ts";
import offerChoices from "../agent/tools/offer_choices.ts";

// biome-ignore lint/suspicious/noExplicitAny: invoke the registered channel handlers with a focused Slack context
const channel = channelDefinition as any;
const require = createRequire(import.meta.url);
const eveRoot = new URL(".", `file://${require.resolve("eve")}`);
const { resolveTypedApproval } = await import(new URL("harness/hitl/delivery.js", eveRoot).href);

describe.skipIf(!hasDatabase)("Slack conversation decision boundary", () => {
  const ledger = useLedger();
  afterEach(() => vi.unstubAllEnvs());
  async function setup(key: string) {
    runtime.sql = ledger.sql();
    vi.stubEnv("SYM_SLACK_USERS", "U1,U2");
    const slack = {
      call: vi.fn(async (_method: string, body: Record<string, unknown>) => ({
        ok: true,
        ts: body.ts ?? "2.0",
      })),
    };
    runtime.deps = {
      sql: runtime.sql,
      slack,
      worker: new FakeWorker(),
      allowedProjects: TEST_PROJECTS,
    };
    await recordSessionThread(runtime.sql, {
      sessionId: key,
      channelId: "C1",
      threadTs: key,
      teamId: "T1",
      userId: "U1",
    });
    const job = await createJob(runtime.sql, {
      requestKey: key,
      sessionId: key,
      kind: "code-change",
      title: "Retry",
      brief: {
        project: "test-repo",
        title: "Retry",
        goal: "add retries",
        constraints: [],
        doneWhen: ["Test"],
        estimatedMinutes: 5,
        openPullRequest: false,
      },
      worker: "fake",
      owner: "U1",
      slackChannel: "C1",
      slackThreadTs: key,
    });
    await presentBrief(runtime.sql, job);
    await runtime.sql`update job_proposals set message_ts = '2.0' where job_id = ${job.id}`;
    let mentioned = false;
    const messages = [{ ts: "2.0", user: "UBOT", botId: "bot", isMe: true, text: "Start?" }];
    const ctx = {
      isSubscribed: async () => true,
      isBotMentioned: () => mentioned,
      slack: { channelId: "C1", threadTs: key, codeChannel: false, request: slack.call },
      thread: {
        recentMessages: messages,
        refresh: async () => {},
        listParticipants: async () => ["U1", "U2"],
      },
    };
    const message = (by: string, text: string) => ({
      channelId: "C1",
      threadTs: key,
      ts: "3.0",
      text,
      author: { userId: by, isBot: false },
    });
    return {
      ctx,
      message,
      messages,
      job,
      sql: runtime.sql,
      slack,
      mention: () => {
        mentioned = true;
      },
    };
  }
  it.each(["yes", "no"])("leaves another person's %s in a shared thread unbound", async (text) => {
    const s = await setup(`shared-${text}`);
    await channel.onMessage(s.ctx, s.message("U2", text));
    expect(
      (await s.sql`select status from job_proposals where job_id = ${s.job.id}`)[0]?.status,
    ).toBe("pending");
  });
  it("requires a tag in mention-only mode, and strips that tag before matching the decision", async () => {
    const s = await setup("mention-only");
    await setListenMode(s.sql, {
      channelId: "C1",
      threadTs: "mention-only",
      mode: "mention-only",
      updatedBy: "U1",
    });
    await channel.onMessage(s.ctx, s.message("U1", "yes"));
    expect(
      (await s.sql`select status from job_proposals where job_id = ${s.job.id}`)[0]?.status,
    ).toBe("pending");
    s.mention();
    await channel.onAppMention(s.ctx, s.message("U1", "<@UBOT> yes"));
    expect(
      (await s.sql`select status from job_proposals where job_id = ${s.job.id}`)[0]?.status,
    ).toBe("approved");
  });
  it("binds only the served person's immediate reply to the proposal", async () => {
    const s = await setup("immediate");
    s.messages.push({ ts: "2.5", user: "U2", botId: "", isMe: false, text: "Should I deploy?" });
    await channel.onMessage(s.ctx, s.message("U1", "yes"));
    expect(
      (await s.sql`select status from job_proposals where job_id = ${s.job.id}`)[0]?.status,
    ).toBe("pending");
    s.messages.pop();
    await channel.onMessage(s.ctx, s.message("U1", "yes"));
    expect(
      (await s.sql`select status from job_proposals where job_id = ${s.job.id}`)[0]?.status,
    ).toBe("approved");
  });
  it("defuses choice text and guards its deleted thread root", async () => {
    const s = await setup("choice-mentions");
    // biome-ignore lint/suspicious/noExplicitAny: execute the registered tool through its public interface
    const offer = (offerChoices as any).execute;
    await offer(
      { message: "Ask <!channel> and <@U1>", choices: ["<!here>", "Wait"] },
      {
        session: { id: "choice-mentions", auth: { current: { principalId: "slack:T1:U1" } } },
        callId: "offer",
      },
    );
    const calls = vi.mocked(s.slack.call).mock.calls;
    const post = calls.filter(([method]) => method === "chat.postMessage").at(-1);
    expect(String(post?.[1].text)).not.toMatch(/<!|<@/);
    expect(JSON.stringify(post?.[1].blocks)).not.toContain("Ask <!channel>");
    expect(calls.some(([method]) => method === "chat.getPermalink")).toBe(true);
    vi.mocked(s.slack.call).mockImplementation(async (method) => {
      if (method === "chat.getPermalink") throw new SlackApiError(method, "message_not_found");
      return { ok: true, ts: "4.0" };
    });
    await offer(
      { message: "Deleted-thread choice", choices: ["Explain", "Wait"] },
      {
        session: { id: "choice-mentions", auth: { current: { principalId: "slack:T1:U1" } } },
        callId: "deleted-offer",
      },
    );
    const [deleted] =
      await s.sql`select status from outbox where idempotency_key = 'choice-mentions:deleted-offer:choices'`;
    expect(deleted?.status).toBe("failed");
  });
  it("expires a job's conversation-tool choices on Close", async () => {
    const s = await setup("close-offer");
    const ctx = {
      session: { id: "close-offer", auth: { current: { principalId: "slack:T1:U1" } } },
      callId: "offer",
    };
    // biome-ignore lint/suspicious/noExplicitAny: invoke the registered tool's public execute method
    await (offerChoices as any).execute({ message: "Next?", choices: ["Explain", "Wait"] }, ctx);
    await s.sql`update jobs set status = 'done' where id = ${s.job.id}`;
    // biome-ignore lint/suspicious/noExplicitAny: invoke the registered tool's public execute method
    await (jobClose as any).execute({ ref: `J-${s.job.id}` }, ctx);
    const [choice] =
      await s.sql`select job_id::int, expires_at <= now() as expired from conversation_choices where request_key = 'close-offer:offer:choices'`;
    expect(choice).toMatchObject({ jobId: s.job.id, expired: true });
  });
  it("cannot feed an old choice label into Eve's newer suspended owner approval", async () => {
    const s = await setup("old-choice");
    const choice = await storeChoices(s.sql, {
      key: "old-choice",
      channel: "C1",
      threadTs: "old-choice",
      message: "What next?",
      choices: ["Approve", "Wait"],
    });
    await s.sql`update conversation_choices set message_ts = '1.5' where id = ${choice.id}::bigint`;
    let delivered: unknown;
    let resolved: unknown;
    const send = vi.fn(async (message: unknown) => {
      // A plain string reaches the installed resolver. Message parts must leave the approval pending.
      const input = { message, deliveries: [{ deliveryId: "click" }] };
      const view = {
        projection: {
          view: {
            session: {},
            runs: {},
            calls: {},
            responses: {},
            interactions: {
              approval: {
                interactionId: "approval",
                status: "open",
                introducedAt: 1,
                subject: { callId: "owner-tool" },
                request: {
                  kind: "approval",
                  prompt: "Owner only",
                  options: [
                    { id: "approve", label: "Approve" },
                    { id: "deny", label: "Deny" },
                  ],
                },
              },
            },
          },
        },
        turn: { suspended: [{ requests: [{ interactionId: "approval" }] }] },
      };
      delivered = input;
      resolved = resolveTypedApproval(view, input);
    });
    await channel.onInteraction(
      { actionId: "sym_choice_0", value: `${choice.id}:0`, user: { id: "U2" }, messageTs: "1.5" },
      { ...s.ctx, send },
    );
    expect(send).toHaveBeenCalledOnce();
    expect(resolved).toEqual(delivered);
    expect(send.mock.calls[0]?.[0]).toEqual([
      { type: "text", text: '<@U2> chose this conversation option: "Approve"' },
    ]);
  });
});
