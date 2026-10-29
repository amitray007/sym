import { chooseDisplay } from "../display.ts";
import { getJob, type Job, jobRef, orphanedJobs, updateJob } from "../ledger/jobs.ts";
import { dropPost, enqueuePost, latestPost } from "../ledger/outbox.ts";
import { moveToCodeChannel, setChannelStatus } from "../slack/code-channel.ts";
import { isSlackUserAllowed } from "../slack/guard.ts";
import { retryFollowupProposals } from "../slack/job-actions.ts";
import { workerNoun } from "../worker-label.ts";
import type { WorkerAdapter } from "../workers/types.ts";
import { callbackFor } from "./callback.ts";
import { parseOutputContract } from "./contract.ts";
import { retryClosures } from "./followup.ts";
import {
  checkPrWakes,
  ensurePrWatched,
  jobsToWatch,
  prFollowEnabled,
  watchedPrJobs,
} from "./pr-wakes.ts";
import { presentEnd, presentProgress } from "./present.ts";
import {
  checkJob,
  closeUnlaunched,
  deliverNow,
  finishJob,
  type JobDeps,
  JobSetupError,
  type LedgerDeps,
  launchOrAdopt,
} from "./run.ts";
import type { ModelCheck } from "./verify.ts";

// The safety net (docs/architecture.md, "Proactive updates"). Every few minutes it takes over
// the jobs no worker_job task watches, for example after a session died or Sym restarted, and runs
// the same check a task runs. The job then finishes with its card and result message as usual.
// Reconcile has no workflow body to run the `verifier` subagent, so it finishes a job with the
// rule checks alone (decision 032). That covers a job found in `checking` whose task stopped.

// One reconcile check blocks this long on the worker, so a pass over many jobs stays short.
const RECONCILE_WAIT_MS = 5_000;
// Reconcile runs every 3 minutes. Its watch ends before the next pass, so a job only reconcile
// drives, such as a follow-up (decision 056), is checked on every pass.
const RECONCILE_LEASE_MS = 2 * 60_000;

export interface ReconcileReport {
  checked: number;
  finished: number;
  offline: number;
}

export async function reconcileJobs(deps: JobDeps): Promise<ReconcileReport> {
  await recoverAcceptedStarts(deps);
  await retryClosures(deps);
  await retryFollowupProposals(deps);
  const report: ReconcileReport = { checked: 0, finished: 0, offline: 0 };
  for (const job of await orphanedJobs(deps.sql)) {
    try {
      if (job.status === "checking") {
        await finishJob(deps, job.id);
        report.checked++;
        report.finished++;
        await settleChannel(deps, job);
        continue;
      }
      // For a job coming back from an outage, hold delivery until the outage notice is dropped
      // or edited, so a notice that never went out does not go out late.
      const { slack: _held, ...holdDelivery } = deps;
      const offline = job.status === "worker_offline";
      const check = await checkJob(offline ? holdDelivery : deps, job.id, RECONCILE_WAIT_MS, {
        leaseMs: RECONCILE_LEASE_MS,
      });
      report.checked++;
      if (offline) await markBack(deps, job);
      if (check.terminal) {
        report.finished++;
        await settleChannel(deps, job);
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

// An accepted Start can outlive its Eve task before the worker exists. Keep the callback and
// approval in the ledger, then use the same launch lock and title adoption as a live task.
async function recoverAcceptedStarts(deps: JobDeps): Promise<void> {
  await deps.sql`update job_proposals set status = 'expired'
    where status = 'pending' and expires_at <= now()`;
  await deps.sql`update jobs set status = 'cancelled', finished_at = coalesce(finished_at, now())
    where status = 'launching' and worker_thread_id is null and (
      select p.status from job_proposals p where p.job_id = jobs.id and p.kind = 'start'
      order by p.id desc limit 1
    ) in ('dismissed', 'expired')`;
  const rows = await deps.sql<{ id: number; decidedBy: string; callbackUrl: string }[]>`
    select j.id, p.decided_by, c.callback_url from jobs j
    join job_proposals p on p.job_id = j.id and p.kind = 'start' and p.status = 'approved'
    join job_start_callbacks c on c.job_id = j.id
    where j.worker_thread_id is null and j.status = 'launching' and j.closed_at is null
      and j.brief = p.payload and p.created_at < now() - interval '1 minute'
    order by j.id limit 20
  `;
  for (const row of rows) {
    if (!isSlackUserAllowed(deps.pack, process.env.SYM_SLACK_USERS, row.decidedBy)) continue;
    try {
      const job = await getJob(deps.sql, Number(row.id));
      if (!job) continue;
      await moveToCodeChannel(deps, job);
      await launchOrAdopt(deps, job.id, callbackFor(row.callbackUrl, process.env.SYM_CALLBACK_URL));
      await deps.sql`update jobs set watch_until = now() + interval '2 minutes' where id = ${job.id}`;
    } catch (error) {
      if (!(error instanceof JobSetupError)) continue;
      await closeUnlaunched(deps, Number(row.id), error.message);
      await enqueuePost(deps.sql, {
        idempotencyKey: `${jobRef(Number(row.id))}:start-refused`,
        jobId: Number(row.id),
        method: "chat.postMessage",
        payload: {
          channel: row.decidedBy,
          text: `I couldn't start ${jobRef(Number(row.id))}: ${error.message}`,
        },
        display: chooseDisplay({
          kind: "conversation",
          needsAction: true,
          isNew: true,
          estMinutes: 0,
          steps: 0,
          lines: 1,
          surface: "dm",
          quiet: false,
        }),
      });
      await deliverNow(deps);
    }
  }
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
      and j.end_presented_at is null
    order by j.id limit 20
  `;
  for (const row of rows) {
    const job = await getJob(deps.sql, Number(row.id));
    if (!job) continue;
    const verdict = job.verdict ? (job.verdict as ModelCheck) : undefined;
    await presentEnd(
      deps.sql,
      job,
      parseOutputContract(job.lastMessage),
      new Date(),
      deps.pack,
      verdict,
    );
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
    await retryClosures({ ...deps, worker: unreachableWorker });
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
// worker call here waits for the next pass. Off unless SYM_PR_FOLLOW=on (decision 054).
const PR_FOLLOW_DAYS = 7;

async function followPullRequests(deps: JobDeps): Promise<void> {
  if (!prFollowEnabled()) return;
  const since = new Date(Date.now() - PR_FOLLOW_DAYS * 86_400_000);
  for (const job of await jobsToWatch(deps, since)) {
    await ensurePrWatched(deps, job).catch(() => "failed");
  }
  for (const job of await watchedPrJobs(deps, since)) {
    await checkPrWakes(deps, job).catch(() => 0);
  }
}

// A job reconcile finished, such as a follow-up or one whose session died, sets its code channel
// back to active (decision 067). No-op for a job in a thread.
async function settleChannel(deps: JobDeps, job: Job): Promise<void> {
  if (job.codeChannel) await setChannelStatus(deps, job, "active");
}

// The worker did not answer. Post once when a job goes offline; the next good check moves it
// back to running.
async function markOffline(deps: JobDeps, job: Job) {
  if (job.status === "worker_offline") return;
  const offline = await updateJob(deps.sql, job.id, {
    status: "worker_offline",
    lastSummary: `I can't reach the ${workerNoun()}. I'll keep checking.`,
  });
  await presentProgress(deps.sql, offline, [], "offline", deps.now?.() ?? new Date(), deps.pack);
}

// The outage notice turns into a silent edit when the worker is back (docs/mockups: "one post,
// edited later"). A notice that never went out is dropped instead.
async function markBack(deps: JobDeps, job: Job) {
  const ref = jobRef(job.id);
  const current = await getJob(deps.sql, job.id);
  const state = current?.status ?? job.status;
  const outage = await latestPost(deps.sql, job.id, `${ref}:offline:`);
  if (!outage) return;
  if (outage.status === "pending") {
    await dropPost(deps.sql, outage.id, `The ${workerNoun()} came back before the notice went out`);
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
      text: `The ${workerNoun()} is back. I checked ${ref}: ${state}.`,
    },
    display: outage.display,
  });
}
