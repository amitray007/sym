import type postgres from "postgres";
import type { Sql } from "../db.ts";
import { nextFire } from "./cron.ts";

// Schedule rows (docs/architecture.md, flow 2; decision 085). A row holds an instruction for the
// brain. The person who set it up consented to its runs, so a new row is active at once.

export type ScheduleStatus = "active" | "paused" | "done" | "deleted";
export type RunOutcome = "started" | "all_clear" | "needs_attention" | "failed";
// Whether a run may start Builder work without a Start click.
export type BuilderMode = "ask" | "auto";

export interface Schedule {
  id: number;
  // Five fields in UTC, or null for a one-time row.
  cron: string | null;
  // The one-time run, or null for a recurring row.
  runAt: Date | null;
  title: string;
  instruction: string;
  builder: BuilderMode;
  // The Slack channel each run posts in. A DM destination is the DM channel.
  channel: string;
  owner: string;
  status: ScheduleStatus;
  leaseUntil: Date | null;
  lastFiredAt: Date | null;
  nextFireAt: Date | null;
  createdAt: Date;
  // Set on a row seeded from the pack's schedules.yaml (decision 055).
  packKey: string | null;
}

// A run of a schedule or of an event trigger (decision 088). Exactly one of the two is set.
export interface ScheduleRun {
  id: number;
  scheduleId: number | null;
  triggerId: number | null;
  firedAt: Date;
  sessionId: string | null;
  outcome: RunOutcome;
  jobId: number | null;
}

export type ScheduleTiming =
  | { cron: string; runAt?: undefined }
  | { cron?: undefined; runAt: Date };

export type NewSchedule = ScheduleTiming & {
  title: string;
  instruction: string;
  builder: BuilderMode;
  channel: string;
  owner: string;
};

export const scheduleRef = (id: number) => `S-${id}`;

// Finds a schedule by its reference, such as `S-3` or `3`.
export function parseScheduleRef(ref: string): number | undefined {
  const match = /^(?:S-)?(\d+)$/i.exec(ref.trim());
  return match?.[1] ? Number(match[1]) : undefined;
}

// The first fire after `after`: the next cron time, or the one-time run while it is ahead.
// Throws on a bad cron.
export function nextFireOf(
  timing: { cron: string | null | undefined; runAt: Date | null | undefined },
  after: Date,
): Date | undefined {
  if (timing.cron) return nextFire(timing.cron, after);
  return timing.runAt && timing.runAt > after ? timing.runAt : undefined;
}

// A schedule that can never fire again. Its message is safe to show.
export class ScheduleTimingError extends Error {
  override name = "ScheduleTimingError";
}

function firstFire(timing: { cron: string | null; runAt: Date | null }, now: Date): Date {
  const next = nextFireOf(timing, now);
  if (next) return next;
  throw new ScheduleTimingError(
    timing.cron ? `Cron "${timing.cron}" never fires.` : "That time has passed.",
  );
}

// Throws on a bad cron, a cron that never fires, or a one-time run in the past, so a bad row
// never exists.
export async function createSchedule(sql: Sql, input: NewSchedule, now: Date): Promise<Schedule> {
  const cron = input.cron?.trim() ?? null;
  const runAt = input.runAt ?? null;
  const next = firstFire({ cron, runAt }, now);
  const [row] = await sql<Schedule[]>`
    insert into schedules (cron, run_at, title, instruction, builder, channel, owner, next_fire_at)
    values (
      ${cron}, ${runAt}, ${input.title}, ${input.instruction}, ${input.builder}, ${input.channel},
      ${input.owner}, ${next}
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

// Lists schedules that can still run, oldest first.
export async function listSchedules(sql: Sql): Promise<Schedule[]> {
  const rows = await sql<Schedule[]>`
    select * from schedules where status not in ('deleted', 'done') order by id
  `;
  return rows.map(normalize);
}

export async function pauseSchedule(sql: Sql, id: number): Promise<Schedule | undefined> {
  const [row] = await sql<Schedule[]>`
    update schedules set status = 'paused', next_fire_at = null
    where id = ${id} and status = 'active'
    returning *
  `;
  return row ? normalize(row) : undefined;
}

// Resumes a paused row. It fires at the next cron time, so a pause leaves no backlog. Throws
// when it can never fire again, such as a one-time run whose time passed.
export async function resumeSchedule(
  sql: Sql,
  id: number,
  now: Date,
): Promise<Schedule | undefined> {
  const row = await getSchedule(sql, id);
  if (row?.status !== "paused") return undefined;
  const next = firstFire(row, now);
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
// is skipped, not replayed. A one-time row is done. A row paused or deleted during the fire
// keeps its status.
// Only the claim owner ends the claim: the lease must still be the one `schedule` carries.
// Returns false when another dispatcher took over after the lease ran out.
export async function completeClaim(sql: Sql, schedule: Schedule, now: Date): Promise<boolean> {
  const next = nextFireOf(schedule, now) ?? null;
  const rows = await sql`
    update schedules
    set last_fired_at = ${now}, lease_until = null,
      status = case when status = 'active' and run_at is not null then 'done' else status end,
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

// The run of this fire that a dispatcher reserved and never delivered, such as one that crashed
// before its send.
export async function unsentRun(
  sql: Sql,
  scheduleId: number,
  dueAt: Date,
): Promise<ScheduleRun | undefined> {
  const [row] = await sql<ScheduleRun[]>`
    select * from schedule_runs
    where schedule_id = ${scheduleId} and due_at = ${dueAt} and session_id is null
      and outcome = 'started'
  `;
  return row ? normalizeRun(row) : undefined;
}

// What a run belongs to: a schedule, or an event trigger (decision 088). A bare number is a
// schedule.
export type RunSource = number | { schedule: number } | { trigger: number };

function sourceColumn(source: RunSource): { column: "schedule_id" | "trigger_id"; id: number } {
  if (typeof source === "number") return { column: "schedule_id", id: source };
  return "trigger" in source
    ? { column: "trigger_id", id: source.trigger }
    : { column: "schedule_id", id: source.schedule };
}

// Binds a pre-approved job to the run of this session. The run must belong to the named
// schedule or trigger and have no job yet. The same job may claim it again (a replayed step).
export async function claimRunForJob(
  sql: Sql,
  sessionId: string,
  source: RunSource,
  jobId: number,
): Promise<boolean> {
  const { column, id } = sourceColumn(source);
  const rows = await sql`
    update schedule_runs set job_id = ${jobId}
    where session_id = ${sessionId} and ${sql(column)} = ${id}
      and (job_id is null or job_id = ${jobId}) and outcome = 'started'
    returning id
  `;
  return rows.length > 0;
}

// The dispatcher sends first and attaches the session to its run right after, so a fast model
// can ask before the attach lands. While this schedule has a run sent or reserved in the last 2
// minutes and not yet attached, wait a little and claim again. Without such a run, there is nothing to
// wait for.
export async function claimRunWhenAttached(
  sql: Sql,
  sessionId: string,
  source: RunSource,
  jobId: number,
  options: { attempts?: number; delayMs?: number } = {},
): Promise<boolean> {
  const { column, id } = sourceColumn(source);
  const attempts = options.attempts ?? 30;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await claimRunForJob(sql, sessionId, source, jobId)) return true;
    // A deferred trigger run waits for the dispatcher, not for an attach (decision 088).
    const [pending] = await sql`
      select 1 from schedule_runs
      where ${sql(column)} = ${id} and session_id is null and job_id is null and not deferred
        and coalesce(sent_at, fired_at) >= now() - interval '2 minutes'
      limit 1
    `;
    // The attach can land between the claim and this check. Claim once more before giving up.
    if (!pending) return claimRunForJob(sql, sessionId, source, jobId);
    await new Promise((resolve) => setTimeout(resolve, options.delayMs ?? 500));
  }
  return false;
}

// The creator of the schedule or trigger whose run this session is, for a run that acts on
// their behalf (decisions 085 and 088). Like claimRunWhenAttached, it waits briefly while a recent run still waits
// for its session.
export async function runCreatorOf(
  sql: Sql,
  sessionId: string,
  options: { attempts?: number; delayMs?: number } = {},
): Promise<string | undefined> {
  const attempts = options.attempts ?? 20;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const owner = await creatorOfSession(sql, sessionId);
    if (owner) return owner;
    // A delivery in the last 2 minutes, a retried one included, may not be attached yet.
    const [pending] = await sql`
      select 1 from schedule_runs
      where session_id is null and outcome = 'started' and not deferred
        and coalesce(sent_at, fired_at) >= now() - interval '2 minutes'
      limit 1
    `;
    // The attach can land between the two reads. Read once more before giving up.
    if (!pending) return creatorOfSession(sql, sessionId);
    await new Promise((resolve) => setTimeout(resolve, options.delayMs ?? 500));
  }
  return undefined;
}

async function creatorOfSession(sql: Sql, sessionId: string): Promise<string | undefined> {
  const [row] = await sql<{ owner: string | null }[]>`
    select coalesce(s.owner, t.owner) as owner from schedule_runs r
    left join schedules s on s.id = r.schedule_id
    left join triggers t on t.id = r.trigger_id
    where r.session_id = ${sessionId}
  `;
  return row?.owner ?? undefined;
}

// Ends a run whose turn started no job, from what the turn posted (decision 085). The first
// settlement of a session wins. A turn can settle before the dispatcher attaches its session, so
// the settlement is kept by session and attachSession applies it. Both take the same session
// lock, so neither can miss the other. A run that has a job keeps waiting: the job's end sets
// its outcome.
export async function finishRunWithoutJob(
  sql: Sql,
  sessionId: string,
  outcome: Exclude<RunOutcome, "started">,
): Promise<void> {
  await sql.begin(async (tx) => {
    await lockSession(tx, sessionId);
    await tx`
      insert into schedule_run_settlements (session_id, outcome) values (${sessionId}, ${outcome})
      on conflict (session_id) do nothing
    `;
    await tx`
      update schedule_runs r set outcome = st.outcome
      from schedule_run_settlements st
      where r.session_id = ${sessionId} and st.session_id = r.session_id
        and r.outcome = 'started' and r.job_id is null
        and not exists (select 1 from jobs where session_id = ${sessionId})
    `;
  });
}

// Marks a delivery attempt of a reserved run, so a lookup waits for its attach (runCreatorOf).
export async function markSending(sql: Sql, runId: number): Promise<void> {
  await sql`update schedule_runs set sent_at = now() where id = ${runId}`;
}

// Sets the session of a reserved run, after the send, and applies a turn that already settled.
export async function attachSession(sql: Sql, runId: number, sessionId: string): Promise<void> {
  await sql.begin(async (tx) => {
    await lockSession(tx, sessionId);
    await tx`
      update schedule_runs r set session_id = ${sessionId},
        outcome = case
          when r.outcome = 'started' and r.job_id is null
            and not exists (select 1 from jobs where session_id = ${sessionId})
          then coalesce(
            (select outcome from schedule_run_settlements where session_id = ${sessionId}),
            r.outcome
          )
          else r.outcome
        end
      where r.id = ${runId}
    `;
  });
}

// Serializes the attach and the settlement of one session, until the transaction ends.
async function lockSession(tx: postgres.TransactionSql, sessionId: string): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtext(${`schedule-session:${sessionId}`}))`;
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
    scheduleId: row.scheduleId === null ? null : Number(row.scheduleId),
    triggerId: row.triggerId === null || row.triggerId === undefined ? null : Number(row.triggerId),
    jobId: row.jobId === null ? null : Number(row.jobId),
  };
}
