import type postgres from "postgres";
import type { Sql } from "../db.ts";
import type { DisplayChoice } from "../display.ts";
import type { PullRequestFacts } from "../workers/types.ts";

// Job rows (docs/architecture.md). A job row holds enough state to continue in a new session.

export type JobStatus =
  | "launching"
  | "running"
  | "waiting_input"
  | "waiting_permission"
  | "quiet"
  | "worker_offline"
  | "checking"
  | "done"
  | "failed"
  | "cancelled";

const TERMINAL: readonly JobStatus[] = ["done", "failed", "cancelled"];

export interface Job {
  id: number;
  requestKey: string;
  sessionId: string | null;
  kind: string;
  title: string;
  status: JobStatus;
  owner: string | null;
  slackChannel: string | null;
  slackThreadTs: string | null;
  // True when the job moved into its own Slack code channel (decision 067).
  codeChannel: boolean;
  // The thread a moved job came from. Null for a job that never moved.
  originChannel: string | null;
  originThreadTs: string | null;
  brief: unknown;
  worker: string;
  // The configured worker name and endpoint at launch; null for legacy jobs.
  workerIdentity: string | null;
  workerProjectId: string | null;
  workerThreadId: string | null;
  // The model the worker thread runs, as `<provider>/<model>`. Null when the worker's default applies.
  workerModel: string | null;
  cursor: string | null;
  lastSummary: string | null;
  lastMessage: string | null;
  cardTs: string | null;
  // The card Sym wants Slack to show, and the versions wanted and shown.
  card: SlackCard | null;
  cardVersion: number;
  cardSentVersion: number;
  display: DisplayChoice | null;
  prUrl: string | null;
  startedAt: Date | null;
  lastActivityAt: Date | null;
  quietNoticedAt: Date | null;
  watchUntil: Date | null;
  revision: number;
  verdict: unknown;
  // The worker's pull request facts at the job's end (decision 057). Null when never read.
  prFacts: PullRequestFacts[] | null;
  endPresentedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
}

export interface NewJob {
  // A key that stays the same when the step re-runs, such as the Eve tool call ID.
  requestKey: string;
  sessionId?: string;
  kind: string;
  title: string;
  owner?: string;
  slackChannel?: string;
  slackThreadTs?: string;
  brief: unknown;
  worker: string;
  workerProjectId?: string;
}

export type JobUpdate = Partial<
  Pick<
    Job,
    | "status"
    | "slackChannel"
    | "slackThreadTs"
    | "codeChannel"
    | "originChannel"
    | "originThreadTs"
    | "workerThreadId"
    | "workerProjectId"
    | "workerIdentity"
    | "workerModel"
    | "cursor"
    | "lastSummary"
    | "lastMessage"
    | "cardTs"
    | "display"
    | "prUrl"
    | "startedAt"
    | "lastActivityAt"
    | "quietNoticedAt"
    | "watchUntil"
    | "verdict"
    | "prFacts"
    | "endPresentedAt"
  >
>;

export interface SlackCard {
  blocks: unknown[];
  text: string;
}

// The reference people and worker thread titles use, for example `J-142`.
export function jobRef(id: number): string {
  return `J-${id}`;
}

// Creates the job, or returns the existing one when the request key was used before.
export async function createJob(sql: Sql, job: NewJob): Promise<Job> {
  const [row] = await sql<Job[]>`
    insert into jobs (
      request_key, session_id, kind, title, owner, slack_channel, slack_thread_ts, brief, worker,
      worker_project_id
    ) values (
      ${job.requestKey}, ${job.sessionId ?? null}, ${job.kind}, ${job.title}, ${job.owner ?? null},
      ${job.slackChannel ?? null}, ${job.slackThreadTs ?? null}, ${json(sql, job.brief)},
      ${job.worker}, ${job.workerProjectId ?? null}
    )
    on conflict (request_key) do update set request_key = excluded.request_key
    returning *
  `;
  if (!row) throw new Error("insert into jobs returned no row");
  return normalize(row);
}

export async function getJob(sql: Sql, id: number): Promise<Job | undefined> {
  const [row] = await sql<Job[]>`select * from jobs where id = ${id}`;
  return row && normalize(row);
}

// A finished job keeps its status: a stale check cannot move it back to running.
// Thrown when an update expected the job's cursor to be unchanged and another check moved it.
export class StaleJobError extends Error {
  override name = "StaleJobError";
}

// `expect.revision` makes the update conditional: it applies only while the job is still at the
// revision the caller read, so a slow check cannot overwrite a newer state. Every update bumps the
// revision.
export async function updateJob(
  sql: Sql,
  id: number,
  update: JobUpdate,
  expect?: { revision: number },
): Promise<Job> {
  const { status, ...rest } = update;
  if (status === undefined && Object.keys(rest).length === 0) {
    throw new Error("updateJob needs at least one field");
  }
  // postgres.js takes the column helper only right after `set`, so it always holds updated_at.
  const fields: Record<string, unknown> = { ...rest, updatedAt: new Date() };
  if (update.display !== undefined) {
    fields.display = update.display === null ? null : json(sql, update.display);
  }
  if (update.verdict !== undefined) {
    fields.verdict = update.verdict === null ? null : json(sql, update.verdict);
  }
  if (update.prFacts !== undefined) {
    fields.prFacts = update.prFacts === null ? null : json(sql, update.prFacts);
  }
  const finished = status !== undefined && TERMINAL.includes(status);
  const [row] = await sql<Job[]>`
    update jobs set ${sql(fields)},
      status = ${
        status === undefined
          ? sql`status`
          : sql`case when status in ${sql(TERMINAL)} then status else ${status} end`
      },
      revision = revision + 1,
      finished_at = ${
        finished
          ? sql`case when status in ${sql(TERMINAL)} then finished_at else now() end`
          : sql`finished_at`
      }
    where id = ${id}
      ${expect ? sql`and revision = ${expect.revision}` : sql``}
    returning *
  `;
  if (!row && expect) throw new StaleJobError(`${jobRef(id)} changed during the check`);
  if (!row) throw new Error(`no job ${jobRef(id)}`);
  return normalize(row);
}

// Records the card Sym wants Slack to show. The version goes up only when the card changes, so
// an unchanged card causes no Slack edit.
export async function setJobCard(sql: Sql, id: number, card: SlackCard): Promise<Job> {
  const value = json(sql, card);
  const [row] = await sql<Job[]>`
    update jobs set
      card = ${value},
      card_version = case when card is distinct from ${value}::jsonb
        then card_version + 1 else card_version end
    where id = ${id}
    returning *
  `;
  if (!row) throw new Error(`no job ${jobRef(id)}`);
  return normalize(row);
}

// Jobs whose card in Slack is older than the card Sym wants. Only posted cards can be edited.
export async function jobsWithStaleCards(sql: Sql, limit = 20): Promise<Job[]> {
  const rows = await sql<Job[]>`
    select * from jobs
    where card_ts is not null and card is not null and card_version > card_sent_version
    order by updated_at limit ${limit}
  `;
  return rows.map(normalize);
}

// Marks a card version as shown. A slower sender cannot move the shown version back.
export async function markCardSent(sql: Sql, id: number, version: number): Promise<void> {
  await sql`
    update jobs set card_sent_version = ${version}
    where id = ${id} and card_sent_version < ${version}
  `;
}

// Renews the watcher lease of a running job.
export async function renewWatch(sql: Sql, id: number, leaseMs: number): Promise<void> {
  await sql`
    update jobs set watch_until = now() + ${`${leaseMs} milliseconds`}::interval where id = ${id}
  `;
}

// Active jobs nobody watches: their lease ran out or was never set. Reconcile takes these over.
export async function orphanedJobs(sql: Sql): Promise<Job[]> {
  const rows = await sql<Job[]>`
    select * from jobs
    where status not in ${sql(TERMINAL)} and worker_thread_id is not null
      and (watch_until is null or watch_until < now())
    order by id
  `;
  return rows.map(normalize);
}

// Active jobs plus the jobs that finished since `since`, newest first, for status answers.
export async function recentJobs(sql: Sql, since: Date, limit = 20): Promise<Job[]> {
  const rows = await sql<Job[]>`
    select * from jobs
    where status not in ${sql(TERMINAL)} or finished_at >= ${since}
    order by id desc limit ${limit}
  `;
  return rows.map(normalize);
}

// Jobs that ended since `since`: a count per ending status and the newest ones.
export async function finishedSince(
  sql: Sql,
  since: Date,
  limit = 5,
): Promise<{ done: number; failed: number; cancelled: number; latest: Job[] }> {
  const counts = await sql<{ status: JobStatus; n: string }[]>`
    select status, count(*) as n from jobs
    where status in ${sql(TERMINAL)} and finished_at >= ${since}
    group by status
  `;
  const count = (status: JobStatus) => Number(counts.find((row) => row.status === status)?.n ?? 0);
  const latest = await sql<Job[]>`
    select * from jobs
    where status in ${sql(TERMINAL)} and finished_at >= ${since}
    order by finished_at desc limit ${limit}
  `;
  return {
    done: count("done"),
    failed: count("failed"),
    cancelled: count("cancelled"),
    latest: latest.map(normalize),
  };
}

// Finds a job by its reference, such as `J-142` or `142`.
export async function getJobByRef(sql: Sql, ref: string): Promise<Job | undefined> {
  const match = /^(?:J-)?(\d+)$/i.exec(ref.trim());
  if (!match?.[1]) return undefined;
  return getJob(sql, Number(match[1]));
}

// Jobs that still need watching: everything not done, failed, or cancelled.
export async function activeJobs(sql: Sql): Promise<Job[]> {
  const rows = await sql<Job[]>`
    select * from jobs where status not in ${sql(TERMINAL)} order by id
  `;
  return rows.map(normalize);
}

// Brief and display are plain JSON data. Interfaces lack the index signature JSONValue wants.
export function json(sql: Sql, value: unknown): postgres.Parameter {
  return sql.json(value as postgres.JSONValue);
}

// Postgres returns bigint as a string. Job IDs stay far below 2^53.
function normalize(row: Job): Job {
  return { ...row, id: Number(row.id) };
}
