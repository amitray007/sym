import type { Sql } from "../db.ts";
import { getJobByRef, type Job } from "../ledger/jobs.ts";
import { getSessionThread } from "../ledger/threads.ts";

// Shared by Home, owner notices, status lists, and learning evidence.
export type NamedJob = Pick<Job, "title"> &
  Partial<Pick<Job, "slackChannel" | "slackThreadTs" | "codeChannel">>;

export function threadLink(job: Omit<NamedJob, "title">): string | undefined {
  if (job.codeChannel && job.slackChannel) {
    return `https://slack.com/app_redirect?channel=${encodeURIComponent(job.slackChannel)}`;
  }
  if (!job.slackChannel || !job.slackThreadTs) return undefined;
  return `https://slack.com/app_redirect?channel=${encodeURIComponent(job.slackChannel)}&message_ts=${encodeURIComponent(job.slackThreadTs)}`;
}

export function jobName(job: NamedJob): string {
  const title = job.title.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const url = threadLink(job);
  return url ? `<${url}|${title.replace(/\|/g, "/")}>` : title;
}

// Lowercase a plain first word; keep acronyms such as API and mixed-case names such as iOS.
export function sentenceTitle(title: string): string {
  return /^[A-Z][a-z]+(?:\b|$)/.test(title)
    ? title.charAt(0).toLowerCase() + title.slice(1)
    : title;
}

// Tool answers can be relayed in another conversation. Identify the work there.
export async function jobReply(
  sql: Sql,
  ref: string,
  sessionId: string,
  answer: string,
): Promise<string> {
  const job = await getJobByRef(sql, ref);
  if (!job) return answer;
  const conversation = await getSessionThread(sql, sessionId);
  const own =
    conversation?.channelId === job.slackChannel &&
    (job.codeChannel || conversation?.threadTs === job.slackThreadTs);
  return own ? answer : `${jobName(job)}: ${answer}`;
}
