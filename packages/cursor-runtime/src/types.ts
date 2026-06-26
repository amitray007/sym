/**
 * Shared data contracts for the Cursor cloud-agent runtime.
 *
 * Types are package-local (not in `@sym/contracts`) — they describe the cloud
 * runtime's internal shapes, mirroring how `@sym/mcp-runtime` owns its own
 * config types. Zod schemas validate the two untrusted inputs: the dispatch
 * arguments the model produces, and the repo allowlist loaded from config.
 */

import { z } from 'zod';

/**
 * Lifecycle of a tracked cloud run.
 *
 * - `dispatching` — local intent row written BEFORE `client.dispatch`, so a
 *   crash in the dispatch window leaves a recoverable row (KTD7).
 * - `running` — Cursor confirmed the run and it is executing.
 * - `finished` | `error` | `cancelled` — terminal. `cancelled` is a first-class
 *   SDK terminal state (`RunStatus`); omitting it would leak runs forever.
 */
export type CloudRunStatus = 'dispatching' | 'running' | 'finished' | 'error' | 'cancelled';

/** Terminal statuses — a run in one of these is done and never polled again. */
export const CLOUD_RUN_TERMINAL_STATUSES = ['finished', 'error', 'cancelled'] as const;

export const cloudRunStatusSchema: z.ZodType<CloudRunStatus> = z.enum([
  'dispatching',
  'running',
  'finished',
  'error',
  'cancelled',
]);

/**
 * Dispatch arguments as produced by the model (the `dispatch_cloud_agent` tool).
 * `task` is a zero-trust, model-generated string — bounded here as a first
 * defense-in-depth check; the tool layer adds the confirmation gate (KTD6).
 */
export const cloudDispatchInputSchema = z.object({
  /** User/model-supplied repo reference, resolved against the allowlist. */
  repoQuery: z.string().min(1),
  /** The coding task for the cloud agent. */
  task: z.string().trim().min(1).max(10_000),
  /** Optional starting branch/ref → maps to `repos[0].startingRef`. */
  startingRef: z.string().min(1).optional(),
});
export type CloudDispatchInput = z.infer<typeof cloudDispatchInputSchema>;

/** A resolved, allowlisted repository the cloud agent may operate on. */
export interface RepoRef {
  name: string;
  url: string;
}

export const repoAllowlistEntrySchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
});
export const repoAllowlistSchema = z.array(repoAllowlistEntrySchema);
export type RepoAllowlist = RepoRef[];

/**
 * Client-level dispatch request — the tool resolves `repoQuery` → `RepoRef`
 * and hands the client a concrete URL, so the client stays allowlist-agnostic.
 */
export interface CloudDispatchRequest {
  repoUrl: string;
  task: string;
  startingRef?: string;
}

/** Identifiers returned by a successful dispatch. */
export interface CloudDispatchResult {
  agentId: string;
  runId: string;
}

/**
 * The client's mapped view of a cloud run, normalized from the SDK `Run`.
 * `prUrl` is extracted from `run.git.branches[].prUrl`; `summary` from
 * `run.result`. `pendingPr` is true when the run is `finished` but the PR URL
 * has not appeared yet, so the reconciler can wait rather than deliver an empty
 * link.
 */
export interface CloudRunView {
  status: 'running' | 'finished' | 'error' | 'cancelled';
  prUrl?: string;
  summary?: string;
  pendingPr: boolean;
}

/**
 * A persisted run-tracking row (control-tier state, not message state).
 * `statusText` holds only the short Slack status line — never the agent's full
 * natural-language summary (that lives in the GitHub PR body).
 */
export interface CloudRunRecord {
  dispatchId: string;
  runId?: string;
  agentId?: string;
  channel: string;
  threadTs: string;
  status: CloudRunStatus;
  statusText?: string;
  prUrl?: string;
  /** unix epoch ms once the terminal result was delivered to Slack. */
  deliveredAt?: number;
  createdAt: number;
  updatedAt: number;
}
