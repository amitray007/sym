import type { Sql } from "../db.ts";
import { json } from "../ledger/jobs.ts";
import { nextFire, parseCron } from "./cron.ts";
import { sameJson } from "./match.ts";

// Schedule rows (docs/architecture.md, flow 2). Only an approved row fires. The owner approves
// the row once, and that covers every fire of that exact brief.

export type ScheduleStatus = "pending_approval" | "active" | "paused" | "deleted";
export type RunOutcome = "started" | "all_clear" | "needs_attention" | "failed";

export interface Schedule {
  id: number;
  cron: string;
  title: string;
  brief: unknown;
  channel: string;
  owner: string;
  status: ScheduleStatus;
  approvedBy: string | null;
  approvedAt: Date | null;
  leaseUntil: Date | null;
  lastFiredAt: Date | null;
  nextFireAt: Date | null;
  createdAt: Date;
}

export interface ScheduleRun {
  id: number;
  scheduleId: number;
  firedAt: Date;
  sessionId: string | null;
  outcome: RunOutcome;
  jobId: number | null;
}

export interface NewSchedule {
  cron: string;
  title: string;
  brief: unknown;
  channel: string;
  owner: string;
}

export const scheduleRef = (id: number) => `S-${id}`;

// Finds a schedule by its reference, such as `S-3` or `3`.
export function parseScheduleRef(ref: string): number | undefined {
  const match = /^(?:S-)?(\d+)$/i.exec(ref.trim());
  return match?.[1] ? Number(match[1]) : undefined;
}

// Throws on a bad cron, so a bad row never exists.
export async function createSchedule(sql: Sql, input: NewSchedule): Promise<Schedule> {
  parseCron(input.cron);
  const [row] = await sql<Schedule[]>`
    insert into schedules (cron, title, brief, channel, owner)
    values (
      ${input.cron.trim()}, ${input.title}, ${json(sql, input.brief)}, ${input.channel},
      ${input.owner}
    )
    returning *
  `;
  if (!row) throw new Error("schedule insert returned no row");
  return normalize(row);
}

export async function getSchedule(sql: Sql, id: number): Promise<Schedule | undefined> {
  const [row] = await sql<Schedule[]>`select * from schedules where id = ${id}`;
  return row ? normalize(row) : undefined;
}

// Lists schedules that are not deleted, oldest first.
export async function listSchedules(sql: Sql): Promise<Schedule[]> {
  const rows = await sql<Schedule[]>`
    select * from schedules where status <> 'deleted' order by id
  `;
  return rows.map(normalize);
}

// Approves a pending row and sets its first fire time. Returns undefined for any other state.
export async function approveSchedule(
  sql: Sql,
  id: number,
  approvedBy: string,
  now: Date,
): Promise<Schedule | undefined> {
  const row = await getSchedule(sql, id);
  if (row?.status !== "pending_approval") return undefined;
  const next = nextFire(row.cron, now);
  if (!next) throw new Error(`Cron "${row.cron}" never fires.`);
  const [updated] = await sql<Schedule[]>`
    update schedules
    set status = 'active', approved_by = ${approvedBy}, approved_at = ${now}, next_fire_at = ${next}
    where id = ${id} and status = 'pending_approval'
    returning *
  `;
  return updated ? normalize(updated) : undefined;
}

export async function pauseSchedule(sql: Sql, id: number): Promise<Schedule | undefined> {
  const [row] = await sql<Schedule[]>`
    update schedules set status = 'paused', next_fire_at = null
    where id = ${id} and status = 'active'
    returning *
  `;
  return row ? normalize(row) : undefined;
}

// Resumes a paused row. It fires at the next cron time, so a pause leaves no backlog.
export async function resumeSchedule(
  sql: Sql,
  id: number,
  now: Date,
): Promise<Schedule | undefined> {
  const row = await getSchedule(sql, id);
  if (row?.status !== "paused") return undefined;
  const next = nextFire(row.cron, now);
  if (!next) throw new Error(`Cron "${row.cron}" never fires.`);
  const [updated] = await sql<Schedule[]>`
    update schedules set status = 'active', next_fire_at = ${next}
    where id = ${id} and status = 'paused'
    returning *
  `;
  return updated ? normalize(updated) : undefined;
}

// A soft delete, because runs keep a reference for the digest.
export async function deleteSchedule(sql: Sql, id: number): Promise<Schedule | undefined> {
  const [row] = await sql<Schedule[]>`
    update schedules set status = 'deleted', next_fire_at = null, lease_until = null
    where id = ${id} and status <> 'deleted'
    returning *
  `;
  return row ? normalize(row) : undefined;
}

// Claims the active rows that are due. A claim runs out after `leaseMs`, so a crashed dispatcher
// does not block a row, and two dispatchers never get the same row. Call completeClaim after
// the fire.
export async function claimDueSchedules(
  sql: Sql,
  now: Date,
  leaseMs: number,
  limit = 25,
): Promise<Schedule[]> {
  const until = new Date(now.getTime() + leaseMs);
  const rows = await sql<Schedule[]>`
    update schedules set lease_until = ${until}
    where id in (
      select id from schedules
      where status = 'active' and next_fire_at <= ${now}
        and (lease_until is null or lease_until < ${now})
      order by next_fire_at, id
      limit ${limit}
      for update skip locked
    )
    returning *
  `;
  return rows.map(normalize).sort((a, b) => a.id - b.id);
}

// Ends a claim: records the fire and moves to the next cron time after `now`. A missed window
// is skipped, not replayed. A row paused or deleted during the fire keeps its status.
// Only the claim owner ends the claim: the lease must still be the one `schedule` carries.
// Returns false when another dispatcher took over after the lease ran out.
export async function completeClaim(sql: Sql, schedule: Schedule, now: Date): Promise<boolean> {
  const next = nextFire(schedule.cron, now) ?? null;
  const rows = await sql`
    update schedules
    set last_fired_at = ${now}, lease_until = null,
      next_fire_at = case when status = 'active' then ${next} else next_fire_at end
    where id = ${schedule.id} and lease_until = ${schedule.leaseUntil}
    returning id
  `;
  return rows.length > 0;
}

// Persists the identity of one fire before the dispatcher sends. Returns undefined when this
// fire (schedule and due time) already has a run, so the caller must not send again.
export async function reserveRun(
  sql: Sql,
  run: { scheduleId: number; dueAt: Date; firedAt: Date },
): Promise<ScheduleRun | undefined> {
  const [row] = await sql<ScheduleRun[]>`
    insert into schedule_runs (schedule_id, due_at, fired_at)
    values (${run.scheduleId}, ${run.dueAt}, ${run.firedAt})
    on conflict (schedule_id, due_at) do nothing
    returning *
  `;
  return row ? normalizeRun(row) : undefined;
}

// Binds a pre-approved job to the run of this session. The run must belong to the named
// schedule and have no job yet. The same job may claim it again (a replayed step).
export async function claimRunForJob(
  sql: Sql,
  sessionId: string,
  scheduleId: number,
  jobId: number,
): Promise<boolean> {
  const rows = await sql`
    update schedule_runs set job_id = ${jobId}
    where session_id = ${sessionId} and schedule_id = ${scheduleId}
      and (job_id is null or job_id = ${jobId})
    returning id
  `;
  return rows.length > 0;
}

// The dispatcher sends first and attaches the session to its run right after, so a fast model
// can ask before the attach lands. While this schedule has a run reserved in the last 2 minutes
// and not yet attached, wait a little and claim again. Without such a run, there is nothing to
// wait for.
export async function claimRunWhenAttached(
  sql: Sql,
  sessionId: string,
  scheduleId: number,
  jobId: number,
  options: { attempts?: number; delayMs?: number } = {},
): Promise<boolean> {
  const attempts = options.attempts ?? 30;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await claimRunForJob(sql, sessionId, scheduleId, jobId)) return true;
    const [pending] = await sql`
      select 1 from schedule_runs
      where schedule_id = ${scheduleId} and session_id is null and job_id is null
        and fired_at >= now() - interval '2 minutes'
      limit 1
    `;
    if (!pending) return false;
    await new Promise((resolve) => setTimeout(resolve, options.delayMs ?? 500));
  }
  return false;
}

// Sets the session of a reserved run, after the send.
export async function attachSession(sql: Sql, runId: number, sessionId: string): Promise<void> {
  await sql`update schedule_runs set session_id = ${sessionId} where id = ${runId}`;
}

export async function recordRun(
  sql: Sql,
  run: { scheduleId: number; firedAt: Date; sessionId?: string; outcome?: RunOutcome },
): Promise<ScheduleRun> {
  const [row] = await sql<ScheduleRun[]>`
    insert into schedule_runs (schedule_id, fired_at, session_id, outcome)
    values (${run.scheduleId}, ${run.firedAt}, ${run.sessionId ?? null}, ${run.outcome ?? "started"})
    returning *
  `;
  if (!row) throw new Error("schedule run insert returned no row");
  return normalizeRun(row);
}

// Sets the result of a run, once the check ends.
export async function finishRun(
  sql: Sql,
  id: number,
  outcome: RunOutcome,
  jobId?: number,
): Promise<void> {
  await sql`
    update schedule_runs set outcome = ${outcome}, job_id = coalesce(${jobId ?? null}, job_id)
    where id = ${id}
  `;
}

// Ends the run a session started, once. Later calls keep the first result. Links the job.
export async function finishRunForSession(
  sql: Sql,
  sessionId: string,
  outcome: RunOutcome,
  jobId?: number,
): Promise<void> {
  await sql`
    update schedule_runs
    set outcome = case when outcome = 'started' then ${outcome} else outcome end,
      job_id = coalesce(job_id, ${jobId ?? null})
    where session_id = ${sessionId}
  `;
}

export async function runsSince(sql: Sql, since: Date): Promise<ScheduleRun[]> {
  const rows = await sql<ScheduleRun[]>`
    select * from schedule_runs where fired_at >= ${since} order by id
  `;
  return rows.map(normalizeRun);
}

function normalize(row: Schedule): Schedule {
  return { ...row, id: Number(row.id) };
}

function normalizeRun(row: ScheduleRun): ScheduleRun {
  return {
    ...row,
    id: Number(row.id),
    scheduleId: Number(row.scheduleId),
    jobId: row.jobId === null ? null : Number(row.jobId),
  };
}

// True when the schedule is active and `brief` is the brief the owner approved. t3_job uses this
// to skip the Start prompt for a scheduled run, so the model cannot widen an approved brief.
export async function isApprovedBrief(sql: Sql, id: number, brief: unknown): Promise<boolean> {
  const row = await getSchedule(sql, id);
  return row?.status === "active" && sameJson(row.brief, brief);
}
