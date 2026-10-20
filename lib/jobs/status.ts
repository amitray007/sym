import { type Job, type JobStatus, jobRef } from "../ledger/jobs.ts";
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
    quiet: `No new ${noun} activity for a while.`,
  };
}

const statusWords = (): Record<JobStatus, string> => ({
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

export function jobAnswer(job: Job, now: Date): string {
  const lines = [`${jobRef(job.id)} ${job.title}: ${statusWords()[job.status]} ${age(job, now)}.`];
  if (job.lastSummary) lines.push(`Last: ${job.lastSummary}`);
  const waiting = waitingOn()[job.status];
  if (waiting) lines.push(waiting);
  if (job.workerModel) lines.push(`Model: ${job.workerModel}`);
  if (job.prUrl) lines.push(`PR: ${job.prUrl}`);
  return lines.join("\n");
}

export function jobListAnswer(jobs: Job[], now: Date): string {
  if (jobs.length === 0) return "No active jobs, and none finished today.";
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
