import { chooseDisplay } from "../display.ts";
import { getJob, type Job, jobRef } from "../ledger/jobs.ts";
import { enqueuePost } from "../ledger/outbox.ts";
import { workerNoun } from "../worker-label.ts";
import type { Activity, ActivityItem } from "../workers/types.ts";
import type { JobDeps } from "./run.ts";

// Pull request wakes (docs/architecture.md, flow 4 step 5 and "Proactive updates"). When a job
// opens a PR, Sym asks the worker to watch it. The worker agent then fixes CI failures and
// answers review comments. Reconcile reports each wake in the job thread.
//
// T3 puts a wake in the worker thread as a `notification` item whose text is the wake summary,
// for example `#12: checks failed, new comments` (T3 orchestration-v2/pullRequestWatch.ts). The
// full wake text goes to the worker agent only.

// Pages of thread activity one wake check reads.
const MAX_PAGES = 5;

export type WatchOutcome = "watching" | "already" | "unwatchable" | "skipped" | "failed";

// T3 refuses a watch on a merged pull request and on a subagent thread. Retrying cannot help.
const UNWATCHABLE = /nothing to watch|not open|\bmerged\b|\bclosed\b|subagent/i;

// Asks the worker to watch the job's PR, once per PR URL. Safe to call on every pass. Returns
// "failed" for a worker error, so the next pass tries again.
export async function ensurePrWatched(
  deps: Pick<JobDeps, "sql" | "worker">,
  job: Pick<Job, "id" | "prUrl" | "workerThreadId">,
): Promise<WatchOutcome> {
  const { prUrl, workerThreadId } = job;
  if (!prUrl || !workerThreadId || !deps.worker.watchPullRequest) return "skipped";
  const [row] = await deps.sql<{ watched: string | null }[]>`
    select pr_watched_url as watched from jobs where id = ${job.id}
  `;
  if (row?.watched === prUrl) return "already";

  let outcome: WatchOutcome = "watching";
  try {
    const result = await deps.worker.watchPullRequest(
      workerThreadId,
      prUrl,
      `${jobRef(job.id)}:watch`,
    );
    if (!result.watching) outcome = "unwatchable";
    else if (result.alreadyWatching) outcome = "already";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!UNWATCHABLE.test(message)) return "failed";
    outcome = "unwatchable";
  }
  await deps.sql`update jobs set pr_watched_url = ${prUrl} where id = ${job.id}`;
  return outcome;
}

export interface Wake {
  number: number;
  // The wake summary after the PR number, for example `checks failed, new comments`.
  summary: string;
}

// Returns the wake an activity item reports, or nothing for any other item.
export function wakeOf(item: ActivityItem): Wake | undefined {
  if (item.type !== "notification") return undefined;
  const match = /^#(\d+): (.+)$/s.exec(item.text.trim());
  if (!match?.[1] || !match[2]) return undefined;
  return { number: Number(match[1]), summary: match[2].split("\n")[0]?.trim() ?? "" };
}

export function wakeText(job: Pick<Job, "id" | "prUrl">, wake: Wake): string {
  const pr = job.prUrl ? `<${job.prUrl}|PR #${wake.number}>` : `PR #${wake.number}`;
  const ref = jobRef(job.id);
  if (/stopped watching/.test(wake.summary)) {
    return `${ref}: ${pr} is no longer watched (${wake.summary}). Check it yourself.`;
  }
  const acting = /checks failed|merge conflict|new comments/.test(wake.summary);
  return `${ref}: ${pr}: ${wake.summary}.${acting ? ` The ${workerNoun()} is looking into it.` : ""}`;
}

// Posts one short message per wake in the activity, in the job thread. The key holds the item
// position, so reading the same items again posts nothing. Returns how many wakes it queued.
export async function reportWakes(
  deps: Pick<JobDeps, "sql" | "slack">,
  job: Job,
  activity: Pick<Activity, "items">,
): Promise<number> {
  if (!job.slackChannel) return 0;
  let queued = 0;
  for (const item of activity.items) {
    const wake = wakeOf(item);
    if (!wake) continue;
    const stopped = /stopped watching/.test(wake.summary);
    const failed = /checks failed|merge conflict/.test(wake.summary);
    await enqueuePost(deps.sql, {
      idempotencyKey: `${jobRef(job.id)}:prwake:${item.position}`,
      jobId: job.id,
      method: "chat.postMessage",
      payload: {
        channel: job.slackChannel,
        ...(job.slackThreadTs ? { thread_ts: job.slackThreadTs } : {}),
        text: wakeText(job, wake),
      },
      display: chooseDisplay({
        kind: job.kind,
        needsAction: stopped,
        isNew: true,
        failed,
        estMinutes: 0,
        steps: 0,
        lines: 1,
        surface: "channel",
        quiet: false,
      }),
    });
    queued++;
  }
  return queued;
}

// Reads the worker thread for new wakes since the last check and reports them. Only for a job
// whose PR the worker watches. The job's own cursor stays as it is. Returns the wakes queued.
export async function checkPrWakes(
  deps: Pick<JobDeps, "sql" | "worker" | "slack">,
  job: Job,
): Promise<number> {
  if (!job.workerThreadId || !job.prUrl) return 0;
  const [row] = await deps.sql<{ watched: string | null; cursor: string | null }[]>`
    select pr_watched_url as watched, pr_wake_cursor as cursor from jobs where id = ${job.id}
  `;
  if (!row?.watched) return 0;

  let cursor = row.cursor ?? job.cursor;
  let queued = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const activity = await deps.worker.readActivity(job.workerThreadId, cursor);
    queued += await reportWakes(deps, job, activity);
    cursor = activity.cursor;
    // Save after each page, so a failed read later does not repeat the earlier pages.
    await deps.sql`update jobs set pr_wake_cursor = ${cursor} where id = ${job.id}`;
    if (!activity.hasMore) break;
  }
  return queued;
}

// Finished jobs with a PR the worker does not watch yet (docs/architecture.md, flow 4 step 5).
export async function jobsToWatch(deps: Pick<JobDeps, "sql">, since: Date, limit = 20) {
  const rows = await deps.sql<{ id: number }[]>`
    select id from jobs
    where status = 'done' and pr_url is not null and pr_watched_url is distinct from pr_url
      and finished_at >= ${since}
    order by id desc limit ${limit}
  `;
  const jobs: Job[] = [];
  for (const row of rows) {
    const job = await getJob(deps.sql, row.id);
    if (job) jobs.push(job);
  }
  return jobs;
}

// Jobs whose PR the worker watches and that ended after `since` or still run. Reconcile checks
// these for wakes. A PR can wake the worker long after the job ends, so pick a window such as
// 7 days.
export async function watchedPrJobs(
  deps: Pick<JobDeps, "sql">,
  since: Date,
  limit = 20,
): Promise<Job[]> {
  const rows = await deps.sql<{ id: number }[]>`
    select id from jobs
    where pr_watched_url is not null and (finished_at is null or finished_at >= ${since})
    order by id desc limit ${limit}
  `;
  const jobs: Job[] = [];
  for (const row of rows) {
    const job = await getJob(deps.sql, row.id);
    if (job) jobs.push(job);
  }
  return jobs;
}
