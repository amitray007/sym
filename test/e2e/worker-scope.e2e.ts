import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, expect, it } from "vitest";
import { startFollowUp } from "../../lib/jobs/followup.ts";
import { createJob, getJob, updateJob } from "../../lib/ledger/jobs.ts";
import { pendingPosts } from "../../lib/ledger/outbox.ts";
import { workerIdentity } from "../../lib/workers/resolve.ts";
import { t3Adapter } from "../../lib/workers/t3/adapter.ts";
import { connectT3 } from "../../lib/workers/t3/client.ts";
import {
  type Harness,
  newConversation,
  startHarness,
  startJob,
  threadsOf,
  until,
} from "./harness.ts";

let h: Harness;
beforeAll(async () => {
  h = await startHarness({
    database: "sym_worker_scope",
    env: { SYM_MCP_TOKEN: "fake-shared-read-token" },
  });
  await h.startEve();
});
afterAll(async () => {
  await h?.close();
});

it("provisions scoped callbacks on launch and Fix and enforces scope through the real MCP route", async () => {
  const c = newConversation(h);
  const { approval, job, ref } = await startJob(h, c, "Worker scope");
  await c.click(approval, "Start");
  const thread = await until(() => threadsOf(h, ref)[0], { label: "scoped worker launch" });
  const match = /Authorization: Bearer (symjob_[a-f0-9]{64})/.exec(String(thread.launch.message));
  const token = match?.[1];
  if (!token) throw new Error("Launch did not provision a worker capability.");
  const victim = await createJob(h.sql, {
    requestKey: "victim",
    kind: "code-change",
    title: "Victim job",
    brief: {},
    worker: "t3",
    slackChannel: "CPRIVATE",
    slackThreadTs: "1.2",
  });
  const call = async (credential: string, tool: string, args: Record<string, unknown>) => {
    const client = new Client({ name: "scope-test", version: "1" });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${h.eveUrl()}/eve/v1/mcp`), {
          authProvider: { token: async () => credential },
        }),
      );
      const result = await client.callTool({ name: tool, arguments: args });
      return JSON.stringify(result);
    } finally {
      await client.close();
    }
  };
  expect(
    await call(token, "sym_ask_owner", { job: `J-${victim.id}`, question: "Injected" }),
  ).toContain("cannot update that job");
  expect(
    await call(token, "sym_post_progress", { job: `J-${victim.id}`, summary: "Injected" }),
  ).toContain("cannot update that job");
  expect(
    await call("fake-shared-read-token", "sym_post_progress", { job: ref, summary: "Injected" }),
  ).toContain("job-scoped");
  expect(await call("fake-shared-read-token", "jobs_status", {})).toContain("Victim job");
  expect((await getJob(h.sql, victim.id))?.lastSummary).toBeNull();
  expect(
    (await pendingPosts(h.sql)).some(
      (p) => (p.payload as { channel?: string }).channel === "CPRIVATE",
    ),
  ).toBe(false);
  expect(await call(token, "sym_post_progress", { job: ref, summary: "Own progress" })).toContain(
    "Progress recorded",
  );
  expect(await call(token, "sym_ask_owner", { job: ref, question: "Own question" })).toContain(
    "Question posted",
  );
  expect(
    h.slack
      .callsTo("chat.postMessage")
      .some((post) => String(post.body.text).includes("Own question")),
  ).toBe(true);
  await updateJob(h.sql, job.id, { status: "done" });
  const worker = await connectT3({ url: h.t3.url, getToken: async () => h.t3.token });
  try {
    const follow = await startFollowUp(
      {
        sql: h.sql,
        worker: t3Adapter(worker.call),
        allowedProjects: [{ name: "test-repo", workerProject: "test-repo" }],
        workerIdentity: workerIdentity("default", h.t3.url),
      },
      ref,
      "Fix callback scope",
      "UOWNER",
      "scope-fix",
    );
    expect(follow.job).toBeDefined();
    const send = h.t3.calls.findLast((item) => item.name === "t3_thread_send");
    const next = /Authorization: Bearer (symjob_[a-f0-9]{64})/.exec(
      JSON.stringify(send?.args),
    )?.[1];
    expect(next).toBeDefined();
    expect(next).not.toBe(token);
    if (!next || !follow.job) throw new Error("Fix did not provision a new job credential.");
    expect(
      await call(next, "sym_post_progress", { job: `J-${follow.job.id}`, summary: "Fix progress" }),
    ).toContain("Progress recorded");
  } finally {
    await worker.close();
  }
});
