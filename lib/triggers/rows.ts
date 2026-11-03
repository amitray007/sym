import type { Sql } from "../db.ts";
import { json } from "../ledger/jobs.ts";
import type { BuilderMode, ScheduleRun } from "../schedules/rows.ts";

// Event trigger rows (docs/architecture.md, flows 2b to 2d; decisions 088, 090, and 091). A
// trigger holds an instruction for the brain, like a schedule, and fires on a Slack event in its
// watched channel, on a signed request to its webhook URL, or on a GitHub or Linear event. The
// person who set it up consented to its runs, so a new row is active at once.

export type TriggerKind = "message" | "reaction" | "webhook" | "github" | "linear";
export type SourceKind = "github" | "linear";

// Which GitHub events fire a trigger (decision 091). Empty lists mean any.
export interface GitHubFilter {
  // `owner/name`, lowercase.
  repository: string;
  events: GitHubEventName[];
  actions: string[];
  // A label the issue or pull request must carry.
  label: string | null;
  // The pull request's base branch, or the check suite's head branch.
  branch: string | null;
}
export type GitHubEventName = "pull_request" | "issues" | "check_suite" | "issue_comment";

// Which Linear issue events fire a trigger (decision 091). Empty lists mean any.
export interface LinearFilter {
  // A team key such as `ENG`, uppercase.
  team: string | null;
  actions: string[];
  label: string | null;
}

export type SourceFilter = GitHubFilter | LinearFilter;
export type TriggerStatus = "active" | "paused" | "deleted";

export interface Trigger {
  id: number;
  kind: TriggerKind;
  // The watched Slack channel. Null for a webhook trigger.
  channel: string | null;
  keywords: string[];
  emoji: string | null;
  title: string;
  instruction: string;
  builder: BuilderMode;
  // Null: the event message's thread. Else a channel ID, or the creator's DM channel.
  destination: string | null;
  owner: string;
  status: TriggerStatus;
  // A webhook trigger: the unguessable ID in its URL, and the version its secret derives from.
  hookId: string | null;
  secretVersion: number;
  // A GitHub or Linear trigger: which events fire it.
  sourceFilter: SourceFilter | null;
  createdAt: Date;
}

export type NewTrigger = Pick<
  Trigger,
  "kind" | "channel" | "keywords" | "emoji" | "title" | "instruction" | "builder" | "destination"
> & { owner: string; hookId?: string | null; sourceFilter?: SourceFilter | null };

// The facts of the event that fired a run. They are untrusted data for the brain.
export type TriggerEvent =
  | SlackTriggerEvent
  | WebhookTriggerEvent
  | GitHubTriggerEvent
  | LinearTriggerEvent;

// A GitHub App webhook event (decision 091). Whoever acted on GitHub is not the requester.
export interface GitHubTriggerEvent {
  kind: "github";
  event: GitHubEventName;
  action: string | null;
  repository: string;
  // The issue or pull request number, when there is one.
  number: number | null;
  title: string | null;
  url: string | null;
  // The GitHub login that caused the event.
  sender: string | null;
  labels: string[];
  branch: string | null;
  // A check suite's conclusion, such as `failure`.
  conclusion: string | null;
  // The issue, pull request, or comment body, cut to fit.
  text: string | null;
}

// A Linear issue webhook event (decision 091).
export interface LinearTriggerEvent {
  kind: "linear";
  action: string | null;
  identifier: string | null;
  title: string | null;
  url: string | null;
  team: string | null;
  state: string | null;
  labels: string[];
  // The issue description, cut to fit.
  text: string | null;
}

// A signed request to a webhook trigger's URL (decision 090). Anyone holding the URL and the
// secret could have sent it, so every field is data.
export interface WebhookTriggerEvent {
  kind: "webhook";
  // The request's media type, without parameters.
  contentType: string | null;
  // The parsed JSON body, or the body as text when it is not JSON.
  body: unknown;
  // True when the body was cut to fit the run message.
  truncated: boolean;
  receivedAt: string;
}

// A Slack message or reaction in a watched channel (decision 088).
export interface SlackTriggerEvent {
  kind: "message" | "reaction";
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
      kind, channel, keywords, emoji, title, instruction, builder, destination, owner, hook_id,
      source_filter
    ) values (
      ${input.kind}, ${input.channel}, ${input.keywords}, ${input.emoji}, ${input.title},
      ${input.instruction}, ${input.builder}, ${input.destination}, ${input.owner},
      ${input.hookId ?? null},
      ${input.sourceFilter ? json(sql, input.sourceFilter) : null}
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

// The active GitHub or Linear triggers. Code matches each event against their filters.
export async function sourceTriggers(sql: Sql, kind: SourceKind): Promise<Trigger[]> {
  const rows = await sql<Trigger[]>`
    select * from triggers where kind = ${kind} and status = 'active' order by id
  `;
  return rows.map(normalize);
}

// The webhook trigger behind a URL, unless it was deleted.
export async function getWebhookTrigger(sql: Sql, hookId: string): Promise<Trigger | undefined> {
  const [row] = await sql<Trigger[]>`
    select * from triggers where hook_id = ${hookId} and kind = 'webhook' and status <> 'deleted'
  `;
  return row ? normalize(row) : undefined;
}

// Rotates a webhook trigger's secret: the next version derives a new one, and the old one stops
// working at once. Only the creator may rotate, because the new secret goes to whoever asked.
export async function rotateWebhookSecret(
  sql: Sql,
  id: number,
  owner: string,
): Promise<Trigger | undefined> {
  const [row] = await sql<Trigger[]>`
    update triggers set secret_version = secret_version + 1
    where id = ${id} and kind = 'webhook' and owner = ${owner} and status <> 'deleted'
    returning *
  `;
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
    // More keys that name the same event, such as a hash of its signed content (decision 090).
    // A run with any of them, as its event key or alias, makes this a duplicate.
    aliases?: string[];
    // A key that makes this a duplicate only of runs fired within `windowMs`, such as a hash of a
    // webhook body inside its replay window.
    recent?: { key: string; windowMs: number };
  },
): Promise<Reservation> {
  const keys = [input.eventKey, ...(input.aliases ?? [])];
  return sql.begin(async (tx) => {
    const [trigger] = await tx`
      select id from triggers where id = ${input.triggerId} and status = 'active' for update
    `;
    if (!trigger) return { status: "inactive" as const };
    const [seen] = await tx`
      select 1 from schedule_runs
      where trigger_id = ${input.triggerId}
        and (event_key = any(${keys}::text[])
          or jsonb_exists_any(coalesce(event -> 'aliases', '[]'::jsonb), ${keys}::text[]))
    `;
    if (seen) return { status: "duplicate" as const };
    if (input.recent) {
      const after = new Date(input.firedAt.getTime() - input.recent.windowMs);
      const [recent] = await tx`
        select 1 from schedule_runs
        where trigger_id = ${input.triggerId} and fired_at > ${after}
          and event ->> 'recent' = ${input.recent.key}
      `;
      if (recent) return { status: "duplicate" as const };
    }
    const since = new Date(input.firedAt.getTime() - 3600_000);
    const [count] = await tx<{ n: number }[]>`
      select count(*)::int as n from schedule_runs
      where trigger_id = ${input.triggerId} and fired_at > ${since}
    `;
    if ((count?.n ?? 0) >= input.maxPerHour) return { status: "limited" as const };
    const event = {
      facts: input.facts,
      target: input.target,
      ...(input.aliases?.length ? { aliases: input.aliases } : {}),
      ...(input.recent ? { recent: input.recent.key } : {}),
    };
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

// Claims the deferred runs the dispatcher should send now, each for `leaseMs`. The run stays
// deferred until its session is attached (`endDeferred`), so a dispatcher that crashes after the
// claim leaves it for the next tick once the lease runs out; the delivery key makes that resend
// reach the same session. A deferred run older than `maxAgeMs` is stale: it fails instead of
// firing late.
export async function claimDeferredRuns(
  sql: Sql,
  now: Date,
  options: { maxAgeMs: number; leaseMs: number; limit?: number },
): Promise<TriggerRun[]> {
  const oldest = new Date(now.getTime() - options.maxAgeMs);
  await sql`
    update schedule_runs set deferred = false, deferred_until = null, outcome = 'failed'
    where deferred and fired_at < ${oldest} and session_id is null
  `;
  const until = new Date(now.getTime() + options.leaseMs);
  const rows = await sql<TriggerRun[]>`
    update schedule_runs set deferred_until = ${until}
    where id in (
      select id from schedule_runs
      where deferred and (deferred_until is null or deferred_until < ${now})
      order by id limit ${options.limit ?? 25}
      for update skip locked
    )
    returning *
  `;
  return rows.map(normalizeRun).sort((a, b) => a.id - b.id);
}

// Ends a deferred run's wait, after its session is attached or its send failed for good.
export async function endDeferred(sql: Sql, runId: number): Promise<void> {
  await sql`
    update schedule_runs set deferred = false, deferred_until = null where id = ${runId}
  `;
}

// Claims a Slack thread for one trigger run (decision 088). Eve gives a thread one session, so
// the first run to claim it owns it, whichever event, message or reaction, came first. A thread
// that already has a session, such as a person's conversation with Sym, cannot be claimed.
// Atomic: of two concurrent claims, one wins.
export async function claimThread(
  sql: Sql,
  input: { channel: string; threadTs: string; runId: number },
): Promise<boolean> {
  const rows = await sql`
    insert into trigger_threads (channel_id, thread_ts, run_id)
    select ${input.channel}, ${input.threadTs}, ${input.runId}
    where not exists (
      select 1 from session_threads
      where channel_id = ${input.channel} and thread_ts = ${input.threadTs}
    )
    on conflict (channel_id, thread_ts) do nothing
    returning run_id
  `;
  return rows.length > 0;
}

// Moves a reserved run to the target it will start at, and queues it for the dispatcher when
// its sender cannot reach that target.
export async function setRunTarget(
  sql: Sql,
  runId: number,
  target: RunTarget,
  deferred: boolean,
): Promise<void> {
  await sql`
    update schedule_runs
    set event = jsonb_set(event, '{target}', ${json(sql, target)}), deferred = ${deferred}
    where id = ${runId}
  `;
}

// Remembers that a person's turn ran in this session's thread (decision 088).
export async function markPersonTurn(sql: Sql, sessionId: string): Promise<void> {
  await sql`update session_threads set person_turn = true where session_id = ${sessionId}`;
}

// True for a session that is a trigger run (decision 088). Its turns read event text from
// whoever wrote the message. Like runCreatorOf, it waits briefly while a recent delivery may
// not be attached yet.
export async function isTriggerRunSession(
  sql: Sql,
  sessionId: string,
  options: { attempts?: number; delayMs?: number; wait?: boolean } = {},
): Promise<boolean> {
  const attempts = options.attempts ?? 20;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const [row] = await sql<{ trigger: boolean }[]>`
      select trigger_id is not null as trigger from schedule_runs where session_id = ${sessionId}
    `;
    if (row) return row.trigger;
    // Only the run's own first turn can come before the attach.
    if (options.wait === false) return false;
    const [pending] = await sql`
      select 1 from schedule_runs
      where session_id is null and outcome = 'started' and (not deferred or sent_at is not null)
        and coalesce(sent_at, fired_at) >= now() - interval '2 minutes'
      limit 1
    `;
    if (!pending) return false;
    await new Promise((resolve) => setTimeout(resolve, options.delayMs ?? 500));
  }
  return false;
}

// Claims one deferred run for an immediate send, such as a webhook run right after Sym accepted
// its request (decision 090), with the same lease the dispatcher takes. The dispatcher claims the
// same rows, so only one of them sends it; if this send never ends, the lease runs out and the
// dispatcher sends it with the same delivery key.
export async function claimDeferredRun(
  sql: Sql,
  runId: number,
  now: Date,
  leaseMs = 2 * 60_000,
): Promise<TriggerRun | undefined> {
  const until = new Date(now.getTime() + leaseMs);
  const [row] = await sql<TriggerRun[]>`
    update schedule_runs set deferred_until = ${until}
    where id = ${runId} and deferred and (deferred_until is null or deferred_until < ${now})
    returning *
  `;
  return row ? normalizeRun(row) : undefined;
}

// True for a thread whose only session is a trigger run that stayed silent and that no person has
// talked to Sym in. Replies there are people's own talk, so they start no turn; a mention still
// does.
export async function isSilentRunThread(
  sql: Sql,
  channel: string,
  threadTs: string,
): Promise<boolean> {
  // A person's turn there, the creator's mention included, sets `person_turn` and ends the rule.
  const [row] = await sql<{ silent: boolean }[]>`
    select bool_and(
      r.trigger_id is not null and r.outcome = 'all_clear' and not t.person_turn
    ) as silent
    from session_threads t
    left join schedule_runs r on r.session_id = t.session_id
    where t.channel_id = ${channel} and t.thread_ts = ${threadTs}
  `;
  return row?.silent === true;
}

function normalize(row: Trigger): Trigger {
  return {
    ...row,
    id: Number(row.id),
    keywords: row.keywords ?? [],
    hookId: row.hookId ?? null,
    secretVersion: Number(row.secretVersion ?? 1),
    sourceFilter: row.sourceFilter ?? null,
  };
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
