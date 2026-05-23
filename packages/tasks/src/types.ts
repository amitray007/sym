/**
 * Shared types for @sym/tasks.
 *
 * TaskKind     — discriminant for the handler map
 * TaskPayload  — the jsonb blob stored in tasks.payload_json
 * TaskResult   — returned by a handler on success
 * TaskConfig   — runtime configuration injected at worker start
 * TaskHandler  — per-kind handler function
 * HandlerMap   — map of kind → handler
 */

import type { ConversationId, SliceId, TaskId, WorkspaceId } from '@sym/contracts';

// ---------------------------------------------------------------------------
// Task kinds — open string, closed via the handler map
// ---------------------------------------------------------------------------

export type TaskKind = string;

// ---------------------------------------------------------------------------
// Payload / result
// ---------------------------------------------------------------------------

/** The jsonb blob stored in tasks.payload_json. */
export type TaskPayload = Record<string, unknown>;

/** Returned by a handler to signal success. */
export interface TaskResult {
  /** Optional human-readable summary stored in audit payload. */
  summary?: string;
  /** Any structured data the handler wants to surface (not persisted beyond audit). */
  data?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export interface TaskHandlerContext {
  taskId: TaskId;
  workspaceId: WorkspaceId;
  kind: TaskKind;
  payload: TaskPayload;
  attempt: number;
}

/** A per-kind handler function. Throw to signal failure and trigger retry. */
export type TaskHandler = (ctx: TaskHandlerContext) => Promise<TaskResult>;

/** Map from task kind → handler. */
export type HandlerMap = Record<TaskKind, TaskHandler>;

// ---------------------------------------------------------------------------
// Worker configuration
// ---------------------------------------------------------------------------

export interface TaskConfig {
  /**
   * Seconds to hold a task lock while processing.
   * If the worker crashes within this window, the task becomes retryable after
   * locked_until expires.
   * @default 300
   */
  lockSeconds?: number;

  /**
   * How often the poller wakes (milliseconds).
   * @default 2000
   */
  pollIntervalMs?: number;

  /**
   * Maximum number of tasks dequeued per poll cycle.
   * @default 5
   */
  batchSize?: number;

  /**
   * HMAC secret for signing timeout-resume callback tokens.
   * Read from process.env["SYM_TASK_HMAC_SECRET"] if not supplied.
   */
  hmacSecret?: string;

  /**
   * How long (seconds) an HMAC token remains valid.
   * @default 3600
   */
  hmacTtlSeconds?: number;
}

// ---------------------------------------------------------------------------
// Checkpoint types
// ---------------------------------------------------------------------------

export interface CheckpointState {
  /** Kernel state schema version (D-DB-6, starts at 1). */
  version: number;
  /** Arbitrary kernel state, serializable to JSON before bytea encoding. */
  payload: Record<string, unknown>;
}

export interface SaveCheckpointInput {
  workspaceId: WorkspaceId;
  conversationId: ConversationId;
  sliceId: SliceId;
  state: CheckpointState;
  /** TTL in seconds from now. @default 3600 */
  ttlSeconds?: number;
}

export interface RestoreCheckpointResult {
  state: CheckpointState;
  checkpointId: string;
}

// ---------------------------------------------------------------------------
// HMAC token
// ---------------------------------------------------------------------------

export interface ResumeToken {
  /** Opaque signed string to pass to verifyResumeToken. */
  token: string;
  /** Unix epoch seconds when the token expires. */
  expiresAt: number;
}

export interface ResumeTokenPayload {
  conversationId: ConversationId;
  sliceId: SliceId;
  /** ISO timestamp when minted — used to enforce TTL. */
  mintedAt: string;
}
