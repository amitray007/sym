/**
 * `@sym/cursor-runtime` — Cursor cloud-agent runtime for Sym.
 *
 * Public surface: dispatch + poll a Cursor cloud agent, track runs in a
 * control-tier store, and resolve repos against an allowlist. Depends only on
 * `@cursor/sdk` + `zod`; imports nothing from `apps/*` (enforced by the DAG).
 */

export {
  CursorCloudClient,
  CursorClientError,
  type CursorCloudClientOptions,
  type CursorErrorCode,
  type CursorSdkPort,
} from './client.js';

export {
  CloudRunStore,
  type CloudRunStoreOptions,
  type CloudRunIntent,
  type CloudRunStatusPatch,
} from './store.js';

export {
  CloudRunReconciler,
  type CloudRunReconcilerOptions,
  type CloudRunPoller,
} from './reconciler.js';

export { resolveRepo } from './allowlist.js';

export {
  cloudDispatchInputSchema,
  cloudRunStatusSchema,
  repoAllowlistSchema,
  repoAllowlistEntrySchema,
  CLOUD_RUN_TERMINAL_STATUSES,
  isTerminalStatus,
  type CloudRunStatus,
  type CloudDispatchInput,
  type CloudDispatchRequest,
  type CloudDispatchResult,
  type CloudRunView,
  type CloudRunRecord,
  type RepoRef,
  type RepoAllowlist,
} from './types.js';
