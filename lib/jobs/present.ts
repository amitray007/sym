import type { Sql } from "../db.ts";
import { CARD_VERSION_FIELD } from "../delivery/deliver.ts";
import { chooseDisplay, type Surface } from "../display.ts";
import { recordOutcome } from "../learning/trust.ts";
import { type Job, type JobStatus, jobRef, setJobCard, updateJob } from "../ledger/jobs.ts";
import { enqueuePost } from "../ledger/outbox.ts";
import type { Pack } from "../pack/load.ts";
import { resolvePackProject } from "../pack/policy.ts";
import { isQuiet } from "../quiet/quiet.ts";
import { workerLabel } from "../worker-label.ts";
import { type BlockPost, clipText, failurePost, resultPost, SECTION_MAX } from "./blocks.ts";
import { Brief } from "./brief.ts";
import {
  BRIEF_ACTION_ID,
  jobButton,
  jobCardSteps,
  renderCollapsedCard,
  renderJobCard,
} from "./card.ts";
import type { OutputContract } from "./contract.ts";
import { briefPrompt, type JobFacts, permissionBlockMessage, quietNotice } from "./messages.ts";
import type { ProgressEvent } from "./progress.ts";
import {
  checkResult,
  type ModelCheck,
  mergeConcerns,
  modelConcerns,
  openPrUrl,
  verdictLine,
} from "./verify.ts";

// How a job shows in Slack (docs/display.md, docs/slack.md). Every post goes through
// chooseDisplay and the outbox. The card is Sym's own message: the job row holds the card Sym
// wants, and delivery edits Slack to match. Posts carry idempotency keys, so a re-run step or a
// second watcher posts each message once.

const TERMINAL: readonly JobStatus[] = ["done", "failed", "cancelled"];

// The kind of a pre-approved scheduled run. It posts nothing while it runs, and at the end only
// when something needs attention: a clean check stays silent, and the digest lists it (decision
// 031, docs/display.md step 2).
export const SCHEDULED_CHECK = "scheduled-check";

// Posts the short brief before the Start prompt. Eve's prompt card keeps only about 200
// characters, so the brief is Sym's own message in the job thread. It names the job, the
// project, and the delivery; its Full brief button shows the goal, constraints, and done-when
// list (decision 060). A brief needs an action, so quiet mode never hides it.
export async function presentBrief(
  sql: Sql,
  job: Job,
  modelLine?: string,
  playbook?: { name: string; trusted: boolean },
): Promise<void> {
  if (!job.slackChannel) return;
  const ref = jobRef(job.id);
  const text = briefPrompt(Brief.parse(job.brief), ref, modelLine, playbook);
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
    payload: {
      ...target(job),
      text,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: clipText(text, SECTION_MAX) } },
        {
          type: "actions",
          block_id: `job-${ref}-brief`,
          elements: [jobButton(BRIEF_ACTION_ID, "Full brief", ref)],
        },
      ],
    },
    // The Start buttons are Eve's prompt below this message, so the brief stays in the thread.
    display: { ...display, target: "thread" },
  });
}

// Posts the start of a job: a live card for long jobs with steps, otherwise one line.
// `pack` supplies the quiet hours. The owner's `/sym quiet` comes from the ledger.
export async function presentStart(
  sql: Sql,
  job: Job,
  now: Date,
  pack?: Pack,
  modelNote?: string,
): Promise<Job> {
  if (!job.slackChannel) return job;
  const brief = Brief.parse(job.brief);
  const scheduled = job.kind === SCHEDULED_CHECK;
  const display = chooseDisplay({
    kind: job.kind,
    needsAction: false,
    // A scheduled run has nothing to say when it starts.
    isNew: !scheduled,
    estMinutes: brief.estimatedMinutes,
    steps: brief.doneWhen.length + 4,
    lines: 1,
    surface: surfaceOf(job.slackChannel),
    quiet: await isQuiet(sql, pack, now),
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
    payload: {
      ...target(withDisplay),
      text: `Started ${jobRef(job.id)}: ${job.title}${modelNote ? `\n${modelNote}` : ""}`,
    },
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
  pack?: Pack,
): Promise<void> {
  if (!job.slackChannel) return;
  const quiet = await isQuiet(sql, pack, now);
  const ended = TERMINAL.includes(job.status);
  const scheduled = job.kind === SCHEDULED_CHECK;
  if (job.display?.level === 3 && !ended) await refreshCard(sql, job, now);
  const ref = jobRef(job.id);
  for (const event of events) {
    switch (event.type) {
      case "pr_opened":
        // At the end the result message carries the PR, so the thread gets one end message. A
        // job in `checking` has ended its work, and its result message follows. A scheduled run
        // reports only at its end.
        if (!ended && job.status !== "checking" && !scheduled) {
          await post(
            sql,
            job,
            `${ref}:pr`,
            `${ref} opened a pull request: <${event.url}>`,
            false,
            quiet,
          );
        }
        break;
      case "needs_permission":
        // A permission prompt blocks until a person approves it on the worker. Only the owner
        // can do that, so the notice goes to the owner's DM.
        await post(sql, job, `${ref}:permission:${step}`, permissionBlockMessage(ref), true, quiet);
        break;
      case "quiet":
        if (scheduled) break;
        await post(
          sql,
          job,
          `${ref}:quiet:${step}`,
          quietNotice(facts(job, now), quietFor(job, now)),
          false,
          quiet,
        );
        break;
      // Questions become buttons through ctx.ask in the worker_job task. The end posts its own result.
      case "needs_input":
      case "finished":
      case "failed":
        break;
    }
  }
}

// Collapses the card and posts the one result message. `check` is the model check, when the job
// tried one; its concerns join the rule-check concerns.
// Presents a job's end once, then marks it presented, silent or not. Reconcile re-presents ended
// jobs without the mark, so a crash between the terminal status and the end post loses nothing.
export async function presentEnd(
  sql: Sql,
  job: Job,
  contract: OutputContract | null,
  now: Date,
  pack?: Pack,
  check?: ModelCheck,
): Promise<void> {
  await presentEndOnce(sql, job, contract, now, pack, check);
  if (TERMINAL.includes(job.status)) {
    // The trust ladder counts the same checks the result shows (decision 059). It records once,
    // before the end mark, so recovery re-presents a job whose outcome a crash lost.
    const clean =
      job.status === "done" &&
      contract !== null &&
      contract.openQuestions.length === 0 &&
      endConcerns(job, contract, pack, check).length === 0;
    await recordOutcome(sql, job, clean, pack);
    await sql`update jobs set end_presented_at = coalesce(end_presented_at, now()) where id = ${job.id}`;
  }
}

async function presentEndOnce(
  sql: Sql,
  job: Job,
  original: OutputContract | null,
  now: Date,
  pack?: Pack,
  check?: ModelCheck,
): Promise<void> {
  if (!job.slackChannel || !TERMINAL.includes(job.status)) return;
  const ref = jobRef(job.id);
  // The checks see what the worker reported. The message may add the PR the worker's facts list.
  const contract = withFactsPr(job, original);
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
  const concerns = endConcerns(job, original, pack, check);
  // A clean scheduled check has nothing new to say (display rule step 2); the digest lists it.
  const clean = job.status === "done" && contract !== null && contract.openQuestions.length === 0;
  if (job.kind === SCHEDULED_CHECK && clean && concerns.length === 0) return;
  const message: BlockPost =
    job.status === "done"
      ? resultPost(facts(job, now), contract, concerns, verdictLine(check, concerns))
      : job.status === "failed"
        ? failurePost(facts(job, now), job.lastSummary)
        : { text: `🚫 ${ref} was cancelled.`, blocks: [] };
  // A failure notifies even in quiet mode (docs/display.md).
  const quiet = await isQuiet(sql, pack, now);
  await post(
    sql,
    job,
    `${ref}:end`,
    message.text,
    false,
    quiet,
    job.status === "failed",
    message.blocks,
  );
}

// A result that names no PR gets the thread's open PR from the worker's facts, so the message
// still links it (decision 057). The missing report shows as a concern.
function withFactsPr(job: Job, contract: OutputContract | null): OutputContract | null {
  if (!contract || contract.prUrl || job.prUrl) return contract;
  const url = openPrUrl(job.prFacts);
  return url ? { ...contract, prUrl: url } : contract;
}

// Checks the result against what the job allowed. Open questions and a missing result block
// already show in the result message, so only the rule breaks are added.
export function resultConcerns(job: Job, contract: OutputContract | null, pack?: Pack): string[] {
  if (!contract) return [];
  const brief = Brief.parse(job.brief);
  const allowed = pack ? resolvePackProject(pack, brief.project) : undefined;
  const project = allowed?.ok ? allowed.project : undefined;
  const expectedBase = brief.baseRef ?? project?.defaultBaseBranch;
  const { concerns } = checkResult(contract, {
    ...(project ? { allowedPaths: project.allowedPaths } : {}),
    pullRequestAllowed: brief.openPullRequest && (!project || project.prPolicy === "draft"),
    ...(job.prFacts ? { pullRequests: job.prFacts } : {}),
    // The brief's base branch wins; the pack's default applies next; without either, skip.
    ...(expectedBase ? { expectedBase } : {}),
    ...(project?.prPolicy === "draft" ? { draftOnly: true } : {}),
  });
  return concerns.filter((concern) => !concern.includes("open question"));
}

// Every concern the result message lists: the rule checks first, then the model check's, without
// repeats. The run outcome uses the same list, so the digest and Slack agree.
export function endConcerns(
  job: Job,
  contract: OutputContract | null,
  pack?: Pack,
  check?: ModelCheck,
): string[] {
  return mergeConcerns(resultConcerns(job, contract, pack), modelConcerns(check));
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
    prUrl: job.prUrl,
    footer: {
      worker: workerLabel(),
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
  quiet: boolean,
  failed = false,
  blocks: Record<string, unknown>[] = [],
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
    quiet,
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
      // `text` stays as the notification and accessibility fallback.
      ...(blocks.length > 0 ? { blocks } : {}),
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
