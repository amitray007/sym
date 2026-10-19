import type { Sql } from "../db.ts";
import { jobsWithStaleCards, markCardSent, type SlackCard, updateJob } from "../ledger/jobs.ts";
import { claimPosts, markPostFailed, markPostSent, type OutboxPost } from "../ledger/outbox.ts";
import { type SlackApi, SlackApiError } from "../slack/api.ts";

// Sends Sym's own Slack posts from the outbox and brings job cards up to date (docs/slack.md).
// Any process can run it: the t3_job steps right after they enqueue, and a schedule as the
// safety net. Claims keep two senders from sending one post twice.

// The card version a card post shows. It travels in the payload and never reaches Slack.
export const CARD_VERSION_FIELD = "sym_card_version";

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

  for (const job of await jobsWithStaleCards(sql, limit)) {
    if (!job.card || !job.cardTs || !job.slackChannel) continue;
    try {
      await slack.call("chat.update", cardBody(job.slackChannel, job.cardTs, job.card));
      await markCardSent(sql, job.id, job.cardVersion);
      report.cardsUpdated++;
    } catch {
      // The next delivery tries again. The card keeps its last shown version until then.
      report.failed++;
    }
  }
  return report;
}

async function sendPost(sql: Sql, slack: SlackApi, post: OutboxPost): Promise<void> {
  const { [CARD_VERSION_FIELD]: cardVersion, ...payload } = post.payload as Record<string, unknown>;
  const body =
    post.method === "chat.postMessage"
      ? { unfurl_links: false, unfurl_media: false, ...payload }
      : payload;
  const response = await slack.call(post.method, body);
  const ts = typeof response.ts === "string" ? response.ts : (payload.ts as string | undefined);
  if (!ts) throw new Error(`Slack ${post.method} returned no ts`);

  await markPostSent(sql, post.id, ts);
  if (post.purpose === "card" && post.jobId !== null) {
    await updateJob(sql, post.jobId, { cardTs: ts });
    if (typeof cardVersion === "number") await markCardSent(sql, post.jobId, cardVersion);
  }
}

function cardBody(channel: string, ts: string, card: SlackCard) {
  return { channel, ts, blocks: card.blocks, text: card.text };
}

function errorCode(error: unknown): string {
  if (error instanceof SlackApiError) return error.code;
  return error instanceof Error ? error.message.slice(0, 200) : String(error);
}
