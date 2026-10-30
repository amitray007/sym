import { type Caller, workerJobId } from "../callers.ts";
import type { Sql } from "../db.ts";
import { deliver } from "../delivery/deliver.ts";
import { chooseDisplay } from "../display.ts";
import { getJobByRef, type JobStatus, jobRef, updateJob } from "../ledger/jobs.ts";
import { enqueuePost } from "../ledger/outbox.ts";
import type { Pack } from "../pack/load.ts";
import type { SlackApi } from "../slack/api.ts";
import { escapeMrkdwn } from "./messages.ts";
import { presentProgress } from "./present.ts";

// What a worker thread may do to its own job through the MCP channel (docs/eve.md). All worker
// text is untrusted: it is capped here and escaped before it reaches Slack. This module runs
// inside Eve's tool bundle, so it imports no Node.js builtins.

export const SUMMARY_MAX = 280;
export const QUESTION_MAX = 600;

const TERMINAL: readonly JobStatus[] = ["done", "failed", "cancelled"];

export interface WorkerCallDeps {
  sql: Sql;
  /** When set, the call sends its posts at once. Otherwise the delivery schedule sends them. */
  slack?: SlackApi;
  // The adopter pack, for quiet hours.
  pack?: Pack;
  now?: () => Date;
}

export interface WorkerCallResult {
  ok: boolean;
  /** A short receipt or refusal for the worker. */
  message: string;
}

/** Collapses whitespace and cuts to `max` characters. */
export function capText(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

// A short stable hash (cyrb53) for idempotency keys. It is not a security control.
export function shortHash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

async function activeJob(sql: Sql, ref: string, caller: Caller) {
  const bound = workerJobId(caller);
  if (bound === undefined)
    return { refusal: "This tool needs a job-scoped worker credential." } as const;
  const job = await getJobByRef(sql, ref);
  if (!job) return { refusal: `There is no job ${capText(ref, 40)}.` } as const;
  if (bound !== job.id) return { refusal: "This credential cannot update that job." } as const;
  if (TERMINAL.includes(job.status)) {
    return { refusal: `${jobRef(job.id)} already finished (${job.status}).` } as const;
  }
  return { job } as const;
}

async function sendNow(deps: WorkerCallDeps): Promise<void> {
  // A failed send never fails the call. The delivery schedule sends what is left.
  if (deps.slack) await deliver(deps.sql, deps.slack).catch(() => {});
}

// Records the worker's one-line progress on the job row and refreshes the card.
export async function postProgress(
  deps: WorkerCallDeps,
  input: { job: string; summary: string; skipping?: string | undefined },
  caller: Caller,
): Promise<WorkerCallResult> {
  const found = await activeJob(deps.sql, input.job, caller);
  if ("refusal" in found) return { ok: false, message: found.refusal };
  const summary = capText(input.summary, SUMMARY_MAX);
  if (!summary) return { ok: false, message: "The summary is empty." };

  const now = (deps.now ?? (() => new Date()))();
  const job = await updateJob(deps.sql, found.job.id, {
    lastSummary: summary,
    ...(input.skipping !== undefined ? { skipping: capText(input.skipping, 200) || null } : {}),
    lastActivityAt: now,
  });
  await presentProgress(deps.sql, job, [], `worker-progress:${shortHash(summary)}`, now, deps.pack);
  await sendNow(deps);
  return { ok: true, message: `Progress recorded for ${jobRef(job.id)}.` };
}

// Posts the worker's question in the job's thread, once per question.
export async function askOwner(
  deps: WorkerCallDeps,
  input: { job: string; question: string },
  caller: Caller,
): Promise<WorkerCallResult> {
  const found = await activeJob(deps.sql, input.job, caller);
  if ("refusal" in found) return { ok: false, message: found.refusal };
  const { job } = found;
  const question = capText(input.question, QUESTION_MAX);
  if (!question) return { ok: false, message: "The question is empty." };
  if (!job.slackChannel) {
    return { ok: false, message: `${jobRef(job.id)} has no Slack thread to ask in.` };
  }

  const ref = jobRef(job.id);
  const display = chooseDisplay({
    kind: job.kind,
    needsAction: true,
    isNew: true,
    estMinutes: 0,
    steps: 0,
    lines: 2,
    // Slack DM channel IDs start with D (same rule as present.ts).
    surface: job.slackChannel.startsWith("D") ? "dm" : "channel",
    quiet: false,
  });
  await enqueuePost(deps.sql, {
    idempotencyKey: `${ref}:ask:${shortHash(question)}`,
    jobId: job.id,
    method: "chat.postMessage",
    payload: {
      channel: job.slackChannel,
      ...(job.slackThreadTs ? { thread_ts: job.slackThreadTs } : {}),
      text: `${escapeMrkdwn(question)}\nReply here and I'll pass your answer on.`,
    },
    display,
  });
  await sendNow(deps);
  return { ok: true, message: `Question posted for ${ref}. Wait for the owner to reply.` };
}
