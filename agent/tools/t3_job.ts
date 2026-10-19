import { defineWorkflowTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { createWebhook, FatalError, sleep } from "workflow";
import { Brief } from "../../lib/jobs/brief.ts";
import { cancelJob, checkJob, failJob, launchOrAdopt, statusLine } from "../../lib/jobs/run.ts";
import { createJob, jobRef } from "../../lib/ledger/jobs.ts";
import { withJobDeps, withLedger } from "../../lib/runtime.ts";

// One worker job from launch to result (docs/architecture.md, flows 1 and 3, decision 017). It
// runs as a task, so the conversation stays open while the worker runs.

// Polling fallback when the worker's callback does not arrive.
const POLL = "4m";
// After the callback, check again soon in case the worker posted before its run ended.
const POLL_AFTER_CALLBACK = "30s";
// How long one check blocks on the worker. The adapter gives the MCP request a margin on top.
const WAIT_MS = 60_000;

export default defineWorkflowTool({
  description:
    "Hand a coding task to a worker agent in a new worktree of a project the worker knows. " +
    "Runs as a task: you get a receipt now and the result later. Write a complete brief.",
  inputSchema: Brief,
  // A worker job can write code, so it needs approval until the owner promotes the job class.
  approval: always(),
  label: {
    start: (brief) => `Start worker job: ${brief.title}`,
    delta: (_brief, progress: { status: string }) => progress.status,
  },
  async *task(brief, ctx) {
    "use workflow";
    const job = await recordJob(brief, ctx.callId, ctx.session.id);
    const ref = jobRef(job.id);

    // A body parked on a sleep or a webhook does not see the abort, so every wait races it.
    const stopped = new Promise<"stopped">((resolve) => {
      if (ctx.abortSignal.aborted) resolve("stopped");
      ctx.abortSignal.addEventListener("abort", () => resolve("stopped"), { once: true });
    });

    try {
      yield { status: statusLine(ref, "Launching worker thread") };
      const callback = createWebhook();
      const threadId = await launch(job.id, callback.url);
      yield { status: statusLine(ref, "Worker thread started") };

      let calledBack = false;
      for (;;) {
        const timer = sleep(calledBack ? POLL_AFTER_CALLBACK : POLL).then(() => "timer" as const);
        const woke = await Promise.race([
          timer,
          stopped,
          ...(calledBack ? [] : [callback.then(() => "callback" as const)]),
        ]);
        if (woke === "stopped") {
          await cancel(job.id);
          return { job: ref, status: "cancelled", threadId };
        }
        if (woke === "callback") calledBack = true;

        const result = await check(job.id);
        yield { status: statusLine(ref, result.summary) };
        if (result.terminal) {
          return {
            job: ref,
            status: result.status,
            threadId,
            summary: result.summary,
            lastMessage: result.lastMessage,
          };
        }
      }
    } catch (error) {
      // A failed task must not leave the job looking like it still runs.
      await markFailed(job.id, error instanceof Error ? error.message : String(error));
      throw error;
    }
  },
});

async function recordJob(brief: Brief, callId: string, sessionId: string) {
  "use step";
  const job = await withLedger((sql) =>
    createJob(sql, {
      requestKey: callId,
      sessionId,
      kind: "code-change",
      title: brief.title,
      brief,
      worker: "t3",
    }),
  );
  return { id: job.id };
}

async function launch(jobId: number, callbackUrl: string): Promise<string> {
  "use step";
  try {
    const job = await withJobDeps((deps) => launchOrAdopt(deps, jobId, callbackUrl));
    if (!job.workerThreadId) throw new Error(`${jobRef(jobId)} has no worker thread`);
    return job.workerThreadId;
  } catch (error) {
    // An unknown project or worker model cannot succeed on retry.
    if (error instanceof Error && error.name === "JobSetupError") {
      throw new FatalError(error.message);
    }
    throw error;
  }
}

async function check(jobId: number) {
  "use step";
  return withJobDeps((deps) => checkJob(deps, jobId, WAIT_MS));
}

async function cancel(jobId: number) {
  "use step";
  await withJobDeps((deps) => cancelJob(deps, jobId));
}

async function markFailed(jobId: number, reason: string) {
  "use step";
  await withLedger((sql) => failJob(sql, jobId, reason));
}
