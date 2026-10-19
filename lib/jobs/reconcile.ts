import { chooseDisplay } from "../display.ts";
import { type Job, jobRef, orphanedJobs, updateJob } from "../ledger/jobs.ts";
import { dropPost, enqueuePost, latestPost } from "../ledger/outbox.ts";
import { checkJob, type JobDeps } from "./run.ts";

// The safety net (docs/architecture.md, "Proactive updates"). Every few minutes it takes over
// the jobs no t3_job task watches, for example after a session died or Sym restarted, and runs
// the same check a task runs. The job then finishes with its card and result message as usual.

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
  return report;
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
