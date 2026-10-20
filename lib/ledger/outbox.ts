import type { Sql } from "../db.ts";
import type { DisplayChoice } from "../display.ts";
import { json } from "./jobs.ts";

// Durable Slack posts (docs/architecture.md). Each post has an idempotency key, so a re-run step
// enqueues it once. Each post carries its chooseDisplay result, and the outbox refuses a post
// without one (AGENTS.md invariant). A database check backs up this rule.

export type OutboxMethod = "chat.postMessage" | "chat.update";
// A `card` post is a job card. Its Slack ts is saved on the job row, so later edits find it.
export type OutboxPurpose = "message" | "card";
export type OutboxStatus = "pending" | "sent" | "failed";

export interface OutboxPost {
  id: number;
  idempotencyKey: string;
  jobId: number | null;
  method: OutboxMethod;
  payload: unknown;
  display: DisplayChoice;
  purpose: OutboxPurpose;
  status: OutboxStatus;
  attempts: number;
  lastError: string | null;
  slackTs: string | null;
  createdAt: Date;
  sentAt: Date | null;
}

export interface NewPost {
  idempotencyKey: string;
  jobId?: number;
  method: OutboxMethod;
  payload: unknown;
  display: DisplayChoice | undefined;
  purpose?: OutboxPurpose;
}

// After this many failed sends a post stops retrying and waits for a person.
export const MAX_ATTEMPTS = 5;

export async function enqueuePost(sql: Sql, post: NewPost): Promise<OutboxPost> {
  const { display } = post;
  if (!display) throw new Error("The outbox refuses a post without a display choice.");
  if (display.level === 0) {
    throw new Error("Display level 0 posts nothing. Leave it to the digest.");
  }

  const [inserted] = await sql<OutboxPost[]>`
    insert into outbox (idempotency_key, job_id, method, payload, display, purpose)
    values (
      ${post.idempotencyKey}, ${post.jobId ?? null}, ${post.method}, ${json(sql, post.payload)},
      ${json(sql, display)}, ${post.purpose ?? "message"}
    )
    on conflict (idempotency_key) do nothing
    returning *
  `;
  if (inserted) return normalize(inserted);

  // The key exists: this is a re-run. Return the first post unchanged.
  const [existing] = await sql<OutboxPost[]>`
    select * from outbox where idempotency_key = ${post.idempotencyKey}
  `;
  if (!existing) throw new Error(`outbox lost post ${post.idempotencyKey}`);
  return normalize(existing);
}

export async function pendingPosts(sql: Sql, limit = 20): Promise<OutboxPost[]> {
  const rows = await sql<OutboxPost[]>`
    select * from outbox where status = 'pending' order by created_at, id limit ${limit}
  `;
  return rows.map(normalize);
}

// Claims pending posts for one sender. A claim runs out after `leaseMs`, so a crashed sender's
// posts go to the next one. Slack posts are at-least-once: a crash after Slack answered and
// before markPostSent sends the post again.
export async function claimPosts(sql: Sql, limit: number, leaseMs: number): Promise<OutboxPost[]> {
  const rows = await sql<OutboxPost[]>`
    update outbox set claimed_until = now() + ${`${leaseMs} milliseconds`}::interval
    where id in (
      select id from outbox
      where status = 'pending' and (claimed_until is null or claimed_until < now())
      order by created_at, id
      limit ${limit}
      for update skip locked
    )
    returning *
  `;
  return rows.map(normalize).sort((a, b) => a.id - b.id);
}

// The newest post of a job whose idempotency key starts with `prefix`.
export async function latestPost(
  sql: Sql,
  jobId: number,
  prefix: string,
): Promise<OutboxPost | undefined> {
  const [row] = await sql<OutboxPost[]>`
    select * from outbox
    where job_id = ${jobId} and starts_with(idempotency_key, ${prefix})
    order by id desc limit 1
  `;
  return row && normalize(row);
}

// The status of one post, for a caller that must tell a person whether a send went out.
export async function postStatus(sql: Sql, id: number): Promise<OutboxStatus | undefined> {
  const [row] = await sql<{ status: OutboxStatus }[]>`select status from outbox where id = ${id}`;
  return row?.status;
}

// Stops a pending post that no longer matters, for example an outage notice after the outage.
export async function dropPost(sql: Sql, id: number, reason: string): Promise<void> {
  await sql`
    update outbox set status = 'failed', last_error = ${reason}
    where id = ${id} and status = 'pending'
  `;
}

export async function markPostSent(sql: Sql, id: number, slackTs: string): Promise<void> {
  await sql`
    update outbox set status = 'sent', slack_ts = ${slackTs}, sent_at = now(),
      attempts = attempts + 1
    where id = ${id}
  `;
}

// Completes a card post and saves the card's Slack ts and shown version on the job in ONE
// statement. A crash cannot leave a sent card whose ts is unknown, so nobody can edit it.
// `version` is the card version the post showed. The shown version never moves back.
export async function markCardPostSent(
  sql: Sql,
  id: number,
  slackTs: string,
  version: number | undefined,
): Promise<void> {
  await sql`
    with sent as (
      update outbox set status = 'sent', slack_ts = ${slackTs}, sent_at = now(),
        attempts = attempts + 1
      where id = ${id}
      returning job_id
    )
    update jobs set
      card_ts = ${slackTs},
      card_sent_version = greatest(card_sent_version, ${version ?? 0}),
      updated_at = now()
    from sent where jobs.id = sent.job_id
  `;
}

// Records a failed send. The post stays pending until it reaches MAX_ATTEMPTS.
export async function markPostFailed(sql: Sql, id: number, error: string): Promise<void> {
  await sql`
    update outbox set attempts = attempts + 1, last_error = ${error}, claimed_until = null,
      status = case when attempts + 1 >= ${MAX_ATTEMPTS} then 'failed' else status end
    where id = ${id} and status = 'pending'
  `;
}

function normalize(row: OutboxPost): OutboxPost {
  return { ...row, id: Number(row.id), jobId: row.jobId === null ? null : Number(row.jobId) };
}

// The Slack ts of every message the outbox sent to one thread: job cards, results, progress.
// They are Sym's posts that never entered a session's history (decision 050). Bounded to the
// latest 200.
export async function sentPostTimestamps(
  sql: Sql,
  channelId: string,
  threadTs: string,
): Promise<string[]> {
  const rows = await sql<{ slackTs: string }[]>`
    select slack_ts from outbox
    where status = 'sent' and method = 'chat.postMessage' and slack_ts is not null
      and payload->>'channel' = ${channelId} and payload->>'thread_ts' = ${threadTs}
    order by id desc limit 200
  `;
  return rows.map((row) => row.slackTs);
}
