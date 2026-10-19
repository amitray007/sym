import type { JobStatus } from "../ledger/jobs.ts";

// The job card (docs/slack.md): one Slack `plan` block that Sym owns and edits with chat.update.
// These functions are pure. The watch loop and reconcile pass in the facts and do the posting.

export type StepStatus = "pending" | "in_progress" | "complete" | "error";

export interface RichText {
  type: "rich_text";
  elements: { type: "rich_text_section"; elements: { type: "text"; text: string }[] }[];
}

export interface CardStep {
  task_id: string;
  title: string;
  status: StepStatus;
  details?: RichText;
  output?: RichText;
}

export interface JobCardInput {
  status: JobStatus;
  /** The worker thread exists. */
  threadStarted: boolean;
  /** The done-when list of the brief. */
  doneWhen: string[];
  /** The latest worker summary. It shows under the working row. */
  latestSummary?: string | null;
}

const MAX_TASKS = 50;
const FIXED_ROWS = 4; // approved, thread started, working, check result
const MAX_TITLE = 150;

// Slack limits plan blocks to 50 tasks. Extra done-when items fold into one row.
const MAX_DONE_WHEN = MAX_TASKS - FIXED_ROWS;

function richText(text: string): RichText {
  return {
    type: "rich_text",
    elements: [{ type: "rich_text_section", elements: [{ type: "text", text }] }],
  };
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const WAITING_NOTE: Partial<Record<JobStatus, string>> = {
  waiting_input: "Waiting for you: the worker asked a question.",
  waiting_permission: "Waiting for you: approve a permission prompt on the worker.",
  quiet: "No new activity for a while.",
  worker_offline: "The worker is offline.",
  cancelled: "Cancelled.",
};

export function jobCardSteps(input: JobCardInput): CardStep[] {
  const { status, threadStarted } = input;
  const failed = status === "failed" || status === "cancelled";
  const done = status === "done";
  const checking = status === "checking";
  const workDone = done || checking;

  // A failure marks the row that was active: the thread row before launch, else the working row.
  const failedAtThread = failed && !threadStarted;
  const failedAtWork = failed && threadStarted;

  const thread: StepStatus = failedAtThread ? "error" : threadStarted ? "complete" : "in_progress";

  const working: StepStatus = failedAtWork
    ? "error"
    : workDone
      ? "complete"
      : threadStarted
        ? "in_progress"
        : "pending";

  const note = WAITING_NOTE[status];
  const summary = input.latestSummary ? clip(input.latestSummary, 300) : null;

  const workRow: CardStep = { task_id: "working", title: "Working", status: working };
  if (note && (threadStarted || failed)) workRow.details = richText(note);
  if (summary) workRow.output = richText(summary);

  const threadRow: CardStep = {
    task_id: "thread",
    title: "Worker thread started",
    status: thread,
  };
  if (failedAtThread && note) threadRow.details = richText(note);

  const listed = input.doneWhen.slice(0, MAX_DONE_WHEN);
  const doneRows: CardStep[] = listed.map((item, index) => ({
    task_id: `done-${index + 1}`,
    title: clip(item, MAX_TITLE),
    status: done ? "complete" : "pending",
  }));
  const hidden = input.doneWhen.length - listed.length;
  if (hidden > 0 && doneRows.length > 0) {
    doneRows[doneRows.length - 1] = {
      task_id: `done-${listed.length}`,
      title: `${clip(listed[listed.length - 1] ?? "", MAX_TITLE - 20)} (+${hidden} more)`,
      status: done ? "complete" : "pending",
    };
  }

  const check: StepStatus = done ? "complete" : checking ? "in_progress" : "pending";

  return [
    { task_id: "approved", title: "Brief approved", status: "complete" },
    threadRow,
    workRow,
    ...doneRows,
    { task_id: "check", title: "Check result", status: check },
  ];
}

/** Compact duration: 45s, 14m, 1h 5m. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

const STATUS_WORD: Record<JobStatus, string> = {
  launching: "launching",
  running: "running",
  waiting_input: "waiting for you",
  waiting_permission: "waiting for you",
  quiet: "quiet",
  worker_offline: "worker offline",
  checking: "checking",
  done: "done",
  failed: "failed",
  cancelled: "cancelled",
};

export interface CardFooter {
  /** For example "Codex" or "Codex · gpt-5". */
  worker: string;
  threadId?: string | null;
  /** Time of the latest worker activity. */
  updatedAt?: Date | number;
}

export interface RenderCardInput {
  ref: string;
  title: string;
  status: JobStatus;
  steps: CardStep[];
  startedAt: Date | number;
  now: Date | number;
  footer: CardFooter;
  /** Grows on every edit. Slack needs a new block_id to redraw a plan block. */
  version: number;
}

export interface Rendered {
  blocks: Record<string, unknown>[];
  text: string;
}

const ms = (value: Date | number): number => (typeof value === "number" ? value : value.getTime());

// Slack mrkdwn control characters in text from workers and people.
function escapeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function ago(from: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - from) / 60_000);
  return minutes < 1 ? "just now" : `${minutes} min ago`;
}

export function renderJobCard(input: RenderCardInput): Rendered {
  const now = ms(input.now);
  const elapsed = formatDuration(now - ms(input.startedAt));
  const title = `[${input.ref}] ${clip(input.title, 80)} · ${STATUS_WORD[input.status]} ${elapsed}`;

  const parts = [escapeText(input.footer.worker)];
  if (input.footer.threadId) parts.push(`thread ${escapeText(input.footer.threadId)}`);
  const updated = input.footer.updatedAt === undefined ? now : ms(input.footer.updatedAt);
  parts.push(`updated ${ago(updated, now)}`);

  return {
    blocks: [
      {
        type: "plan",
        block_id: `job-${input.ref}-v${input.version}`,
        title,
        tasks: input.steps.slice(0, MAX_TASKS),
      },
      { type: "context", elements: [{ type: "mrkdwn", text: parts.join(" · ") }] },
    ],
    text: title,
  };
}

export interface CollapsedCardInput {
  ref: string;
  title: string;
  status: Extract<JobStatus, "done" | "failed" | "cancelled">;
  startedAt: Date | number;
  /** The end time. */
  now: Date | number;
  prUrl?: string | null;
}

const END_WORD = { done: "Done in", failed: "Failed after", cancelled: "Cancelled after" } as const;

// The PR number as text. The result message carries the link, so the card never unfurls.
export function prLabel(url: string): string | null {
  const match = /\/(?:pull|merge_requests)\/(\d+)/.exec(url);
  return match ? `PR #${match[1]}` : null;
}

export function renderCollapsedCard(input: CollapsedCardInput): Rendered {
  const took = formatDuration(ms(input.now) - ms(input.startedAt));
  const pr = input.prUrl ? prLabel(input.prUrl) : null;
  const line = [`[${input.ref}] ${clip(input.title, 80)}`, `${END_WORD[input.status]} ${took}`, pr]
    .filter(Boolean)
    .join(" · ");
  return {
    blocks: [{ type: "section", text: { type: "mrkdwn", text: escapeText(line) } }],
    text: line,
  };
}
