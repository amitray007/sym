import type { Sql } from "../db.ts";
import { deliver } from "../delivery/deliver.ts";
import {
  createJob,
  getJob,
  type Job,
  type JobStatus,
  jobRef,
  renewWatch,
  updateJob,
} from "../ledger/jobs.ts";
import { getSessionThread } from "../ledger/threads.ts";
import type { Pack } from "../pack/load.ts";
import { briefGuardrails, resolvePackProject } from "../pack/policy.ts";
import type { SlackApi } from "../slack/api.ts";
import type {
  Activity,
  ActivityItem,
  WorkerAdapter,
  WorkerAnswers,
  WorkerQuestion,
  WorkerStatus,
} from "../workers/types.ts";
import { Brief, workerMessage } from "./brief.ts";
import { parseOutputContract } from "./contract.ts";
import {
  endConcerns,
  presentBrief,
  presentEnd,
  presentProgress,
  presentStart,
  SCHEDULED_CHECK,
} from "./present.ts";
import { detectEvents } from "./progress.ts";
import { type ModelCheck, VerifierOutput, verifierMessage } from "./verify.ts";

// The worker job steps that `t3_job` and reconcile run (docs/architecture.md, flows 1 and 3).
// They read and write the ledger, so a re-run step or a new session continues from the job row.

export interface WorkerModel {
  providerId: string;
  model: string;
}

export interface JobDeps {
  sql: Sql;
  worker: WorkerAdapter;
  // The model worker threads run. Without it the worker project's default applies, and T3
  // refuses a launch in a project that has none.
  workerModel?: WorkerModel;
  // Sends Sym's own posts right after a step enqueues them. Without it, posts wait for the
  // delivery schedule.
  slack?: SlackApi;
  // The adopter pack. With one, jobs run only in its projects and under its rules (decision 026).
  pack?: Pack;
  now?: () => Date;
}

// The ledger and Slack part of JobDeps, for steps that do not call the worker.
export type LedgerDeps = Pick<JobDeps, "sql" | "slack" | "now" | "pack">;

// The Slack status line shows at most 50 characters (docs/slack.md).
export const STATUS_LINE_MAX = 50;
const SUMMARY_MAX = 200;
// Pages of new activity one check reads before it records progress.
const MAX_ACTIVITY_PAGES = 10;
// With the job ID, the key of the advisory lock that serializes launches of one job.
const LAUNCH_LOCK = 4_242_002;
// A watcher holds a job this long after each check. Reconcile takes over when it runs out. It
// is longer than the t3_job poll interval, so a healthy task keeps its job.
export const WATCH_LEASE_MS = 10 * 60_000;

const TERMINAL: readonly JobStatus[] = ["done", "failed", "cancelled"];

// A launch that retrying cannot fix: an unknown project or a model the worker does not offer.
export class JobSetupError extends Error {
  override name = "JobSetupError";
}

// Parses `<provider>/<model>`, for example `codex/gpt-6-luna`.
export function parseWorkerModel(value: string | undefined): WorkerModel | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  const slash = text.indexOf("/");
  if (slash <= 0 || slash === text.length - 1) {
    throw new JobSetupError(`SYM_WORKER_MODEL must look like <provider>/<model>, not "${text}".`);
  }
  return { providerId: text.slice(0, slash), model: text.slice(slash + 1) };
}

export function threadTitle(job: Pick<Job, "id" | "title">): string {
  return `[${jobRef(job.id)}] ${job.title}`;
}

export interface StartJobInput {
  // Stays the same when the step re-runs, such as the Eve tool call ID.
  requestKey: string;
  sessionId?: string;
  kind?: string;
  brief: Brief;
}

// Records a job, or returns the one an earlier run of the same call recorded. The job takes the
// Slack thread its session talks in, so its posts go there even after the session ends.
export async function startJob(sql: Sql, input: StartJobInput): Promise<Job> {
  const thread = input.sessionId ? await getSessionThread(sql, input.sessionId) : undefined;
  return createJob(sql, {
    requestKey: input.requestKey,
    kind: input.kind ?? "code-change",
    title: input.brief.title,
    brief: input.brief,
    worker: "t3",
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(thread
      ? {
          slackChannel: thread.channelId,
          ...(thread.threadTs ? { slackThreadTs: thread.threadTs } : {}),
          ...(thread.userId ? { owner: thread.userId } : {}),
        }
      : {}),
  });
}

// Starts the worker thread for a job, or adopts the one an earlier attempt started. T3 has no
// retry key for a launch, so the title starts with the job reference and a lookup runs first.
// Eve can run two copies of one call, so a lock per job lets only one of them launch.
export async function launchOrAdopt(deps: JobDeps, jobId: number, callbackUrl: string) {
  const lock = await deps.sql.reserve();
  let launched: Job;
  try {
    await lock`select pg_advisory_lock(${LAUNCH_LOCK}, ${jobId})`;
    const job = await mustGetJob(deps.sql, jobId);
    if (job.workerThreadId) return job;

    const plan = await planLaunch(deps, Brief.parse(job.brief));
    if (deps.workerModel) await checkModel(deps.worker, deps.workerModel);
    const existing = await deps.worker.findByTitle(plan.projectId, `[${jobRef(job.id)}]`);
    const thread =
      existing ??
      (await deps.worker.launch({
        projectId: plan.projectId,
        title: threadTitle(job),
        message: workerMessage(plan.brief, jobRef(job.id), callbackUrl, plan.guardrails),
        baseRef: plan.baseRef,
        ...(deps.workerModel ? { model: deps.workerModel } : {}),
      }));
    const projectId = plan.projectId;

    launched = await updateJob(deps.sql, job.id, {
      status: "running",
      workerProjectId: projectId,
      workerThreadId: thread.id,
      startedAt: job.startedAt ?? now(deps),
    });
  } finally {
    await lock`select pg_advisory_unlock(${LAUNCH_LOCK}, ${jobId})`.catch(() => {});
    lock.release();
  }

  await renewWatch(deps.sql, launched.id, WATCH_LEASE_MS);
  const presented = await presentStart(deps.sql, launched, now(deps), deps.pack);
  await deliverNow(deps);
  return presented;
}

export interface JobCheck {
  // `checking` means the worker finished and the result waits for the model check. The caller
  // runs the `verifier` subagent and then calls finishJob.
  status: JobStatus;
  summary: string;
  terminal: boolean;
  // The newest worker message, when the job ends. It holds the output contract block.
  lastMessage: string | null;
  // Questions the worker agent waits on. The caller asks a person and calls answerQuestion.
  questions: WorkerQuestion[];
}

export interface CheckOptions {
  // A finished code job moves to `checking` instead of `done`, so the caller can run the model
  // check (flow 4, decision 032). A scheduled check never does: it stays cheap and silent.
  verify?: boolean;
}

// Waits briefly for the worker, reads new activity from the job's cursor, records it, and
// presents it in Slack.
export async function checkJob(
  deps: JobDeps,
  jobId: number,
  waitMs: number,
  options: CheckOptions = {},
): Promise<JobCheck> {
  const job = await mustGetJob(deps.sql, jobId);
  if (!job.workerThreadId) throw new Error(`${jobRef(job.id)} has no worker thread`);
  // A job in `checking` has nothing more to read from the worker.
  if (TERMINAL.includes(job.status) || job.status === "checking") return toCheck(job, []);

  await deps.worker.wait(job.workerThreadId, waitMs);
  const activity = await readNewActivity(deps.worker, job.workerThreadId, job.cursor);
  // A waiting worker asks a question or waits on a permission prompt. Only questions are listed.
  const questions =
    activity.status === "waiting"
      ? await deps.worker.pendingQuestions(job.workerThreadId).catch(() => [])
      : [];
  const worked = toJobStatus(activity.status, questions.length > 0, job.status);
  const verify = options.verify === true && job.kind !== SCHEDULED_CHECK;
  const status: JobStatus = worked === "done" && verify ? "checking" : worked;
  const at = now(deps);
  const progress = detectEvents(
    {
      status: job.status,
      prUrl: job.prUrl,
      quietSince: (job.lastActivityAt ?? job.startedAt ?? job.createdAt).getTime(),
      ...(job.quietNoticedAt ? { lastQuietPostAt: job.quietNoticedAt.getTime() } : {}),
    },
    { status, newItems: activity.items, now: at.getTime() },
  );
  const latest = latestText(activity.items);
  const message = latestAssistant(activity.items);
  const summary =
    status === "failed" && activity.status === "interrupted"
      ? "Worker thread interrupted"
      : status === "waiting_permission"
        ? "Waiting for a permission prompt on the worker"
        : (firstLine(latest) ?? job.lastSummary ?? "Working");

  const updated = await updateJob(deps.sql, job.id, {
    status,
    cursor: activity.cursor,
    lastSummary: summary.slice(0, SUMMARY_MAX),
    // Kept on the row: the final message can arrive in an earlier check than the final status.
    ...(message ? { lastMessage: message } : {}),
    ...(progress.state.prUrl ? { prUrl: progress.state.prUrl } : {}),
    ...(activity.items.length > 0 ? { lastActivityAt: at } : {}),
    ...(progress.state.lastQuietPostAt
      ? { quietNoticedAt: new Date(progress.state.lastQuietPostAt) }
      : {}),
  });

  await presentProgress(
    deps.sql,
    updated,
    progress.events,
    `${activity.cursor}-${status}`,
    at,
    deps.pack,
  );
  if (TERMINAL.includes(updated.status)) {
    await presentEnd(deps.sql, updated, parseOutputContract(updated.lastMessage), at, deps.pack);
  } else {
    await renewWatch(deps.sql, updated.id, WATCH_LEASE_MS);
  }
  await deliverNow(deps);
  return toCheck(updated, status === "waiting_input" ? questions : []);
}

// The input for the `verifier` subagent, or nothing when the job is not waiting on a model
// check or the worker sent no result block to check.
export async function verifierRequest(deps: LedgerDeps, jobId: number): Promise<string | null> {
  const job = await mustGetJob(deps.sql, jobId);
  if (job.status !== "checking") return null;
  const contract = parseOutputContract(job.lastMessage);
  if (!contract) return null;
  const brief = Brief.parse(job.brief);
  return verifierMessage({
    goal: brief.goal,
    doneWhen: brief.doneWhen,
    constraints: brief.constraints,
    contract,
    concerns: endConcerns(job, contract, deps.pack),
    workerMessage: job.lastMessage,
  });
}

export interface FinishedJob extends JobCheck {
  // Every concern the result message lists. The schedule run outcome uses the same list.
  concerns: string[];
}

// Ends a job in `checking` as done and posts its one result message with the model check's
// verdict merged in (flow 4, decision 032). `check` is the verifier's reply, an unavailable
// check, or nothing for the rule checks alone. A job that already ended posts nothing again.
export async function finishJob(
  deps: LedgerDeps,
  jobId: number,
  check?: ModelCheck,
): Promise<FinishedJob> {
  const job = await mustGetJob(deps.sql, jobId);
  const contract = parseOutputContract(job.lastMessage);
  const model = parseModelCheck(check);
  if (job.status !== "checking") {
    return { ...toCheck(job, []), concerns: endConcerns(job, contract, deps.pack, model) };
  }
  const ended = await updateJob(deps.sql, job.id, { status: "done" });
  await presentEnd(deps.sql, ended, contract, now(deps), deps.pack, model);
  await deliverNow(deps);
  return { ...toCheck(ended, []), concerns: endConcerns(ended, contract, deps.pack, model) };
}

// The reply crossed the workflow boundary, so check its shape again. A malformed reply counts
// as an unavailable check.
function parseModelCheck(check: ModelCheck | undefined): ModelCheck | undefined {
  if (check?.status !== "checked") return check;
  const output = VerifierOutput.safeParse(check.output);
  return output.success
    ? { status: "checked", output: output.data }
    : { status: "unavailable", reason: "The verifier reply had the wrong shape." };
}

// Sends a person's answer to the worker agent's question.
export async function answerQuestion(
  deps: JobDeps,
  jobId: number,
  requestId: string,
  answers: WorkerAnswers,
): Promise<void> {
  const job = await mustGetJob(deps.sql, jobId);
  if (!job.workerThreadId) throw new Error(`${jobRef(job.id)} has no worker thread`);
  // T3 has no retry key for an answer. A re-run step finds the question gone and stops.
  const pending = await deps.worker.pendingQuestions(job.workerThreadId);
  if (!pending.some((question) => question.requestId === requestId)) return;
  await deps.worker.answer(job.workerThreadId, requestId, answers);
  await updateJob(deps.sql, job.id, {
    status: "running",
    lastSummary: "Answer sent to the worker",
  });
}

// Stops the worker thread and records the job as cancelled. A job in `checking` already has its
// result, so it ends as done with the rule checks alone.
export async function cancelJob(deps: JobDeps, jobId: number): Promise<JobCheck> {
  const job = await mustGetJob(deps.sql, jobId);
  if (job.status === "checking") {
    const { concerns: _concerns, ...check } = await finishJob(deps, jobId);
    return check;
  }
  if (job.workerThreadId && !TERMINAL.includes(job.status)) {
    await deps.worker.interrupt(job.workerThreadId, "Cancelled in Sym", `cancel-${jobRef(job.id)}`);
  }
  return endWithoutWorker(deps, job, "cancelled", "Cancelled");
}

// Records a job whose task failed, so the ledger does not show it as still running. A job in
// `checking` already has its result, so it ends as done without the model check.
export async function failJob(deps: LedgerDeps, jobId: number, reason: string): Promise<JobStatus> {
  const job = await mustGetJob(deps.sql, jobId);
  if (job.status === "checking") {
    return (await finishJob(deps, jobId, { status: "unavailable", reason })).status;
  }
  return (await endWithoutWorker(deps, job, "failed", reason)).status;
}

// Marks a pre-approved scheduled run, which posts only when something needs attention.
export async function markScheduledCheck(sql: Sql, jobId: number): Promise<void> {
  await sql`update jobs set kind = ${SCHEDULED_CHECK} where id = ${jobId}`;
}

// Shows the owner the full brief in the job thread before the Start prompt.
export async function showBrief(deps: LedgerDeps, jobId: number): Promise<void> {
  const job = await mustGetJob(deps.sql, jobId);
  await presentBrief(deps.sql, job);
  await deliverNow(deps);
}

// Ends a job before it launched, for example when the owner cancels or edits the brief.
export async function closeUnlaunched(deps: LedgerDeps, jobId: number, reason: string) {
  const job = await mustGetJob(deps.sql, jobId);
  // Nothing posted for this job yet, so ending it posts nothing either.
  return updateJob(deps.sql, job.id, {
    status: "cancelled",
    lastSummary: reason.slice(0, SUMMARY_MAX),
  });
}

async function endWithoutWorker(
  deps: LedgerDeps,
  job: Job,
  status: "failed" | "cancelled",
  reason: string,
): Promise<JobCheck> {
  const wasRunning = !TERMINAL.includes(job.status);
  const ended = await updateJob(deps.sql, job.id, {
    status,
    lastSummary: reason.slice(0, SUMMARY_MAX),
  });
  if (wasRunning && ended.workerThreadId) {
    await presentEnd(deps.sql, ended, null, now(deps), deps.pack);
    await deliverNow(deps);
  }
  return toCheck(ended, []);
}

export function statusLine(ref: string, summary: string): string {
  const line = `${ref}: ${summary.trim()}`;
  return line.length <= STATUS_LINE_MAX ? line : `${line.slice(0, STATUS_LINE_MAX - 1)}…`;
}

function toCheck(job: Job, questions: WorkerQuestion[]): JobCheck {
  const terminal = TERMINAL.includes(job.status);
  return {
    status: job.status,
    summary: job.lastSummary ?? "",
    terminal,
    lastMessage: terminal || job.status === "checking" ? job.lastMessage : null,
    questions,
  };
}

// Delivery failures never fail a job step. The delivery schedule sends what is left.
async function deliverNow(deps: LedgerDeps): Promise<void> {
  if (!deps.slack) return;
  await deliver(deps.sql, deps.slack).catch(() => {});
}

function now(deps: LedgerDeps): Date {
  return deps.now?.() ?? new Date();
}

// Reads every new item since the cursor, up to a page limit, and keeps the newest state.
async function readNewActivity(
  worker: WorkerAdapter,
  threadId: string,
  cursor: string | null,
): Promise<Activity> {
  let activity = await worker.readActivity(threadId, cursor);
  const items = [...activity.items];
  for (let page = 1; activity.hasMore && page < MAX_ACTIVITY_PAGES; page++) {
    activity = await worker.readActivity(threadId, activity.cursor);
    items.push(...activity.items);
  }
  return { ...activity, items };
}

// Worker states to job states. `unknown` keeps the current state, so a brief gap in the worker's
// answer does not end a job.
function toJobStatus(worker: WorkerStatus, hasQuestion: boolean, current: JobStatus): JobStatus {
  switch (worker) {
    case "running":
      return "running";
    case "waiting":
      return hasQuestion ? "waiting_input" : "waiting_permission";
    case "completed":
      return "done";
    case "failed":
    case "interrupted":
      return "failed";
    case "unknown":
      return current;
  }
}

const withText = (items: ActivityItem[]) => items.filter((item) => item.text.trim() !== "");

function latestAssistant(items: ActivityItem[]): string | undefined {
  return withText(items).findLast((item) => item.type === "assistant_message")?.text;
}

function latestText(items: ActivityItem[]): string | undefined {
  return latestAssistant(items) ?? withText(items).at(-1)?.text;
}

function firstLine(text: string | undefined): string | undefined {
  return text?.split("\n").find((line) => line.trim() !== "");
}

interface LaunchPlan {
  projectId: string;
  baseRef: string;
  // The brief as the worker gets it: a pack can turn a requested PR off.
  brief: Brief;
  guardrails?: string[];
}

// Applies the pack, when there is one: only its projects, its base branch, its PR policy, and
// its guardrails. A pack narrows what a brief may ask for; it never widens it.
async function planLaunch(deps: JobDeps, brief: Brief): Promise<LaunchPlan> {
  if (!deps.pack) {
    return {
      projectId: await resolveProject(deps.worker, brief.project),
      baseRef: brief.baseRef ?? "main",
      brief,
    };
  }
  const allowed = resolvePackProject(deps.pack, brief.project);
  if (!allowed.ok) throw new JobSetupError(allowed.reason);
  const openPullRequest = brief.openPullRequest && allowed.project.prPolicy === "draft";
  return {
    projectId: await resolveProject(deps.worker, allowed.workerProject),
    baseRef: brief.baseRef ?? allowed.project.defaultBaseBranch,
    brief: { ...brief, openPullRequest },
    guardrails: briefGuardrails(deps.pack, allowed.project),
  };
}

async function resolveProject(worker: WorkerAdapter, project: string): Promise<string> {
  const projects = await worker.projects();
  const wanted = project.trim().toLowerCase();
  const match =
    projects.find((p) => p.id === project) ??
    projects.find((p) => p.title.toLowerCase() === wanted);
  if (!match) throw new JobSetupError(`The worker has no project "${project}".`);
  return match.id;
}

// The worker reports its providers and models before each launch (docs/workers.md).
async function checkModel(worker: WorkerAdapter, choice: WorkerModel): Promise<void> {
  const { providers } = await worker.capabilities();
  const provider = providers.find((p) => p.id === choice.providerId);
  if (!provider?.available || !provider.models.includes(choice.model)) {
    throw new JobSetupError(
      `The worker does not offer ${choice.providerId}/${choice.model}. Run pnpm t3:check.`,
    );
  }
}

async function mustGetJob(sql: Sql, jobId: number): Promise<Job> {
  const job = await getJob(sql, jobId);
  if (!job) throw new Error(`no job ${jobRef(jobId)}`);
  return job;
}
