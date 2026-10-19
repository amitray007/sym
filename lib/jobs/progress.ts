import type { JobStatus } from "../ledger/jobs.ts";

// The `progress` rule set (docs/architecture.md, flow 3). It decides which changes post a NEW
// message. Everything else edits the job card. No model call, no clock: the caller passes `now`.

export const QUIET_AFTER_MS = 20 * 60_000;
export const QUIET_REPEAT_MS = 60 * 60_000;

export type ProgressEvent =
  | { type: "pr_opened"; url: string }
  | { type: "needs_input" }
  | { type: "needs_permission" }
  | { type: "quiet" }
  | { type: "finished" }
  | { type: "failed" };

export interface ProgressState {
  status: JobStatus;
  /** The first PR or MR URL seen. */
  prUrl?: string | null;
  /** Epoch ms of the latest worker activity, which starts the current quiet stretch. */
  quietSince?: number;
  /** Epoch ms of the last quiet post. Limits the post rate to once an hour. */
  lastQuietPostAt?: number;
}

export interface ProgressInput {
  status: JobStatus;
  newItems: { type: string; text: string }[];
  /** Epoch ms. */
  now: number;
}

export interface ProgressResult {
  events: ProgressEvent[];
  /** The state to save for the next loop. */
  state: ProgressState;
}

// GitHub pull requests and GitLab merge requests (also self-hosted GitLab).
const PR_URL =
  /https:\/\/(?:github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+|[\w.-]+\/(?:[\w.-]+\/)+-\/merge_requests\/\d+)/;

export function findPullRequestUrl(items: { text: string }[]): string | undefined {
  for (const item of items) {
    const match = PR_URL.exec(item.text);
    if (match) return match[0];
  }
  return undefined;
}

const ENDED: readonly JobStatus[] = ["done", "failed", "cancelled"];

export function detectEvents(previous: ProgressState, current: ProgressInput): ProgressResult {
  const { now } = current;
  const active = current.newItems.length > 0;
  const quietSince = active ? now : (previous.quietSince ?? now);
  const state: ProgressState = {
    status: current.status,
    prUrl: previous.prUrl ?? null,
    quietSince,
    ...(previous.lastQuietPostAt === undefined
      ? {}
      : { lastQuietPostAt: previous.lastQuietPostAt }),
  };

  // A finished job stays finished. A late check posts nothing.
  if (ENDED.includes(previous.status)) return { events: [], state };

  const events: ProgressEvent[] = [];
  const changed = previous.status !== current.status;

  if (!previous.prUrl) {
    const url = findPullRequestUrl(current.newItems);
    if (url) {
      events.push({ type: "pr_opened", url });
      state.prUrl = url;
    }
  }

  if (changed && current.status === "waiting_input") events.push({ type: "needs_input" });
  if (changed && current.status === "waiting_permission") {
    events.push({ type: "needs_permission" });
  }

  const watching = current.status === "running" || current.status === "quiet";
  const longQuiet = !active && now - quietSince >= QUIET_AFTER_MS;
  const rested =
    previous.lastQuietPostAt === undefined || now - previous.lastQuietPostAt >= QUIET_REPEAT_MS;
  if (watching && longQuiet && rested) {
    events.push({ type: "quiet" });
    state.lastQuietPostAt = now;
  }

  if (current.status === "done") events.push({ type: "finished" });
  if (current.status === "failed") events.push({ type: "failed" });

  return { events, state };
}
