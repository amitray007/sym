import { type Job, type JobStatus, jobRef } from "../ledger/jobs.ts";
import { formatDuration } from "./card.ts";

// Answers to "what's the update?" (docs/architecture.md, flow 5): two or three lines for one job,
// one line per job for a list. Plain text, so Slack, the eve channel, and slash commands share it.

const WAITING_ON: Partial<Record<JobStatus, string>> = {
  launching: "Waiting for Start on the brief.",
  waiting_input: "Waiting for your answer to the worker's question.",
  waiting_permission: "Waiting for a permission prompt on the worker. Approve it in T3.",
  worker_offline: "Waiting for the worker to come back.",
  quiet: "No new worker activity for a while.",
};

const STATUS_WORD: Record<JobStatus, string> = {
  launching: "not started",
  running: "running",
  waiting_input: "waiting for you",
  waiting_permission: "blocked on a permission prompt",
  quiet: "quiet",
  worker_offline: "worker offline",
  checking: "checking the result",
  done: "done",
  failed: "failed",
  cancelled: "cancelled",
};

export function jobAnswer(job: Job, now: Date): string {
  const lines = [`${jobRef(job.id)} ${job.title}: ${STATUS_WORD[job.status]} ${age(job, now)}.`];
  if (job.lastSummary) lines.push(`Last: ${job.lastSummary}`);
  const waiting = WAITING_ON[job.status];
  if (waiting) lines.push(waiting);
  if (job.prUrl) lines.push(`PR: ${job.prUrl}`);
  return lines.join("\n");
}

export function jobListAnswer(jobs: Job[], now: Date): string {
  if (jobs.length === 0) return "No active jobs, and none finished today.";
  return jobs
    .map((job) => {
      const summary = job.lastSummary ? ` · ${job.lastSummary}` : "";
      return `${jobRef(job.id)} ${job.title}: ${STATUS_WORD[job.status]} ${age(job, now)}${summary}`;
    })
    .join("\n");
}

// "for 14m" while a job runs, "14m ago" once it ended.
function age(job: Job, now: Date): string {
  if (job.finishedAt) return `${formatDuration(now.getTime() - job.finishedAt.getTime())} ago`;
  const since = job.startedAt ?? job.createdAt;
  return `for ${formatDuration(now.getTime() - since.getTime())}`;
}
