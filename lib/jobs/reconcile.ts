import { chooseDisplay } from "../display.ts";
import { getJob, type Job, jobRef, orphanedJobs, updateJob } from "../ledger/jobs.ts";
import { dropPost, enqueuePost, latestPost } from "../ledger/outbox.ts";
import type { WorkerAdapter } from "../workers/types.ts";
import { parseOutputContract } from "./contract.ts";
import { checkPrWakes, ensurePrWatched, jobsToWatch, watchedPrJobs } from "./pr-wakes.ts";
import { presentEnd } from "./present.ts";
import { checkJob, finishJob, type JobDeps, type LedgerDeps } from "./run.ts";

// The safety net (docs/architecture.md, "Proactive updates"). Every few minutes it takes over
// the jobs no t3_job task watches, for example after a session died or Sym restarted, and runs
// the same check a task runs. The job then finishes with its card and result message as usual.
// Reconcile has no workflow body to run the `verifier` subagent, so it finishes a job with the
// rule checks alone (decision 032). That covers a job found in `checking` whose task stopped.

// One reconcile check blocks this long on the worker, so a pass over many jobs stays short.
const RECONCILE_WAIT_MS = 5_000;

export interface ReconcileReport {
  checked: number;
  finished: number;
  offline: number;
}

export async function reconcileJobs(deps: JobDeps): Promise<ReconcileReport> {
  const report: ReconcileReport = { checked: 0, finished: 0, offline: 0 };
  for (const job of await orphanedJobs(deps.sql)) {
    try {
      if (job.status === "checking") {
        await finishJob(deps, job.id);
        report.checked++;
        report.finished++;
        continue;
      }
      // For a job coming back from an outage, hold delivery until the outage notice is dropped
      // or edited, so a notice that never went out does not go out late.
      const { slack: _held, ...holdDelivery } = deps;
      const offline = job.status === "worker_offline";
      const check = await checkJob(offline ? holdDelivery : deps, job.id, RECONCILE_WAIT_MS);
      report.checked++;
      if (offline) await markBack(deps, job);
      if (check.terminal) report.finished++;
      // No task is here to turn a question into buttons, so tell the thread once per question.
      for (const question of check.questions) {
        await postQuestion(deps, job, question.requestId, question.questions[0]?.prompt ?? "");
      }
    } catch {
      report.offline++;
      await markOffline(deps, job);
    }
  }
  await followPullRequests(deps);
  await presentMissingEnds(deps);
  return report;
}

// A crash between a job's terminal status and its end post would lose the result message, and
// reconcile no longer looks at finished jobs. So it re-presents recent ended jobs whose end post
// was never queued. presentEnd is idempotent (one `J-n:end` key) and stays silent where it
// should, such as a clean scheduled check.
async function presentMissingEnds(deps: JobDeps): Promise<void> {
  const rows = await deps.sql<{ id: number }[]>`
    select j.id from jobs j
    where j.status in ('done', 'failed', 'cancelled')
      and j.worker_thread_id is not null and j.slack_channel is not null
      and j.finished_at >= now() - interval '1 day'
      and not exists (
        select 1 from outbox o where o.idempotency_key = 'J-' || j.id || ':end'
      )
    order by j.id limit 20
  `;
  for (const row of rows) {
    const job = await getJob(deps.sql, Number(row.id));
    if (!job) continue;
    await presentEnd(deps.sql, job, parseOutputContract(job.lastMessage), new Date(), deps.pack);
  }
}

// Runs `fn` with a worker connection, like `withJobDeps` in lib/runtime.ts.
export type WithWorker = <T>(fn: (deps: JobDeps) => Promise<T>) => Promise<T>;

export const WORKER_NOT_CONFIGURED =
  "Reconcile skipped the worker pass: Sym has no worker URL and token. Ask Sym to sign in to " +
  "the worker, or set T3_MCP_URL and T3_TOKEN.";

// One reconcile pass over the worker. No worker configured at all is a setup gap, not an
// outage: the pass logs one warning and leaves the jobs as they are (decision 036). Pass no
// `withWorker` for that case. A connection that fails is an outage: every orphaned job goes
// offline, once.
export async function reconcileWorkerPass(
  deps: LedgerDeps,
  withWorker: WithWorker | undefined,
  warn: (message: string) => void = console.warn,
): Promise<ReconcileReport | "not_configured"> {
  if (!withWorker) {
    warn(WORKER_NOT_CONFIGURED);
    return "not_configured";
  }
  try {
    return await withWorker(reconcileJobs);
  } catch (error) {
    // The sign-in went away between the check and the connection.
    if (error instanceof Error && error.name === "WorkerNotConfiguredError") {
      warn(WORKER_NOT_CONFIGURED);
      return "not_configured";
    }
    return reconcileJobs({ ...deps, worker: unreachableWorker });
  }
}

const unreachable = async (): Promise<never> => {
  throw new Error("The worker is unreachable.");
};

const unreachableWorker: WorkerAdapter = {
  capabilities: unreachable,
  projects: unreachable,
  findByTitle: unreachable,
  launch: unreachable,
  wait: unreachable,
  readActivity: unreachable,
  interrupt: unreachable,
  pendingQuestions: unreachable,
  answer: unreachable,
  send: unreachable,
};

// A PR outlives its job: the worker watches it and fixes CI failures and review comments, and
// reconcile reports each wake in the job thread (docs/architecture.md, flow 4 step 5). A failed
// worker call here waits for the next pass.
const PR_FOLLOW_DAYS = 7;

async function followPullRequests(deps: JobDeps): Promise<void> {
  const since = new Date(Date.now() - PR_FOLLOW_DAYS * 86_400_000);
  for (const job of await jobsToWatch(deps, since)) {
    await ensurePrWatched(deps, job).catch(() => "failed");
  }
  for (const job of await watchedPrJobs(deps, since)) {
    await checkPrWakes(deps, job).catch(() => 0);
  }
}

async function postQuestion(deps: JobDeps, job: Job, requestId: string, prompt: string) {
  if (!job.slackChannel) return;
  const ref = jobRef(job.id);
  const text = `${ref} has a question on the worker: ${prompt}\nAnswer it in the worker thread ${job.workerThreadId}.`;
  await enqueuePost(deps.sql, {
    idempotencyKey: `${ref}:question:${requestId}`,
    jobId: job.id,
    method: "chat.postMessage",
    payload: {
      channel: job.slackChannel,
      ...(job.slackThreadTs ? { thread_ts: job.slackThreadTs } : {}),
      text,
    },
    display: chooseDisplay({
      kind: job.kind,
      needsAction: true,
      isNew: true,
      estMinutes: 0,
      steps: 0,
      lines: 2,
      surface: "channel",
      quiet: false,
    }),
  });
}

// The worker did not answer. Post once when a job goes offline; the next good check moves it
// back to running.
async function markOffline(deps: JobDeps, job: Job) {
  if (job.status === "worker_offline") return;
  await updateJob(deps.sql, job.id, {
    status: "worker_offline",
    lastSummary: "The worker is unreachable",
  });
  await notice(
    deps,
    job,
    `offline:${job.cursor ?? "start"}`,
    `${jobRef(job.id)}: the worker is unreachable. Sym keeps checking and posts when it is back.`,
  );
}

// The outage notice turns into a silent edit when the worker is back (docs/mockups: "one post,
// edited later"). A notice that never went out is dropped instead.
async function markBack(deps: JobDeps, job: Job) {
  const ref = jobRef(job.id);
  const outage = await latestPost(deps.sql, job.id, `${ref}:offline:`);
  if (!outage) return;
  if (outage.status === "pending") {
    await dropPost(deps.sql, outage.id, "The worker came back before the notice went out");
    return;
  }
  if (outage.status !== "sent" || !outage.slackTs || !job.slackChannel) return;
  await enqueuePost(deps.sql, {
    idempotencyKey: `${ref}:back:${outage.slackTs}`,
    jobId: job.id,
    method: "chat.update",
    payload: {
      channel: job.slackChannel,
      ts: outage.slackTs,
      text: `~${ref}: the worker was unreachable.~ The worker is back, and ${ref} continues.`,
    },
    display: outage.display,
  });
}

async function notice(deps: JobDeps, job: Job, key: string, text: string) {
  if (!job.slackChannel) return;
  await enqueuePost(deps.sql, {
    idempotencyKey: `${jobRef(job.id)}:${key}`,
    jobId: job.id,
    method: "chat.postMessage",
    payload: {
      channel: job.slackChannel,
      ...(job.slackThreadTs ? { thread_ts: job.slackThreadTs } : {}),
      text,
    },
    display: chooseDisplay({
      kind: job.kind,
      needsAction: false,
      isNew: true,
      // Outages post even in quiet mode, like failures (docs/architecture.md).
      failed: true,
      estMinutes: 0,
      steps: 0,
      lines: 1,
      surface: "channel",
      quiet: false,
    }),
  });
}
