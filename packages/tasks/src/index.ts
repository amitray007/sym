/**
 * `@sym/tasks` — durable task queue + slice/checkpoint primitive.
 *
 * Public API:
 *
 * Enqueue / dequeue:
 *   - `enqueue(db, input): Promise<EnqueueResult>`
 *   - `dequeue(db, opts?): Promise<DequeuedTask[]>`
 *   - `EnqueueInput`, `EnqueueResult`, `DequeuedTask`, `DequeueOptions`
 *
 * Worker:
 *   - `createWorker({ db, handlers, config }): WorkerHandle`
 *   - `WorkerHandle`, `CreateWorkerInput`
 *
 * Checkpoint (slice/resume):
 *   - `saveCheckpoint(db, input): Promise<{ checkpointId: string }>`
 *   - `restoreCheckpoint(db, opts): Promise<RestoreCheckpointResult | null>`
 *   - `serializeCheckpoint(state): Buffer`
 *   - `deserializeCheckpoint(buf): CheckpointState`
 *   - `CURRENT_CHECKPOINT_VERSION`
 *   - `CheckpointVersionError`
 *   - `SaveCheckpointInput`, `RestoreCheckpointResult`, `CheckpointState`
 *
 * HMAC resume tokens:
 *   - `mintResumeToken(input): ResumeToken`
 *   - `verifyResumeToken(input, opts?): VerifiedResumeToken`
 *   - `HmacSecretMissingError`, `ResumeTokenInvalidError`, `ResumeTokenExpiredError`
 *   - `MintResumeTokenInput`, `VerifyResumeTokenInput`, `ResumeToken`, `VerifiedResumeToken`
 *
 * Retry:
 *   - `backoffSeconds(attempt): number`
 *   - `applyRetry(db, input): Promise<void>`
 *   - `ApplyRetryInput`
 *
 * Types:
 *   - `TaskKind`, `TaskPayload`, `TaskResult`, `TaskConfig`
 *   - `TaskHandler`, `HandlerMap`, `TaskHandlerContext`
 *   - `ResumeTokenPayload`
 */

// Enqueue
export { enqueue } from './enqueue.js';
export type { EnqueueInput, EnqueueResult } from './enqueue.js';

// Dequeue
export { dequeue } from './dequeue.js';
export type { DequeuedTask, DequeueOptions } from './dequeue.js';

// Worker
export { createWorker } from './worker.js';
export type { CreateWorkerInput, WorkerHandle } from './worker.js';

// Checkpoint
export {
  CURRENT_CHECKPOINT_VERSION,
  CheckpointVersionError,
  deserializeCheckpoint,
  restoreCheckpoint,
  saveCheckpoint,
  serializeCheckpoint,
} from './checkpoint.js';

// HMAC resume tokens
export {
  HmacSecretMissingError,
  mintResumeToken,
  ResumeTokenExpiredError,
  ResumeTokenInvalidError,
  verifyResumeToken,
} from './hmac.js';
export type { MintResumeTokenInput, VerifiedResumeToken, VerifyResumeTokenInput } from './hmac.js';

// Retry
export { applyRetry, backoffSeconds } from './retry.js';
export type { ApplyRetryInput } from './retry.js';

// Shared types
export type {
  CheckpointState,
  HandlerMap,
  RestoreCheckpointResult,
  ResumeToken,
  ResumeTokenPayload,
  SaveCheckpointInput,
  TaskConfig,
  TaskHandler,
  TaskHandlerContext,
  TaskKind,
  TaskPayload,
  TaskResult,
} from './types.js';
