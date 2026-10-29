import { getJobByRef, type Job, type JobStatus, jobRef } from "../ledger/jobs.ts";
import { workerNoun } from "../worker-label.ts";
import { formatDuration } from "./card.ts";

// Answers to "what's the update?" (docs/architecture.md, flow 5): two or three lines for one job,
// one line per job for a list. Plain text, so Slack, the eve channel, and slash commands share it.

function waitingOn(): Partial<Record<JobStatus, string>> {
  const noun = workerNoun();
  return {
    launching: "Waiting for Start on the brief.",
    waiting_input: `Waiting for your answer to the ${noun}'s question.`,
    waiting_permission: `Waiting for a permission prompt on the ${noun}. Approve it in the ${noun}.`,
    worker_offline: `Waiting for the ${noun} to come back.`,
    quiet: `I haven't heard from the ${noun}. I'm still checking.`,
  };
}

export const statusWords = (): Record<JobStatus, string> => ({
  launching: "not started",
  running: "running",
  waiting_input: "waiting for you",
  waiting_permission: "blocked on a permission prompt",
  quiet: "quiet",
  worker_offline: `${workerNoun()} offline`,
  checking: "checking the result",
  done: "done",
  failed: "failed",
  cancelled: "cancelled",
});

export const STATUS_EMOJI: Record<JobStatus, string> = {
  launching: "⏳",
  running: "🔄",
  waiting_input: "🙋",
  waiting_permission: "🔒",
  quiet: "💤",
  worker_offline: "🔌",
  checking: "🔍",
  done: "✅",
  failed: "❌",
  cancelled: "🚫",
};

export function jobAnswer(job: Job, now: Date): string {
  const lines = [`${jobRef(job.id)} ${job.title}: ${statusWords()[job.status]} ${age(job, now)}.`];
  if (job.lastSummary && job.status !== "checking") lines.push(job.lastSummary);
  const waiting = waitingOn()[job.status];
  if (waiting) lines.push(waiting);
  if (job.prUrl) lines.push(job.prUrl);
  if (job.closedAt)
    lines.push(
      !job.workerSettledAt
        ? "I stopped following the PR. The worker thread still needs to be settled."
        : job.codeChannel && job.archiveState !== "archived"
          ? "I stopped following the PR. The channel still needs to be archived."
          : "I've closed this job.",
    );
  if (job.archiveState === "repair")
    lines.push("The saved channel or Slack connection needs repair.");
  return lines.join("\n");
}

export function jobListAnswer(jobs: Job[], now: Date): string {
  if (jobs.length === 0) return "no active jobs, and none finished today.";
  return jobs
    .map((job) => {
      const summary = job.lastSummary ? ` · ${job.lastSummary}` : "";
      return `${jobRef(job.id)} ${job.title}: ${statusWords()[job.status]} ${age(job, now)}${summary}`;
    })
    .join("\n");
}

// "for 14m" while a job runs, "14m ago" once it ended.
function age(job: Job, now: Date): string {
  if (job.finishedAt) return `${formatDuration(now.getTime() - job.finishedAt.getTime())} ago`;
  const since = job.startedAt ?? job.createdAt;
  return `for ${formatDuration(now.getTime() - since.getTime())}`;
}

// A failed refresh must remain separate from the saved ledger facts. The brain can report the
// last known state without presenting it as a fresh worker read.
export async function freshJobStatus(
  sql: import("../db.ts").Sql,
  ref: string,
  now: Date,
  refresh: (jobId: number) => Promise<unknown>,
) {
  const before = await getJobByRef(sql, ref);
  if (!before) return null;
  const active =
    !["done", "failed", "cancelled", "checking"].includes(before.status) &&
    Boolean(before.workerThreadId);
  let freshRead: "ok" | "failed" | "not_needed" = "not_needed";
  if (active) {
    try {
      await refresh(before.id);
      freshRead = "ok";
    } catch {
      freshRead = "failed";
    }
  }
  const job = (await getJobByRef(sql, ref)) ?? before;
  return {
    job: jobRef(job.id),
    ledgerStatus: job.status,
    updatedAt: job.updatedAt.toISOString(),
    freshRead,
    answer: `${freshRead === "failed" ? "I couldn't refresh the worker. This is the last saved update.\n" : ""}${jobAnswer(job, now)}`,
    brief: job.brief,
    archiveState: job.archiveState,
    archiveError: job.archiveError,
  };
}
