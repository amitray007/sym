import type { Sql } from "../db.ts";
import { CARD_VERSION_FIELD } from "../delivery/deliver.ts";
import { chooseDisplay, type Surface } from "../display.ts";
import { type Job, type JobStatus, jobRef, setJobCard, updateJob } from "../ledger/jobs.ts";
import { enqueuePost } from "../ledger/outbox.ts";
import { Brief } from "./brief.ts";
import { jobCardSteps, renderCollapsedCard, renderJobCard } from "./card.ts";
import type { OutputContract } from "./contract.ts";
import {
  briefPrompt,
  failureMessage,
  type JobFacts,
  permissionBlockMessage,
  quietNotice,
  resultMessage,
} from "./messages.ts";
import type { ProgressEvent } from "./progress.ts";

// How a job shows in Slack (docs/display.md, docs/slack.md). Every post goes through
// chooseDisplay and the outbox. The card is Sym's own message: the job row holds the card Sym
// wants, and delivery edits Slack to match. Posts carry idempotency keys, so a re-run step or a
// second watcher posts each message once.

const TERMINAL: readonly JobStatus[] = ["done", "failed", "cancelled"];
const WORKER_LABEL = "T3 Code";

// Posts the full brief before the Start prompt. Eve's prompt card keeps only about 200
// characters, so the brief itself is Sym's own message in the job thread.
export async function presentBrief(sql: Sql, job: Job): Promise<void> {
  if (!job.slackChannel) return;
  const ref = jobRef(job.id);
  const text = briefPrompt(Brief.parse(job.brief), ref);
  const display = chooseDisplay({
    kind: job.kind,
    needsAction: true,
    isNew: true,
    estMinutes: 0,
    steps: 0,
    lines: text.split("\n").length,
    surface: surfaceOf(job.slackChannel),
    quiet: false,
  });
  await enqueuePost(sql, {
    idempotencyKey: `${ref}:brief`,
    jobId: job.id,
    method: "chat.postMessage",
    payload: { ...target(job), text },
    // The Start buttons are Eve's prompt below this message, so the brief stays in the thread.
    display: { ...display, target: "thread" },
  });
}

// Posts the start of a job: a live card for long jobs with steps, otherwise one line.
export async function presentStart(sql: Sql, job: Job, now: Date): Promise<Job> {
  if (!job.slackChannel) return job;
  const brief = Brief.parse(job.brief);
  const display = chooseDisplay({
    kind: job.kind,
    needsAction: false,
    isNew: true,
    estMinutes: brief.estimatedMinutes,
    steps: brief.doneWhen.length + 4,
    lines: 1,
    surface: surfaceOf(job.slackChannel),
    quiet: false,
  });
  const withDisplay = await updateJob(sql, job.id, { display });
  if (display.level === 0) return withDisplay;

  if (display.level === 3) {
    const carded = await setJobCard(sql, job.id, liveCard(withDisplay, now));
    await enqueuePost(sql, {
      idempotencyKey: `${jobRef(job.id)}:card`,
      jobId: job.id,
      method: "chat.postMessage",
      purpose: "card",
      payload: {
        ...target(carded),
        blocks: carded.card?.blocks,
        text: carded.card?.text,
        [CARD_VERSION_FIELD]: carded.cardVersion,
      },
      display,
    });
    return carded;
  }

  await enqueuePost(sql, {
    idempotencyKey: `${jobRef(job.id)}:start`,
    jobId: job.id,
    method: "chat.postMessage",
    payload: { ...target(withDisplay), text: `Started ${jobRef(job.id)}: ${job.title}` },
    display,
  });
  return withDisplay;
}

// Edits the card and posts the events that deserve a new message (docs/architecture.md, flow 3).
// `step` names the check, so the same event in a re-run check posts once.
export async function presentProgress(
  sql: Sql,
  job: Job,
  events: ProgressEvent[],
  step: string,
  now: Date,
): Promise<void> {
  if (!job.slackChannel) return;
  const ended = TERMINAL.includes(job.status);
  if (job.display?.level === 3 && !ended) await refreshCard(sql, job, now);
  const ref = jobRef(job.id);
  for (const event of events) {
    switch (event.type) {
      case "pr_opened":
        // At the end the result message carries the PR, so the thread gets one end message.
        if (!ended) {
          await post(sql, job, `${ref}:pr`, `${ref} opened a pull request: <${event.url}>`, false);
        }
        break;
      case "needs_permission":
        // A permission prompt blocks until a person approves it on the worker. Only the owner
        // can do that, so the notice goes to the owner's DM.
        await post(sql, job, `${ref}:permission:${step}`, permissionBlockMessage(ref), true);
        break;
      case "quiet":
        await post(
          sql,
          job,
          `${ref}:quiet:${step}`,
          quietNotice(facts(job, now), quietFor(job, now)),
          false,
        );
        break;
      // Questions become buttons through ctx.ask in the t3_job task. The end posts its own result.
      case "needs_input":
      case "finished":
      case "failed":
        break;
    }
  }
}

// Collapses the card and posts the one result message.
export async function presentEnd(
  sql: Sql,
  job: Job,
  contract: OutputContract | null,
  now: Date,
): Promise<void> {
  if (!job.slackChannel || !TERMINAL.includes(job.status)) return;
  const ref = jobRef(job.id);
  if (job.display?.level === 3) {
    await setJobCard(
      sql,
      job.id,
      renderCollapsedCard({
        ref,
        title: job.title,
        status: job.status as "done" | "failed" | "cancelled",
        startedAt: job.startedAt ?? job.createdAt,
        now,
        prUrl: contract?.prUrl ?? job.prUrl,
      }),
    );
  }
  const text =
    job.status === "done"
      ? resultMessage(facts(job, now), contract)
      : job.status === "failed"
        ? failureMessage(facts(job, now), job.lastSummary)
        : `${ref} was cancelled.`;
  // A failure notifies even in quiet mode (docs/display.md).
  await post(sql, job, `${ref}:end`, text, false, job.status === "failed");
}

// The card's block_id carries its version, because Slack redraws a plan block only under a new
// block_id. So compare against the card rendered at the current version first, and move to the
// next version only when something changed.
async function refreshCard(sql: Sql, job: Job, now: Date): Promise<void> {
  const same = liveCard(job, now, job.cardVersion);
  // jsonb reorders object keys, so compare with sorted keys.
  if (canonical(same) === canonical(job.card)) return;
  await setJobCard(sql, job.id, liveCard(job, now, job.cardVersion + 1));
}

function liveCard(job: Job, now: Date, version = job.cardVersion + 1) {
  const brief = Brief.parse(job.brief);
  return renderJobCard({
    ref: jobRef(job.id),
    title: job.title,
    status: job.status,
    steps: jobCardSteps({
      status: job.status,
      threadStarted: job.workerThreadId !== null,
      doneWhen: brief.doneWhen,
      latestSummary: job.lastSummary,
    }),
    startedAt: job.startedAt ?? job.createdAt,
    now,
    footer: {
      worker: WORKER_LABEL,
      threadId: job.workerThreadId,
      updatedAt: job.lastActivityAt ?? job.updatedAt,
    },
    version,
  });
}

async function post(
  sql: Sql,
  job: Job,
  key: string,
  text: string,
  toOwner: boolean,
  failed = false,
): Promise<void> {
  const display = chooseDisplay({
    kind: job.kind,
    needsAction: toOwner,
    isNew: true,
    failed,
    estMinutes: 0,
    steps: 0,
    lines: text.split("\n").length,
    surface: surfaceOf(job.slackChannel ?? ""),
    quiet: false,
  });
  if (display.level === 0) return;
  const dm = toOwner && job.owner !== null;
  await enqueuePost(sql, {
    idempotencyKey: key,
    jobId: job.id,
    method: "chat.postMessage",
    payload: {
      ...(dm ? { channel: job.owner } : target(job)),
      text,
    },
    display: dm ? { ...display, target: "dm" } : display,
  });
}

// The thread the job was asked in.
function target(job: Job) {
  return {
    channel: job.slackChannel,
    ...(job.slackThreadTs ? { thread_ts: job.slackThreadTs } : {}),
  };
}

function facts(job: Job, now: Date): JobFacts {
  const started = job.startedAt ?? job.createdAt;
  return {
    ref: jobRef(job.id),
    title: job.title,
    workerThreadId: job.workerThreadId,
    durationMs: now.getTime() - started.getTime(),
  };
}

function quietFor(job: Job, now: Date): number {
  const since = job.lastActivityAt ?? job.startedAt ?? job.createdAt;
  return now.getTime() - since.getTime();
}

// Slack DM channel IDs start with D. Shared channels look like any channel to Sym for now.
function surfaceOf(channel: string): Surface {
  return channel.startsWith("D") ? "dm" : "channel";
}

// JSON with sorted object keys and no undefined fields. This module runs inside the workflow
// bundle, which cannot import Node.js builtins such as node:util.
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : inner,
  );
}
