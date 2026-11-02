import type { Sql } from "../db.ts";
import { json } from "../ledger/jobs.ts";
import type { BuilderMode, ScheduleRun } from "../schedules/rows.ts";

// Event trigger rows (docs/architecture.md, flow 2b; decision 088). A trigger holds an
// instruction for the brain, like a schedule, and fires on a Slack event in its watched channel.
// The person who set it up consented to its runs, so a new row is active at once.

export type TriggerKind = "message" | "reaction";
export type TriggerStatus = "active" | "paused" | "deleted";

export interface Trigger {
  id: number;
  kind: TriggerKind;
  channel: string;
  keywords: string[];
  emoji: string | null;
  title: string;
  instruction: string;
  builder: BuilderMode;
  // Null: the event message's thread. Else a channel ID, or the creator's DM channel.
  destination: string | null;
  owner: string;
  status: TriggerStatus;
  createdAt: Date;
}

export type NewTrigger = Pick<
  Trigger,
  "kind" | "channel" | "keywords" | "emoji" | "title" | "instruction" | "builder" | "destination"
> & { owner: string };

// The facts of the Slack event that fired a run. They are untrusted data for the brain.
export interface TriggerEvent {
  kind: TriggerKind;
  channel: string;
  // The event message and its thread root.
  ts: string;
  threadTs: string;
  // The message author. Never the person the run acts for.
  author: string | null;
  text: string;
  link: string | null;
  // A reaction event: the emoji and the person who added it.
  emoji?: string | undefined;
  reactor?: string | undefined;
}

// Where a run's session starts: a thread, or a new thread in a channel.
export type RunTarget = { channelId: string; threadTs?: string };

export interface TriggerRun extends ScheduleRun {
  event: { facts: TriggerEvent; target: RunTarget } | null;
  deferred: boolean;
}

export const triggerRef = (id: number) => `T-${id}`;

// Finds a trigger by its reference, such as `T-3` or `3`.
export function parseTriggerRef(ref: string): number | undefined {
  const match = /^(?:T-)?(\d+)$/i.exec(ref.trim());
  return match?.[1] ? Number(match[1]) : undefined;
}

export async function createTrigger(sql: Sql, input: NewTrigger): Promise<Trigger> {
  const [row] = await sql<Trigger[]>`
    insert into triggers (
      kind, channel, keywords, emoji, title, instruction, builder, destination, owner
    ) values (
      ${input.kind}, ${input.channel}, ${input.keywords}, ${input.emoji}, ${input.title},
      ${input.instruction}, ${input.builder}, ${input.destination}, ${input.owner}
    )
    returning *
  `;
  if (!row) throw new Error("trigger insert returned no row");
  return normalize(row);
}

export async function getTrigger(sql: Sql, id: number): Promise<Trigger | undefined> {
  const [row] = await sql<Trigger[]>`select * from triggers where id = ${id}`;
  return row ? normalize(row) : undefined;
}

// Lists triggers that are not deleted, oldest first.
export async function listTriggers(sql: Sql): Promise<Trigger[]> {
  const rows = await sql<Trigger[]>`select * from triggers where status <> 'deleted' order by id`;
  return rows.map(normalize);
}

// The active triggers of one kind that watch a channel.
export async function watchingTriggers(
  sql: Sql,
  channel: string,
  kind: TriggerKind,
): Promise<Trigger[]> {
  const rows = await sql<Trigger[]>`
    select * from triggers where channel = ${channel} and kind = ${kind} and status = 'active'
    order by id
  `;
  return rows.map(normalize);
}

export async function setTriggerStatus(
  sql: Sql,
  id: number,
  status: "active" | "paused",
): Promise<Trigger | undefined> {
  const from = status === "active" ? "paused" : "active";
  const [row] = await sql<Trigger[]>`
    update triggers set status = ${status} where id = ${id} and status = ${from} returning *
  `;
  return row ? normalize(row) : undefined;
}

// A soft delete, because runs keep a reference for the digest.
export async function deleteTrigger(sql: Sql, id: number): Promise<Trigger | undefined> {
  const [row] = await sql<Trigger[]>`
    update triggers set status = 'deleted' where id = ${id} and status <> 'deleted' returning *
  `;
  return row ? normalize(row) : undefined;
}

export type Reservation =
  | { status: "reserved"; run: TriggerRun }
  | { status: "duplicate" }
  | { status: "limited" }
  | { status: "inactive" };

// Persists one fire before the send, like a schedule's reserveRun. The key names the Slack event,
// so a retried event finds its run and fires nothing. The trigger row lock orders fires of one
// trigger, so the hourly cap holds under concurrent events.
export async function reserveTriggerRun(
  sql: Sql,
  input: {
    triggerId: number;
    eventKey: string;
    facts: TriggerEvent;
    target: RunTarget;
    deferred: boolean;
    firedAt: Date;
    maxPerHour: number;
  },
): Promise<Reservation> {
  return sql.begin(async (tx) => {
    const [trigger] = await tx`
      select id from triggers where id = ${input.triggerId} and status = 'active' for update
    `;
    if (!trigger) return { status: "inactive" as const };
    const [seen] = await tx`
      select 1 from schedule_runs
      where trigger_id = ${input.triggerId} and event_key = ${input.eventKey}
    `;
    if (seen) return { status: "duplicate" as const };
    const since = new Date(input.firedAt.getTime() - 3600_000);
    const [count] = await tx<{ n: number }[]>`
      select count(*)::int as n from schedule_runs
      where trigger_id = ${input.triggerId} and fired_at > ${since}
    `;
    if ((count?.n ?? 0) >= input.maxPerHour) return { status: "limited" as const };
    const event = { facts: input.facts, target: input.target };
    const [row] = await tx<TriggerRun[]>`
      insert into schedule_runs (trigger_id, event_key, event, deferred, fired_at)
      values (
        ${input.triggerId}, ${input.eventKey}, ${json(tx as unknown as Sql, event)}, ${input.deferred},
        ${input.firedAt}
      )
      returning *
    `;
    if (!row) throw new Error("trigger run insert returned no row");
    return { status: "reserved" as const, run: normalizeRun(row) };
  });
}

// Claims the deferred runs the dispatcher should send now. A deferred run older than
// `maxAgeMs` is stale: it fails instead of firing late.
export async function claimDeferredRuns(
  sql: Sql,
  now: Date,
  maxAgeMs: number,
  limit = 25,
): Promise<TriggerRun[]> {
  const oldest = new Date(now.getTime() - maxAgeMs);
  await sql`
    update schedule_runs set deferred = false, outcome = 'failed'
    where deferred and fired_at < ${oldest}
  `;
  const rows = await sql<TriggerRun[]>`
    update schedule_runs set deferred = false
    where id in (
      select id from schedule_runs where deferred order by id limit ${limit}
      for update skip locked
    )
    returning *
  `;
  return rows.map(normalizeRun).sort((a, b) => a.id - b.id);
}

// True for a thread whose only session is a trigger run that stayed silent and that no person has
// talked to Sym in. Replies there are people's own talk, so they start no turn; a mention still
// does.
export async function isSilentRunThread(
  sql: Sql,
  channel: string,
  threadTs: string,
): Promise<boolean> {
  // A run's turn records its creator as the thread's person (threadUserOf), so the creator counts
  // as no person here.
  const [row] = await sql<{ silent: boolean }[]>`
    select bool_and(
      r.trigger_id is not null and r.outcome = 'all_clear'
        and (t.user_id is null or t.user_id = g.owner)
    ) as silent
    from session_threads t
    left join schedule_runs r on r.session_id = t.session_id
    left join triggers g on g.id = r.trigger_id
    where t.channel_id = ${channel} and t.thread_ts = ${threadTs}
  `;
  return row?.silent === true;
}

function normalize(row: Trigger): Trigger {
  return { ...row, id: Number(row.id), keywords: row.keywords ?? [] };
}

function normalizeRun(row: TriggerRun): TriggerRun {
  return {
    ...row,
    id: Number(row.id),
    scheduleId: null,
    triggerId: Number(row.triggerId),
    jobId: row.jobId === null ? null : Number(row.jobId),
  };
}
