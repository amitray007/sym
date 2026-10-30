import type { JobStatus } from "../ledger/jobs.ts";
import { workerNoun } from "../worker-label.ts";

// The working note: explicit worker progress and a muted meta line, edited with chat.update.
// These functions are pure. The watch loop and reconcile pass in the facts and do the posting.

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
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

/** Sym's own action IDs. Eve keeps the `eve_input:` prefix for its controls. */
export const STOP_ACTION_ID = "sym_job_stop";
export const PR_ACTION_ID = "sym_job_pr";
// Legacy controls remain routable on messages sent before conversational jobs.
export const STEER_ACTION_ID = "sym_job_steer";
export const LOOKS_GOOD_ACTION_ID = "sym_job_ok";
export const FIX_ACTION_ID = "sym_job_fix";
export const CLOSE_ACTION_ID = "sym_job_close";
export const STEER_TEXT_ACTION_ID = "sym_job_steer_text";
export const FIX_TEXT_ACTION_ID = "sym_job_fix_text";
// Legacy Full brief controls still answer privately with the stored brief.
export const BRIEF_ACTION_ID = "sym_job_brief";
// The result buttons a later edit removes. Open PR stays.
export const RESULT_ACTION_IDS = [LOOKS_GOOD_ACTION_ID, FIX_ACTION_ID, CLOSE_ACTION_ID];

export interface RenderCardInput {
  ref: string;
  title: string;
  status: JobStatus;
  latestSummary?: string | null;
  skipping?: string | null;
  startedAt: Date | number;
  lastActivityAt?: Date | number;
  now: Date | number;
  worker: string;
  version: number;
  prUrl?: string | null;
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

// A URL button needs an http(s) URL of at most 3000 characters, and Slack rejects the whole
// message otherwise. The URL comes from a worker, so anything else gets no button.
export function buttonUrl(url: string | null | undefined): string | null {
  if (!url || url.length > 3000 || !/^https?:\/\/\S+$/i.test(url)) return null;
  return url;
}

export function openPrButton(url: string): Record<string, unknown> {
  return {
    type: "button",
    action_id: PR_ACTION_ID,
    text: { type: "plain_text", text: "Open PR" },
    url,
  };
}

export function renderJobCard(input: RenderCardInput): Rendered {
  const elapsed = formatDuration(ms(input.now) - ms(input.startedAt));
  const quietFor = ms(input.now) - ms(input.lastActivityAt ?? input.startedAt);
  const fallback: Partial<Record<JobStatus, string>> = {
    launching: `I'm starting the ${workerNoun()}.`,
    checking: "The work is back. I'm checking the result.",
    waiting_input: "I'm waiting for your answer before the work continues.",
    waiting_permission: `The ${workerNoun()} needs permission before it can continue.`,
    worker_offline: `I can't reach the ${workerNoun()}. I'll keep checking.`,
    failed: "The worker stopped before finishing.",
    cancelled: "I stopped the job. I haven't checked or reverted its changes.",
    done: "Done. Details are in the next message.",
  };
  const silence =
    quietFor >= 20 * 60_000 && (input.status === "running" || input.status === "quiet")
      ? `I haven't heard from the ${workerNoun()} for ${formatDuration(quietFor)}. I'm still checking.`
      : null;
  const note =
    fallback[input.status] ??
    silence ??
    (input.latestSummary
      ? clip(
          input.latestSummary
            .split(/(?<=[.!?])\s+/)
            .slice(0, input.skipping ? 2 : 3)
            .join(" "),
          600,
        )
      : `I'm waiting for an update from the ${workerNoun()}.`);
  const text = [
    escapeText(note),
    ...(input.skipping ? [`I'm leaving ${escapeText(clip(input.skipping, 200))} alone.`] : []),
  ].join(" ");
  const meta = [elapsed, escapeText(input.worker), input.prUrl ? prLabel(input.prUrl) : null]
    .filter(Boolean)
    .join(" · ");
  return {
    text: `${text}\n${meta}`,
    blocks: [
      {
        type: "section",
        block_id: `job-${input.ref}-v${input.version}`,
        text: { type: "mrkdwn", text },
      },
      { type: "context", elements: [{ type: "mrkdwn", text: meta }] },
    ],
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
  const line = [clip(input.title, 80), `${END_WORD[input.status]} ${took}`, pr]
    .filter(Boolean)
    .join(" · ");
  return {
    blocks: [{ type: "context", elements: [{ type: "mrkdwn", text: escapeText(line) }] }],
    text: line,
  };
}
