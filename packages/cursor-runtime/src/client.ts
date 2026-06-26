/**
 * `CursorCloudClient` — a thin, typed wrapper over the `@cursor/sdk` cloud
 * surface. All SDK calls live behind the `CursorSdkPort` so the rest of Sym
 * depends on our shapes, not the SDK's, and unit tests inject a fake (no
 * network, no SDK runtime load).
 *
 * Verified SDK shapes (pinned here so drift is caught in one place):
 *   - dispatch:  `Agent.create({ apiKey, model:{id}, cloud:{ repos, autoCreatePR,
 *                 skipReviewerRequest } })` then `agent.send(task)` → `{ id }` (runId).
 *   - poll:      `Agent.getRun(runId, { runtime:'cloud', agentId, apiKey })`.
 *   - PR URL:    `run.git.branches[].prUrl`  (not a flat field).
 *   - summary:   `run.result`.
 *   - status:    `running | finished | error | cancelled`.
 *   - models:    `Cursor.models.list()` — used for fail-fast model validation,
 *                since cloud agent creation does NOT validate the model.
 */

import type { CloudDispatchRequest, CloudDispatchResult, CloudRunView } from './types.js';
import type { AgentOptions } from '@cursor/sdk';

/** SDK `Run` fields this client reads. Structurally satisfied by `@cursor/sdk`'s `Run`. */
export interface CursorRunLike {
  readonly status: 'running' | 'finished' | 'error' | 'cancelled';
  readonly result?: string;
  readonly git?: { branches: { repoUrl: string; branch?: string; prUrl?: string }[] };
}

/** SDK `SDKAgent` fields this client reads. Structurally satisfied by `Agent.create`. */
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

/** Real `@cursor/sdk`-backed port. Lazy-imports so unit tests with a fake never load the SDK. */
export function defaultCursorSdkPort(apiKey: string): CursorSdkPort {
  return {
    async createCloudAgent(options) {
      const { Agent } = await import('@cursor/sdk');
      return (await Agent.create(options)) as unknown as CursorAgentLike;
    },
    async getCloudRun(runId, agentId) {
      const { Agent } = await import('@cursor/sdk');
      return (await Agent.getRun(runId, {
        runtime: 'cloud',
        agentId,
        apiKey,
      })) as unknown as CursorRunLike;
    },
    async listModelIds() {
      const { Cursor } = await import('@cursor/sdk');
      return (await Cursor.models.list()).map((m) => m.id);
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
  #modelChecked = false;

  constructor(options: CursorCloudClientOptions) {
    this.#apiKey = options.apiKey;
    this.#model = options.model;
    this.#sdk = options.sdk ?? defaultCursorSdkPort(options.apiKey);
  }

  /** Launch a cloud agent on a resolved repo URL and return its identifiers. */
  async dispatch(request: CloudDispatchRequest): Promise<CloudDispatchResult> {
    // Validate outside the try: this is our own error message (no key), so it
    // must not pass through `#redact`.
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
      return { agentId: agent.agentId, runId: run.id };
    } catch (err) {
      throw this.#redact(err);
    }
  }

  /** Fetch and normalize a cloud run's current state. */
  async getRun(agentId: string, runId: string): Promise<CloudRunView> {
    try {
      const run = await this.#sdk.getCloudRun(runId, agentId);
      const prUrl = run.git?.branches?.find((b) => b.prUrl !== undefined)?.prUrl;
      return {
        status: run.status,
        ...(prUrl !== undefined ? { prUrl } : {}),
        ...(run.result !== undefined ? { summary: run.result } : {}),
        pendingPr: run.status === 'finished' && prUrl === undefined,
      };
    } catch (err) {
      throw this.#redact(err);
    }
  }

  /** Validate the configured model once, fail-fast (cloud create does not validate). */
  async #ensureModel(): Promise<void> {
    if (this.#modelChecked) return;
    const ids = await this.#sdk.listModelIds();
    if (!ids.includes(this.#model)) {
      throw new Error(`unknown Cursor model: ${this.#model}`);
    }
    this.#modelChecked = true;
  }

  /**
   * Strip the API key from an error before it propagates — Cursor auth errors
   * can embed the key in the message, and reconciler/tool layers log it. When
   * nothing was redacted, the original error (and its type) is preserved.
   */
  #redact(err: unknown): Error {
    const message = err instanceof Error ? err.message : String(err);
    // Only redact realistic keys: real Cursor keys are long/high-entropy, so a
    // length floor avoids corrupting ordinary words that happen to contain a
    // short/degenerate "key" as a substring.
    if (this.#apiKey.length >= 8 && message.includes(this.#apiKey)) {
      const safe = message.split(this.#apiKey).join('[redacted]');
      return new Error(safe, { cause: err });
    }
    return err instanceof Error ? err : new Error(message);
  }

  /** Never serialize the key (e.g. if `config.cursor` is accidentally logged). */
  toJSON(): string {
    return '[CursorCloudClient]';
  }
}
