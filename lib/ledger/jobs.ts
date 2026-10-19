import type postgres from "postgres";
import type { Sql } from "../db.ts";
import type { DisplayChoice } from "../display.ts";

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
  brief: unknown;
  worker: string;
  workerProjectId: string | null;
  workerThreadId: string | null;
  cursor: string | null;
  lastSummary: string | null;
  lastMessage: string | null;
  cardTs: string | null;
  display: DisplayChoice | null;
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
    | "workerThreadId"
    | "workerProjectId"
    | "cursor"
    | "lastSummary"
    | "lastMessage"
    | "cardTs"
    | "display"
  >
>;

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
export async function updateJob(sql: Sql, id: number, update: JobUpdate): Promise<Job> {
  const { status, ...rest } = update;
  if (status === undefined && Object.keys(rest).length === 0) {
    throw new Error("updateJob needs at least one field");
  }
  // postgres.js takes the column helper only right after `set`, so it always holds updated_at.
  const fields: Record<string, unknown> = { ...rest, updatedAt: new Date() };
  if (update.display !== undefined) {
    fields.display = update.display === null ? null : json(sql, update.display);
  }
  const finished = status !== undefined && TERMINAL.includes(status);
  const [row] = await sql<Job[]>`
    update jobs set ${sql(fields)},
      status = ${
        status === undefined
          ? sql`status`
          : sql`case when status in ${sql(TERMINAL)} then status else ${status} end`
      },
      finished_at = ${
        finished
          ? sql`case when status in ${sql(TERMINAL)} then finished_at else now() end`
          : sql`finished_at`
      }
    where id = ${id}
    returning *
  `;
  if (!row) throw new Error(`no job ${jobRef(id)}`);
  return normalize(row);
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
