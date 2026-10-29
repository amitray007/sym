import type { Sql } from "../db.ts";
import { deliver } from "../delivery/deliver.ts";
import {
  createJob,
  getJob,
  type Job,
  type JobStatus,
  jobRef,
  renewWatch,
  StaleJobError,
  updateJob,
} from "../ledger/jobs.ts";
import { getSessionThread } from "../ledger/threads.ts";
import type { Pack } from "../pack/load.ts";
import { briefGuardrails, resolvePackProject, workerModelList } from "../pack/policy.ts";
import {
  type AllowedProject,
  allowedProjects,
  checkProject,
  findAllowedProject,
  matchWorkerProject,
} from "../projects/allowed.ts";
import type { SlackApi } from "../slack/api.ts";
import { workerLabel, workerNoun } from "../worker-label.ts";
import {
  briefModelLine,
  chooseModel,
  type ModelList,
  resolveAvailable,
} from "../workers/models.ts";
import type {
  Activity,
  ActivityItem,
  PullRequestFacts,
  WorkerAdapter,
  WorkerAnswers,
  WorkerQuestion,
  WorkerStatus,
} from "../workers/types.ts";
import { Brief, workerMessage } from "./brief.ts";
import { formatDuration } from "./card.ts";
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
import { finishQuestionPresentation, presentQuestions } from "./questions.ts";
import { type ModelCheck, VerifierOutput, verifierMessage } from "./verify.ts";
import { workerCallbackInstructions } from "./worker-capabilities.ts";
import { WriterOutput, writerMessage } from "./writer.ts";

// The worker job steps that `worker_job` and reconcile run (docs/architecture.md, flows 1 and 3).
// They read and write the ledger, so a re-run step or a new session continues from the job row.

export interface WorkerModel {
  providerId: string;
  model: string;
}

export interface JobDeps {
  sql: Sql;
  worker: WorkerAdapter;
  // SYM_WORKER_MODEL: the default entry of the worker's model list (decision 041).
  workerModel?: WorkerModel;
  // Sends Sym's own posts right after a step enqueues them. Without it, posts wait for the
  // delivery schedule.
  slack?: SlackApi;
  // The adopter pack. With one, jobs run only in its projects and under its rules (decision 026).
  pack?: Pack;
  // The pack worker this process is connected to. A pack project on another worker is refused.
  workerName?: string;
  // Name and endpoint of the connected worker, without credentials, for safe thread reuse.
  workerIdentity?: string | undefined;
  // The projects Sym may touch (decision 042). Without it, the pack's projects apply, and
  // without a pack nothing is allowed.
  allowedProjects?: AllowedProject[];
  now?: () => Date;
}

// The ledger and Slack part of JobDeps, for steps that do not call the worker.
export type LedgerDeps = Pick<
  JobDeps,
  "sql" | "slack" | "now" | "pack" | "workerModel" | "allowedProjects"
>;

// The Slack status line shows at most 50 characters (docs/slack.md).
export const STATUS_LINE_MAX = 50;
const SUMMARY_MAX = 200;
// The stored last message keeps this many characters from its end, where the result block is.
const MESSAGE_MAX = 20_000;
// Pages of new activity one check reads before it records progress.
const MAX_ACTIVITY_PAGES = 10;
// With the job ID, the key of the advisory lock that serializes launches of one job.
const LAUNCH_LOCK = 4_242_002;
// A watcher holds a job this long after each check. Reconcile takes over when it runs out. It
// is longer than the worker_job poll interval, so a healthy task keeps its job.
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
  let note: string | undefined;
  try {
    await lock`select pg_advisory_lock(${LAUNCH_LOCK}, ${jobId})`;
    // Reads and writes under the lock use the reserved connection. Taking another pooled
    // connection while holding this one could deadlock the pool under concurrent launches.
    const job = await mustGetJob(lock, jobId);
    if (job.workerThreadId) return job;
    if (TERMINAL.includes(job.status)) throw new JobSetupError("This job already ended.");

    if (job.workerIdentity && job.workerIdentity !== deps.workerIdentity) {
      throw new JobSetupError("The worker changed before this job could start. Ask for a new job.");
    }

    const plan = await planLaunch(deps, Brief.parse(job.brief));
    if (job.workerProjectId && job.workerProjectId !== plan.projectId) {
      throw new JobSetupError(
        "The worker project changed before this job could start. Ask for a new job.",
      );
    }
    const model = resolveAvailable(
      plan.models,
      chooseModel(plan.models, {
        projectModel: plan.projectModel,
        briefModel: plan.brief.model,
      }),
      await deps.worker.capabilities(),
    );
    const existing = await deps.worker.findByTitle(plan.projectId, `[${jobRef(job.id)}]`);
    if (existing && deps.workerIdentity && !job.workerIdentity) {
      throw new JobSetupError("This thread's worker is unknown. Ask for a new job.");
    }
    if (!job.workerIdentity && deps.workerIdentity) {
      // Persist before launch, so recovery can prove which worker owns a lost-response thread.
      await updateJob(lock, job.id, {
        workerIdentity: deps.workerIdentity,
        workerProjectId: plan.projectId,
      });
    }
    const callbackTools = await workerCallbackInstructions(
      lock,
      job.id,
      new URL("/eve/v1/mcp", callbackUrl).href,
    );
    const thread =
      existing ??
      (await deps.worker.launch({
        projectId: plan.projectId,
        title: threadTitle(job),
        message: `${workerMessage(plan.brief, jobRef(job.id), callbackUrl, plan.guardrails)}\n\n${callbackTools}`,
        baseRef: plan.baseRef,
        ...(model.selection ? { model: model.selection } : {}),
      }));
    const projectId = plan.projectId;

    launched = await updateJob(lock, job.id, {
      status: "running",
      workerProjectId: projectId,
      workerThreadId: thread.id,
      workerModel: model.entry?.id ?? null,
      ...(model.note ? { lastSummary: model.note.slice(0, SUMMARY_MAX) } : {}),
      startedAt: job.startedAt ?? now(deps),
    });
    note = model.note;
  } finally {
    await lock`select pg_advisory_unlock(${LAUNCH_LOCK}, ${jobId})`.catch(() => {});
    lock.release();
  }

  await renewWatch(deps.sql, launched.id, WATCH_LEASE_MS);
  const presented = await presentStart(deps.sql, launched, now(deps), deps.pack, note);
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
  // A finished code job also moves to `checking` so the caller can have the `writer` subagent
  // write its result (decision 062).
  write?: boolean;
  // How long this check holds the job's watch. A task holds it for WATCH_LEASE_MS between its
  // polls; reconcile holds it for less than its own interval, so its next pass checks again.
  leaseMs?: number;
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
    activity.status === "waiting" ? await deps.worker.pendingQuestions(job.workerThreadId) : [];
  const worked = toJobStatus(activity.status, questions.length > 0, job.status);
  const hold = (options.verify === true || options.write === true) && job.kind !== SCHEDULED_CHECK;
  const status: JobStatus = worked === "done" && hold ? "checking" : worked;
  // Read once, as the code job ends, and keep it on the row (decision 057). A scheduled check
  // skips it, like it skips the model check.
  const prFacts =
    worked === "done" && job.kind !== SCHEDULED_CHECK
      ? await readPullRequests(deps.worker, job.workerThreadId)
      : undefined;
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
  const latest = latestAssistant(activity.items);
  const message = await wholeMessage(
    deps.worker,
    job.workerThreadId,
    latestAssistantItem(activity.items),
  );
  const summary =
    status === "failed" && activity.status === "interrupted"
      ? `${workerLabel()} thread interrupted`
      : status === "waiting_permission"
        ? `Waiting for a permission prompt on the ${workerNoun()}`
        : (firstLine(latest) ?? job.lastSummary ?? "Working");

  // Two watchers can check one job (a task and reconcile). The update applies only while the
  // cursor is the one this check read; otherwise the newer check already recorded more.
  const updated = await updateJob(
    deps.sql,
    job.id,
    {
      status,
      cursor: activity.cursor,
      lastSummary: summary.slice(0, SUMMARY_MAX),
      // Kept on the row: the final message can arrive in an earlier check than the final status.
      ...(message ? { lastMessage: message } : {}),
      ...(prFacts ? { prFacts } : {}),
      ...(progress.state.prUrl ? { prUrl: progress.state.prUrl } : {}),
      ...(activity.items.length > 0 ? { lastActivityAt: at } : {}),
      ...(progress.state.lastQuietPostAt
        ? { quietNoticedAt: new Date(progress.state.lastQuietPostAt) }
        : {}),
    },
    { revision: job.revision },
  ).catch(async (error: unknown) => {
    if (error instanceof StaleJobError) return undefined;
    throw error;
  });
  if (!updated) return toCheck(await mustGetJob(deps.sql, job.id), []);

  await presentProgress(
    deps.sql,
    updated,
    progress.events,
    `${activity.cursor}-${status}`,
    at,
    deps.pack,
  );
  await presentQuestions(deps, updated, questions);
  if (TERMINAL.includes(updated.status)) {
    await presentEnd(deps.sql, updated, parseOutputContract(updated.lastMessage), at, deps.pack);
  } else {
    await renewWatch(deps.sql, updated.id, options.leaseMs ?? WATCH_LEASE_MS);
  }
  await deliverNow(deps);
  return toCheck(updated, status === "waiting_input" ? questions : []);
}

// The pull requests the worker lists for the thread, or nothing when it cannot say: the worker
// has no such call or the call fails. The checks that need them then do not run.
async function readPullRequests(
  worker: WorkerAdapter,
  threadId: string,
): Promise<PullRequestFacts[] | undefined> {
  if (!worker.pullRequests) return undefined;
  try {
    return await worker.pullRequests(threadId);
  } catch {
    return undefined;
  }
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
    pullRequests: job.prFacts,
  });
}

// The input for the `writer` subagent (decision 062), or nothing when the job is not waiting in
// `checking` or the worker sent no result block. `voice` is the persona and the learned rows;
// the caller reads them, because the persona files need Node.js builtins. `check` is the model
// check, so the writer sees its concerns too.
export async function writerRequest(
  deps: LedgerDeps,
  jobId: number,
  voice: { persona: string | null; learned: string | null },
  check?: ModelCheck,
): Promise<string | null> {
  const job = await mustGetJob(deps.sql, jobId);
  if (job.status !== "checking") return null;
  const contract = parseOutputContract(job.lastMessage);
  if (!contract) return null;
  const brief = Brief.parse(job.brief);
  const started = job.startedAt ?? job.createdAt;
  return writerMessage({
    ref: jobRef(job.id),
    title: job.title,
    project: brief.project,
    goal: brief.goal,
    duration: formatDuration(now(deps).getTime() - started.getTime()),
    persona: voice.persona,
    learned: voice.learned,
    contract,
    prUrl: contract.prUrl ?? job.prUrl,
    concerns: endConcerns(job, contract, deps.pack, parseModelCheck(check)),
    workerMessage: job.lastMessage,
  });
}

export interface FinishedJob extends JobCheck {
  // Every concern the result message lists. The schedule run outcome uses the same list.
  concerns: string[];
}

// Ends a job in `checking` as done and posts its one result message with the model check's
// verdict merged in (flow 4, decision 032). `check` is the verifier's reply, an unavailable
// check, or nothing for the rule checks alone. `written` is the writer's text (decision 062),
// or nothing for the template. A job that already ended posts nothing again.
export async function finishJob(
  deps: LedgerDeps,
  jobId: number,
  check?: ModelCheck,
  written?: string | WriterOutput,
): Promise<FinishedJob> {
  const job = await mustGetJob(deps.sql, jobId);
  const contract = parseOutputContract(job.lastMessage);
  const model = parseModelCheck(check);
  // The text crossed the workflow boundary, so check its shape again; a bad one gets the template.
  const text = WriterOutput.safeParse(
    typeof written === "string" ? { text: written } : written,
  ).data;
  if (job.status !== "checking") {
    return { ...toCheck(job, []), concerns: endConcerns(job, contract, deps.pack, model) };
  }
  // Keep the model check on the row before the job is done, so a crash before the end post still
  // lets reconcile post the full verdict.
  const ended = await updateJob(deps.sql, job.id, {
    status: "done",
    ...(model ? { verdict: model } : {}),
  });
  await presentEnd(deps.sql, ended, contract, now(deps), deps.pack, model, text);
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
): Promise<boolean> {
  const sent = await deps.sql.begin(async (transaction) => {
    const sql = transaction as unknown as Sql;
    await sql`select id from jobs where id = ${jobId} for update`;
    const job = await mustGetJob(sql, jobId);
    if (!job.workerThreadId || TERMINAL.includes(job.status) || job.status === "checking")
      return false;
    const pending = await deps.worker.pendingQuestions(job.workerThreadId);
    const question = pending.find((question) => question.requestId === requestId);
    if (!question) return false;
    const ids = question.questions.map((part) => part.id);
    if (
      ids.length !== Object.keys(answers).length ||
      ids.some((id) => {
        const value = answers[id];
        return Array.isArray(value)
          ? value.length === 0 || value.some((v) => !v.trim())
          : !value?.trim();
      })
    ) {
      throw new Error("Please answer each part of the worker's question.");
    }
    await deps.worker.answer(job.workerThreadId, requestId, answers);
    await sql`update job_questions set answered_at = now() where job_id = ${jobId} and request_id = ${requestId}`;
    await finishQuestionPresentation(sql, job, requestId);
    await updateJob(sql, jobId, {
      status: "running",
      lastSummary: `I passed your answer to the ${workerNoun()}.`,
    });
    return true;
  });
  if (sent) await deliverNow(deps);
  return sent;
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
// A launched job keeps running on the worker even when its watcher fails, so it is not marked
// failed: the watcher lease ends at once, and reconcile takes the job over on its next pass.
export async function failJob(deps: LedgerDeps, jobId: number, reason: string): Promise<JobStatus> {
  const job = await mustGetJob(deps.sql, jobId);
  if (job.status === "checking") {
    return (await finishJob(deps, jobId, { status: "unavailable", reason })).status;
  }
  if (job.workerThreadId && !TERMINAL.includes(job.status)) {
    await deps.sql`update jobs set watch_until = null where id = ${job.id}`;
    return job.status;
  }
  return (await endWithoutWorker(deps, job, "failed", reason)).status;
}

// Marks a pre-approved scheduled run, which posts only when something needs attention.
export async function markScheduledCheck(sql: Sql, jobId: number): Promise<void> {
  await sql`update jobs set kind = ${SCHEDULED_CHECK} where id = ${jobId}`;
}

// Shows the owner the short brief in the job thread before the Start prompt (decision 060).
// `trustedPlaybook` names the trusted playbook when the job starts without the click.
export async function showBrief(
  deps: LedgerDeps,
  jobId: number,
  trustedPlaybook?: string,
): Promise<void> {
  const job = await mustGetJob(deps.sql, jobId);
  const brief = Brief.parse(job.brief);
  const { models, projectModel } = modelsFor(deps, brief.project);
  const line = briefModelLine(models, {
    projectModel,
    briefModel: brief.model,
    ...(brief.modelReason ? { reason: brief.modelReason } : {}),
  });
  // The owner sees which playbook a brief follows before trusting it (decision 059).
  const [linked] = await deps.sql<{ name: string }[]>`
    select p.name from jobs j join playbooks p on p.id = j.playbook_id where j.id = ${job.id}
  `;
  await presentBrief(
    deps.sql,
    job,
    brief.modelReason &&
      chooseModel(models, { projectModel, briefModel: brief.model }).entry.id !== models.defaultId
      ? line
      : undefined,
    linked ? { name: linked.name, trusted: trustedPlaybook === linked.name } : undefined,
  );
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

export async function endWithoutWorker(
  deps: LedgerDeps,
  job: Job,
  status: "failed" | "cancelled",
  reason: string,
): Promise<JobCheck> {
  const wasRunning = !TERMINAL.includes(job.status);
  if (!wasRunning) return toCheck(job, []);
  let ended: Job;
  try {
    ended = await updateJob(
      deps.sql,
      job.id,
      { status, lastSummary: reason.slice(0, SUMMARY_MAX) },
      { revision: job.revision },
    );
  } catch (error) {
    if (!(error instanceof StaleJobError)) throw error;
    return endWithoutWorker(deps, await mustGetJob(deps.sql, job.id), status, reason);
  }
  if (wasRunning && ended.slackChannel) {
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
    summary: job.status === "checking" ? "Checking the result" : (job.lastSummary ?? ""),
    terminal,
    lastMessage: terminal || job.status === "checking" ? job.lastMessage : null,
    questions,
  };
}

// Delivery failures never fail a job step. The delivery schedule sends what is left.
export async function deliverNow(deps: LedgerDeps): Promise<void> {
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

function latestAssistantItem(items: ActivityItem[]): ActivityItem | undefined {
  return withText(items).findLast((item) => item.type === "assistant_message");
}

function latestAssistant(items: ActivityItem[]): string | undefined {
  return latestAssistantItem(items)?.text;
}

// The worker's newest message, read whole when the worker cut it: its result block comes last.
// A long message keeps its end. A failed read keeps the cut text, so the job still moves on.
async function wholeMessage(
  worker: WorkerAdapter,
  threadId: string,
  item: ActivityItem | undefined,
): Promise<string | undefined> {
  if (!item?.rest || !worker.readRest) return item?.text;
  try {
    const text = item.text + (await worker.readRest(threadId, item.rest.itemId, item.rest.offset));
    return text.length <= MESSAGE_MAX ? text : `…${text.slice(-(MESSAGE_MAX - 1))}`;
  } catch (error) {
    console.warn("Sym could not read the rest of the worker message.", String(error));
    return item.text;
  }
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
  // The worker's model list, and the model the pack pins for the project.
  models: ModelList;
  projectModel?: string;
}

// Applies the pack, when there is one: only its projects, its base branch, its PR policy, and
// its guardrails. A pack narrows what a brief may ask for; it never widens it.
export async function planLaunch(deps: JobDeps, brief: Brief): Promise<LaunchPlan> {
  const envModel = envModelId(deps);
  // Checked again here, so a stored brief or schedule for a removed project fails closed.
  const list = deps.allowedProjects ?? allowedProjects(deps.pack);
  const refusal = checkProject(list, brief.project);
  if (refusal) throw new JobSetupError(refusal);
  const entry = findAllowedProject(list, brief.project);
  if (!deps.pack) {
    return {
      models: workerModelList(undefined, undefined, envModel),
      projectId: await resolveProject(deps.worker, entry?.workerProject ?? brief.project),
      baseRef: brief.baseRef ?? "main",
      brief,
    };
  }
  const allowed = resolvePackProject(deps.pack, brief.project);
  if (!allowed.ok) throw new JobSetupError(allowed.reason);
  // Sym connects to one worker at a time. A project the pack gives to another worker must not
  // run here, even when this worker has a project with the same name.
  const connected =
    deps.workerName ??
    (deps.pack.config.workers.length === 1 ? deps.pack.config.workers[0]?.name : undefined);
  if (allowed.worker.name !== connected) {
    throw new JobSetupError(
      `"${brief.project}" runs on worker "${allowed.worker.name}", but Sym is connected to ${
        connected ? `"${connected}"` : "an unnamed worker"
      }.`,
    );
  }
  const openPullRequest = brief.openPullRequest && allowed.project.prPolicy === "draft";
  return {
    models: workerModelList(deps.pack, allowed.worker.name, envModel),
    ...(allowed.project.model ? { projectModel: allowed.project.model } : {}),
    projectId: await resolveProject(deps.worker, allowed.workerProject),
    baseRef: brief.baseRef ?? allowed.project.defaultBaseBranch,
    brief: { ...brief, openPullRequest },
    guardrails: briefGuardrails(deps.pack, allowed.project, openPullRequest),
  };
}

// The model list and the pinned model for a project, without the checks a launch makes.
function modelsFor(
  deps: Pick<JobDeps, "pack" | "workerModel" | "workerName">,
  project: string,
): { models: ModelList; projectModel?: string | undefined } {
  const envModel = envModelId(deps);
  const allowed = deps.pack ? resolvePackProject(deps.pack, project) : undefined;
  if (allowed?.ok) {
    return {
      models: workerModelList(deps.pack, allowed.worker.name, envModel),
      projectModel: allowed.project.model,
    };
  }
  return { models: workerModelList(deps.pack, deps.workerName, envModel) };
}

const envModelId = (deps: Pick<JobDeps, "workerModel">) =>
  deps.workerModel && `${deps.workerModel.providerId}/${deps.workerModel.model}`;

async function resolveProject(worker: WorkerAdapter, project: string): Promise<string> {
  const match = matchWorkerProject(await worker.projects(), project);
  if (!match) throw new JobSetupError(`The worker has no project "${project}".`);
  return match.id;
}

async function mustGetJob(sql: Sql, jobId: number): Promise<Job> {
  const job = await getJob(sql, jobId);
  if (!job) throw new Error(`no job ${jobRef(jobId)}`);
  return job;
}
