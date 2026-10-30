import type { Sql } from "../db.ts";
import { CHOICE_ACTION_ID } from "../ledger/choices.ts";
import { getJob, jobsWithStaleCards, markCardSent, type SlackCard } from "../ledger/jobs.ts";
import {
  claimPosts,
  dropPost,
  markCardPostSent,
  markPostFailed,
  markPostSent,
  type OutboxPost,
} from "../ledger/outbox.ts";
import { DISMISS_ACTION_ID, START_ACTION_ID } from "../ledger/proposals.ts";
import { type SlackApi, SlackApiError } from "../slack/api.ts";

// Sends Sym's own Slack posts from the outbox and brings job cards up to date (docs/slack.md).
// Any process can run it: the worker_job steps right after they enqueue, and a schedule as the
// safety net. Claims keep two senders from sending one post twice.

// The card version a card post shows. It travels in the payload and never reaches Slack.
export const CARD_VERSION_FIELD = "sym_card_version";
export const ROOT_GUARD_FIELD = "sym_thread_reply";

const CLAIM_MS = 60_000;

export interface DeliveryReport {
  sent: number;
  failed: number;
  cardsUpdated: number;
}

export async function deliver(sql: Sql, slack: SlackApi, limit = 20): Promise<DeliveryReport> {
  const report: DeliveryReport = { sent: 0, failed: 0, cardsUpdated: 0 };

  for (const post of await claimPosts(sql, limit, CLAIM_MS)) {
    try {
      await sendPost(sql, slack, post);
      report.sent++;
    } catch (error) {
      await markPostFailed(sql, post.id, errorCode(error));
      report.failed++;
    }
  }

  for (const stale of await jobsWithStaleCards(sql, limit)) {
    try {
      if (await updateCard(sql, slack, stale.id)) report.cardsUpdated++;
    } catch {
      // The next delivery tries again. The card keeps its last shown version until then.
      report.failed++;
    }
  }
  return report;
}

// Edits one job's card. One sender at a time owns a job's card (a transaction-scoped advisory
// lock). The owner reloads the newest card first, so a slower sender never writes an old version
// over a newer one. A sender that cannot get the lock skips: the owner covers its version.
async function updateCard(sql: Sql, slack: SlackApi, jobId: number): Promise<boolean> {
  return sql.begin(async (transaction) => {
    // A transaction runs the same queries as the pool. The ledger helpers take the pool type.
    const tx = transaction as unknown as Sql;
    // The schema name keeps test schemas that share one database apart.
    const [lock] = await tx<{ owned: boolean }[]>`
      select pg_try_advisory_xact_lock(hashtext(current_schema()), ${jobId}::int) as owned
    `;
    if (!lock?.owned) return false;
    const job = await getJob(tx, jobId);
    if (!job?.card || !job.cardTs || !job.slackChannel) return false;
    if (job.cardVersion <= job.cardSentVersion) return false;
    await slack.call("chat.update", cardBody(job.slackChannel, job.cardTs, job.card));
    await markCardSent(tx, job.id, job.cardVersion);
    return true;
  });
}

async function sendPost(sql: Sql, slack: SlackApi, post: OutboxPost): Promise<void> {
  const {
    [CARD_VERSION_FIELD]: cardVersion,
    [ROOT_GUARD_FIELD]: protectRoot,
    ...payload
  } = post.payload as Record<string, unknown>;
  const body =
    post.method === "chat.postMessage"
      ? { unfurl_links: false, unfurl_media: false, ...payload }
      : payload;
  if (protectRoot && payload.thread_ts) {
    try {
      const root = await slack.call("chat.getPermalink", {
        channel: payload.channel,
        message_ts: payload.thread_ts,
      });
      if (root.ok === false)
        throw new SlackApiError("chat.getPermalink", String(root.error ?? "unknown_error"));
    } catch (error) {
      if (error instanceof SlackApiError && error.code === "message_not_found")
        await dropPost(sql, post.id, "The reply's thread was deleted");
      throw error;
    }
  }
  if (
    post.method === "sym.document" ||
    (post.method === "chat.postMessage" &&
      typeof body.text === "string" &&
      body.text.length > 12000)
  ) {
    await sendDocument(slack, body);
    await markPostSent(sql, post.id, null);
    return;
  }
  let response: Record<string, unknown>;
  try {
    response = await slack.call(post.method, body);
  } catch (error) {
    if (
      !(error instanceof SlackApiError) ||
      ![
        "invalid_blocks",
        "invalid_blocks_format",
        "msg_blocks_too_long",
        "msg_blocks_too_many",
      ].includes(error.code)
    )
      throw error;
    const { blocks: _blocks, ...plain } = body;
    response = await slack.call(post.method, plain);
  }
  const ts = typeof response.ts === "string" ? response.ts : (payload.ts as string | undefined);
  if (!ts) throw new Error(`Slack ${post.method} returned no ts`);

  for (const block of (Array.isArray(payload.blocks) ? payload.blocks : []) as {
    elements?: { action_id?: string; value?: string }[];
  }[]) {
    for (const action of block.elements ?? []) {
      if (
        action.action_id?.startsWith(`${CHOICE_ACTION_ID}_`) &&
        /^\d+:[0-2]$/.test(action.value ?? "")
      ) {
        await sql`update conversation_choices set message_ts = coalesce(message_ts, ${ts}) where id = ${(action.value ?? "").split(":")[0] ?? "0"}::bigint`;
      }
      if (
        [START_ACTION_ID, DISMISS_ACTION_ID].includes(action.action_id ?? "") &&
        /^\d+$/.test(action.value ?? "")
      ) {
        await sql`update job_proposals set message_ts = coalesce(message_ts, ${ts}) where id = ${action.value ?? "0"}::bigint`;
      }
    }
  }
  if (post.purpose === "card" && post.jobId !== null) {
    // One statement: the post is sent and the job knows the card's ts and version.
    await markCardPostSent(
      sql,
      post.id,
      ts,
      typeof cardVersion === "number" ? cardVersion : undefined,
    );
  } else {
    await markPostSent(sql, post.id, ts);
  }
}

function cardBody(channel: string, ts: string, card: SlackCard) {
  return { channel, ts, blocks: card.blocks, text: card.text };
}

function errorCode(error: unknown): string {
  if (error instanceof SlackApiError) return error.code;
  return error instanceof Error ? error.message.slice(0, 200) : String(error);
}

async function sendDocument(slack: SlackApi, payload: Record<string, unknown>): Promise<void> {
  const text = String(payload.text ?? "");
  const bytes = new TextEncoder().encode(text);
  const upload = await slack.call("files.getUploadURLExternal", {
    filename: "sym-response.md",
    length: bytes.length,
  });
  if (typeof upload.upload_url !== "string" || typeof upload.file_id !== "string")
    throw new Error("Slack returned no upload target");
  const response = await fetch(upload.upload_url, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: bytes,
  });
  if (!response.ok) throw new Error("Slack refused the document upload");
  await slack.call("files.completeUploadExternal", {
    files: [{ id: upload.file_id, title: "Full reply" }],
    channel_id: payload.channel,
    ...(payload.thread_ts ? { thread_ts: payload.thread_ts } : {}),
    initial_comment: text
      .trim()
      .split(/\n\s*\n/, 1)[0]
      ?.slice(0, 12_000),
  });
}
