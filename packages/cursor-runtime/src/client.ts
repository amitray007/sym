/**
 * `CursorCloudClient` — a thin, typed wrapper over the `@cursor/sdk` cloud
 * surface. All SDK calls live behind the `CursorSdkPort` so unit tests inject a
 * fake (no network, no SDK runtime load). The type surface still references the
 * SDK's `Run` / `AgentOptions` directly — isolation here is runtime (lazy
 * import), not type-level.
 *
 * Verified SDK shapes (pinned here so drift is caught in one place):
 *   - dispatch:  `Agent.create({ apiKey, model:{id}, cloud:{ repos, autoCreatePR,
 *                 skipReviewerRequest } })` then `agent.send(task)` → `{ id }` (runId).
 *   - poll:      `Agent.getRun(runId, { runtime:'cloud', agentId, apiKey })`.
 *   - PR URL:    `run.git.branches[].prUrl`  (not a flat field).
 *   - summary:   `run.result`.
 *   - status:    `RunStatus` (`running | finished | error | cancelled`).
 *   - models:    `Cursor.models.list()` — used for fail-fast model validation,
 *                since cloud agent creation does NOT validate the model.
 *
 * Errors always surface as `CursorClientError` with a `code` + `retryable` flag
 * so the reconciler can separate fatal (auth, unknown model) from transient
 * (network, rate limit) failures, and never carry the API key — message, stack,
 * and the full `cause` chain are scrubbed.
 */

import type { CloudDispatchRequest, CloudDispatchResult, CloudRunView } from './types.js';
import type { AgentOptions, Run } from '@cursor/sdk';

/** SDK `Run` fields this client reads — derived from the SDK type so it can't drift. */
export type CursorRunLike = Pick<Run, 'status' | 'result' | 'git'>;

/**
 * SDK `SDKAgent` fields this client reads. Intentionally narrows `send`'s return
 * to `{ id }` (vs the SDK's full `Run`) so test fakes stay lightweight;
 * `Agent.create`'s `SDKAgent` satisfies it structurally.
 */
export interface CursorAgentLike {
  readonly agentId: string;
  send(task: string): Promise<{ readonly id: string }>;
}

/**
 * The seam between this client and `@cursor/sdk`. The default implementation
 * lazily imports the SDK; tests pass a fake so they never load it.
 */
export interface CursorSdkPort {
  createCloudAgent(options: AgentOptions): Promise<CursorAgentLike>;
  getCloudRun(runId: string, agentId: string): Promise<CursorRunLike>;
  listModelIds(): Promise<string[]>;
}

/** Classification of a client failure, for the reconciler's retry decisions. */
export type CursorErrorCode = 'auth' | 'unknown-model' | 'rate-limit' | 'network' | 'unknown';

/** Every error this client throws — carries a stable `code` and `retryable` flag. */
export class CursorClientError extends Error {
  readonly code: CursorErrorCode;
  readonly retryable: boolean;

  constructor(
    message: string,
    opts: { code: CursorErrorCode; retryable: boolean; cause?: unknown },
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'CursorClientError';
    this.code = opts.code;
    this.retryable = opts.retryable;
  }
}

/** Map an SDK error to a code + retryable flag by its class name (no SDK import). */
function classifySdkError(err: unknown): { code: CursorErrorCode; retryable: boolean } {
  const name = err instanceof Error ? err.name : '';
  switch (name) {
    case 'AuthenticationError':
      return { code: 'auth', retryable: false };
    case 'RateLimitError':
      return { code: 'rate-limit', retryable: true };
    case 'NetworkError':
      return { code: 'network', retryable: true };
    case 'ConfigurationError':
      return { code: 'unknown', retryable: false };
    default:
      return { code: 'unknown', retryable: true };
  }
}

const KNOWN_RUN_STATUSES: ReadonlySet<string> = new Set([
  'running',
  'finished',
  'error',
  'cancelled',
]);

/** Coerce an SDK run status to a known value; unrecognized → `running` (keep polling). */
function normalizeRunStatus(status: string): CloudRunView['status'] {
  return KNOWN_RUN_STATUSES.has(status) ? (status as CloudRunView['status']) : 'running';
}

/** Real `@cursor/sdk`-backed port. Lazy-imports so unit tests with a fake never load the SDK. */
export function defaultCursorSdkPort(apiKey: string): CursorSdkPort {
  return {
    async createCloudAgent(options) {
      const { Agent } = await import('@cursor/sdk');
      return Agent.create(options);
    },
    async getCloudRun(runId, agentId) {
      const { Agent } = await import('@cursor/sdk');
      return Agent.getRun(runId, { runtime: 'cloud', agentId, apiKey });
    },
    async listModelIds() {
      const { Cursor } = await import('@cursor/sdk');
      return (await Cursor.models.list({ apiKey })).map((m) => m.id);
    },
  };
}

export interface CursorCloudClientOptions {
  apiKey: string;
  /** Cloud model id, e.g. `composer-2.5`. Validated lazily against `models.list()`. */
  model: string;
  /** Injectable SDK seam — defaults to the real `@cursor/sdk`. */
  sdk?: CursorSdkPort;
}

export class CursorCloudClient {
  readonly #apiKey: string;
  readonly #model: string;
  readonly #sdk: CursorSdkPort;
  /** In-flight/settled model-validation promise; null until first dispatch, cleared on failure. */
  #modelCheck: Promise<void> | null = null;

  constructor(options: CursorCloudClientOptions) {
    this.#apiKey = options.apiKey;
    this.#model = options.model;
    this.#sdk = options.sdk ?? defaultCursorSdkPort(options.apiKey);
  }

  /** Launch a cloud agent on a resolved repo URL and return its identifiers. */
  async dispatch(request: CloudDispatchRequest): Promise<CloudDispatchResult> {
    // Validate outside the try: a thrown `unknown-model` error is already a
    // (scrubbed) CursorClientError and must not be re-wrapped.
    await this.#ensureModel();
    try {
      const options: AgentOptions = {
        apiKey: this.#apiKey,
        model: { id: this.#model },
        cloud: {
          repos: [
            request.startingRef !== undefined
              ? { url: request.repoUrl, startingRef: request.startingRef }
              : { url: request.repoUrl },
          ],
          autoCreatePR: true,
          skipReviewerRequest: false,
        },
      };
      const agent = await this.#sdk.createCloudAgent(options);
      const run = await agent.send(request.task);
      if (agent.agentId.length === 0 || run.id.length === 0) {
        throw new CursorClientError('cloud dispatch returned an empty agent or run id', {
          code: 'unknown',
          retryable: false,
        });
      }
      return { agentId: agent.agentId, runId: run.id };
    } catch (err) {
      // A failed create may mean the model was deprecated after validation —
      // clear the cache so the next dispatch re-validates and can fail-fast.
      this.#modelCheck = null;
      throw err instanceof CursorClientError ? err : this.#wrapSdkError(err);
    }
  }

  /** Fetch and normalize a cloud run's current state. */
  async getRun(agentId: string, runId: string): Promise<CloudRunView> {
    try {
      const run = await this.#sdk.getCloudRun(runId, agentId);
      // Defensive: an unrecognized status (SDK drift) is treated as still-running
      // so a live run is never wrongly terminated; the reconciler's max-run
      // deadline backstops a genuinely stuck run.
      const status = normalizeRunStatus(run.status);
      const prUrl = run.git?.branches.find((b) => b.prUrl)?.prUrl;
      return {
        status,
        ...(prUrl ? { prUrl } : {}),
        ...(run.result !== undefined ? { summary: run.result } : {}),
        pendingPr: status === 'finished' && !prUrl,
      };
    } catch (err) {
      throw this.#wrapSdkError(err);
    }
  }

  /**
   * Validate the configured model once, fail-fast (cloud create does not
   * validate). Concurrent first dispatches share one in-flight check; a failure
   * clears the cache so the next call retries.
   */
  async #ensureModel(): Promise<void> {
    this.#modelCheck ??= this.#runModelCheck();
    try {
      await this.#modelCheck;
    } catch (err) {
      this.#modelCheck = null;
      throw err;
    }
  }

  async #runModelCheck(): Promise<void> {
    let ids: string[];
    try {
      ids = await this.#sdk.listModelIds();
    } catch (err) {
      throw this.#wrapSdkError(err);
    }
    if (!ids.includes(this.#model)) {
      throw new CursorClientError(this.#scrub(`unknown Cursor model: ${this.#model}`), {
        code: 'unknown-model',
        retryable: false,
      });
    }
  }

  /** Wrap an SDK error: classify it, scrub the key from message + stack + cause chain. */
  #wrapSdkError(err: unknown): CursorClientError {
    const { code, retryable } = classifySdkError(err);
    const message = this.#scrub(err instanceof Error ? err.message : String(err));
    return new CursorClientError(message, { code, retryable, cause: this.#scrubChain(err) });
  }

  /**
   * Strip the API key from a string. Only realistic keys are scrubbed: real
   * Cursor keys are long/high-entropy, so a length floor avoids corrupting
   * ordinary words that happen to contain a short/degenerate "key" substring.
   */
  #scrub(text: string): string {
    return this.#apiKey.length >= 8 ? text.split(this.#apiKey).join('[redacted]') : text;
  }

  /** Rebuild an error (and its whole cause chain) with the key scrubbed everywhere. */
  #scrubChain(err: unknown): unknown {
    if (!(err instanceof Error)) {
      return typeof err === 'string' ? this.#scrub(err) : undefined;
    }
    const safe = new Error(this.#scrub(err.message));
    safe.name = err.name;
    if (err.stack !== undefined) safe.stack = this.#scrub(err.stack);
    if (err.cause !== undefined) {
      (safe as { cause?: unknown }).cause = this.#scrubChain(err.cause);
    }
    return safe;
  }

  /** Never serialize the key (e.g. if `config.cursor` is accidentally logged). */
  toJSON(): string {
    return '[CursorCloudClient]';
  }
}
