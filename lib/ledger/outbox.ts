import type { Sql } from "../db.ts";
import type { DisplayChoice } from "../display.ts";
import { json } from "./jobs.ts";

// Durable Slack posts (docs/architecture.md). Each post has an idempotency key, so a re-run step
// enqueues it once. Each post carries its chooseDisplay result, and the outbox refuses a post
// without one (AGENTS.md invariant). A database check backs up this rule.

export type OutboxMethod = "chat.postMessage" | "chat.update";
export type OutboxStatus = "pending" | "sent" | "failed";

export interface OutboxPost {
  id: number;
  idempotencyKey: string;
  jobId: number | null;
  method: OutboxMethod;
  payload: unknown;
  display: DisplayChoice;
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
    insert into outbox (idempotency_key, job_id, method, payload, display)
    values (
      ${post.idempotencyKey}, ${post.jobId ?? null}, ${post.method}, ${json(sql, post.payload)},
      ${json(sql, display)}
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

export async function markPostSent(sql: Sql, id: number, slackTs: string): Promise<void> {
  await sql`
    update outbox set status = 'sent', slack_ts = ${slackTs}, sent_at = now(),
      attempts = attempts + 1
    where id = ${id}
  `;
}

// Records a failed send. The post stays pending until it reaches MAX_ATTEMPTS.
export async function markPostFailed(sql: Sql, id: number, error: string): Promise<void> {
  await sql`
    update outbox set attempts = attempts + 1, last_error = ${error},
      status = case when attempts + 1 >= ${MAX_ATTEMPTS} then 'failed' else status end
    where id = ${id} and status = 'pending'
  `;
}

function normalize(row: OutboxPost): OutboxPost {
  return { ...row, id: Number(row.id), jobId: row.jobId === null ? null : Number(row.jobId) };
}
