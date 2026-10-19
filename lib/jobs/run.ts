import type { Sql } from "../db.ts";
import { getJob, type Job, type JobStatus, jobRef, updateJob } from "../ledger/jobs.ts";
import type { Activity, ActivityItem, WorkerAdapter, WorkerStatus } from "../workers/types.ts";
import { Brief, workerMessage } from "./brief.ts";

// The worker job steps that `t3_job` runs (docs/architecture.md, flows 1 and 3). They read and
// write the ledger, so a re-run step or a new session continues from the job row.

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
}

// The Slack status line shows at most 50 characters (docs/slack.md).
export const STATUS_LINE_MAX = 50;
const SUMMARY_MAX = 200;
// Pages of new activity one check reads before it records progress.
const MAX_ACTIVITY_PAGES = 10;
// With the job ID, the key of the advisory lock that serializes launches of one job.
const LAUNCH_LOCK = 4_242_002;

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

// Starts the worker thread for a job, or adopts the one an earlier attempt started. T3 has no
// retry key for a launch, so the title starts with the job reference and a lookup runs first.
// Eve can run two copies of one call, so a lock per job lets only one of them launch.
export async function launchOrAdopt(deps: JobDeps, jobId: number, callbackUrl: string) {
  const lock = await deps.sql.reserve();
  try {
    await lock`select pg_advisory_lock(${LAUNCH_LOCK}, ${jobId})`;
    const job = await mustGetJob(deps.sql, jobId);
    if (job.workerThreadId) return job;

    const brief = Brief.parse(job.brief);
    const projectId = await resolveProject(deps.worker, brief.project);
    if (deps.workerModel) await checkModel(deps.worker, deps.workerModel);
    const existing = await deps.worker.findByTitle(projectId, `[${jobRef(job.id)}]`);
    const thread =
      existing ??
      (await deps.worker.launch({
        projectId,
        title: threadTitle(job),
        message: workerMessage(brief, jobRef(job.id), callbackUrl),
        baseRef: brief.baseRef,
        ...(deps.workerModel ? { model: deps.workerModel } : {}),
      }));

    return await updateJob(deps.sql, job.id, {
      status: "running",
      workerProjectId: projectId,
      workerThreadId: thread.id,
    });
  } finally {
    await lock`select pg_advisory_unlock(${LAUNCH_LOCK}, ${jobId})`.catch(() => {});
    lock.release();
  }
}

export interface JobCheck {
  status: JobStatus;
  summary: string;
  terminal: boolean;
  // The newest worker message, when the job ends. It holds the output contract block.
  lastMessage: string | null;
}

// Waits briefly for the worker, reads new activity from the job's cursor, and records it.
export async function checkJob(deps: JobDeps, jobId: number, waitMs: number): Promise<JobCheck> {
  const job = await mustGetJob(deps.sql, jobId);
  if (!job.workerThreadId) throw new Error(`${jobRef(job.id)} has no worker thread`);
  if (TERMINAL.includes(job.status)) return toCheck(job);

  await deps.worker.wait(job.workerThreadId, waitMs);
  const activity = await readNewActivity(deps.worker, job.workerThreadId, job.cursor);
  const status = toJobStatus(activity.status, job.status);
  const latest = latestText(activity.items);
  const message = latestAssistant(activity.items);
  const summary =
    status === "failed" && activity.status === "interrupted"
      ? "Worker thread interrupted"
      : (firstLine(latest) ?? job.lastSummary ?? "Working");

  const updated = await updateJob(deps.sql, job.id, {
    status,
    cursor: activity.cursor,
    lastSummary: summary.slice(0, SUMMARY_MAX),
    // Kept on the row: the final message can arrive in an earlier check than the final status.
    ...(message ? { lastMessage: message } : {}),
  });
  return toCheck(updated);
}

// Stops the worker thread and records the job as cancelled.
export async function cancelJob(deps: JobDeps, jobId: number): Promise<JobCheck> {
  const job = await mustGetJob(deps.sql, jobId);
  if (job.workerThreadId && !TERMINAL.includes(job.status)) {
    await deps.worker.interrupt(job.workerThreadId, "Cancelled in Sym", `cancel-${jobRef(job.id)}`);
  }
  return toCheck(
    await updateJob(deps.sql, job.id, { status: "cancelled", lastSummary: "Cancelled" }),
  );
}

// Records a job whose task failed, so the ledger does not show it as still running.
export async function failJob(sql: Sql, jobId: number, reason: string): Promise<void> {
  await updateJob(sql, jobId, { status: "failed", lastSummary: reason.slice(0, SUMMARY_MAX) });
}

export function statusLine(ref: string, summary: string): string {
  const line = `${ref}: ${summary.trim()}`;
  return line.length <= STATUS_LINE_MAX ? line : `${line.slice(0, STATUS_LINE_MAX - 1)}…`;
}

function toCheck(job: Job): JobCheck {
  const terminal = TERMINAL.includes(job.status);
  return {
    status: job.status,
    summary: job.lastSummary ?? "",
    terminal,
    lastMessage: terminal ? job.lastMessage : null,
  };
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
function toJobStatus(worker: WorkerStatus, current: JobStatus): JobStatus {
  switch (worker) {
    case "running":
      return "running";
    // Step 5 splits a question (waiting_input) from a permission prompt (waiting_permission).
    case "waiting":
      return "waiting_input";
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
