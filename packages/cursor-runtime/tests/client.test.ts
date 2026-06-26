import { inspect } from 'node:util';

import { describe, expect, it } from 'vitest';

import {
  CursorClientError,
  CursorCloudClient,
  type CursorRunLike,
  type CursorSdkPort,
} from '../src/client.js';

import type { AgentOptions } from '@cursor/sdk';

interface FakeConfig {
  models?: string[];
  run?: CursorRunLike;
  onCreate?: () => void;
  onGetRun?: () => void;
  onListModels?: () => void;
  agentId?: string;
  runId?: string;
}

interface Captured {
  createOptions?: AgentOptions;
  task?: string;
  listModelCalls: number;
}

function fakeSdk(cfg: FakeConfig = {}): { port: CursorSdkPort; captured: Captured } {
  const captured: Captured = { listModelCalls: 0 };
  const port: CursorSdkPort = {
    async createCloudAgent(options) {
      cfg.onCreate?.();
      captured.createOptions = options;
      const runId = cfg.runId ?? 'run-1';
      return {
        agentId: cfg.agentId ?? 'agent-1',
        async send(task: string) {
          captured.task = task;
          return { id: runId };
        },
      };
    },
    async getCloudRun() {
      cfg.onGetRun?.();
      return cfg.run ?? { status: 'running' };
    },
    async listModelIds() {
      captured.listModelCalls += 1;
      cfg.onListModels?.();
      return cfg.models ?? ['composer-2.5'];
    },
  };
  return { port, captured };
}

const errorOf = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => null,
    (e) => e,
  );

/** An SDK-style error whose class name drives classification. */
const namedError = (name: string, message: string, cause?: unknown): Error => {
  const e = new Error(message, cause !== undefined ? { cause } : undefined);
  e.name = name;
  return e;
};

describe('CursorCloudClient.dispatch', () => {
  it('creates a cloud agent with the configured model and repo, returns ids', async () => {
    const { port, captured } = fakeSdk();
    const client = new CursorCloudClient({ apiKey: 'k', model: 'composer-2.5', sdk: port });

    const result = await client.dispatch({ repoUrl: 'https://github.com/o/r', task: 'do x' });

    expect(result).toEqual({ agentId: 'agent-1', runId: 'run-1' });
    expect(captured.task).toBe('do x');
    const opts = captured.createOptions;
    expect(opts?.model).toEqual({ id: 'composer-2.5' });
    expect(opts?.cloud?.repos).toEqual([{ url: 'https://github.com/o/r' }]);
    expect(opts?.cloud?.autoCreatePR).toBe(true);
    expect(opts?.cloud?.skipReviewerRequest).toBe(false);
  });

  it('passes startingRef through to repos[0].startingRef', async () => {
    const { port, captured } = fakeSdk();
    const client = new CursorCloudClient({ apiKey: 'k', model: 'composer-2.5', sdk: port });

    await client.dispatch({ repoUrl: 'https://github.com/o/r', task: 't', startingRef: 'dev' });

    expect(captured.createOptions?.cloud?.repos).toEqual([
      { url: 'https://github.com/o/r', startingRef: 'dev' },
    ]);
  });

  it('fails fast on an unknown model with a fatal unknown-model error', async () => {
    const { port } = fakeSdk({ models: ['composer-2.5'] });
    const client = new CursorCloudClient({ apiKey: 'k', model: 'bogus', sdk: port });

    const err = await errorOf(client.dispatch({ repoUrl: 'u', task: 't' }));
    expect(err).toBeInstanceOf(CursorClientError);
    expect((err as CursorClientError).code).toBe('unknown-model');
    expect((err as CursorClientError).retryable).toBe(false);
    expect((err as Error).message).toMatch(/unknown Cursor model: bogus/);
  });

  it('rejects an empty agent/run id as a non-retryable error (no unpollable orphan)', async () => {
    const { port } = fakeSdk({ runId: '' });
    const client = new CursorCloudClient({ apiKey: 'k', model: 'composer-2.5', sdk: port });

    const err = await errorOf(client.dispatch({ repoUrl: 'u', task: 't' }));
    expect(err).toBeInstanceOf(CursorClientError);
    expect((err as CursorClientError).code).toBe('unknown');
    expect((err as CursorClientError).retryable).toBe(false);
  });

  it('validates the model only once across concurrent dispatches', async () => {
    const { port, captured } = fakeSdk();
    const client = new CursorCloudClient({ apiKey: 'k', model: 'composer-2.5', sdk: port });

    await Promise.all([
      client.dispatch({ repoUrl: 'u', task: 'a' }),
      client.dispatch({ repoUrl: 'u', task: 'b' }),
      client.dispatch({ repoUrl: 'u', task: 'c' }),
    ]);

    expect(captured.listModelCalls).toBe(1);
  });

  it('re-validates the model after a dispatch failure (clears the cache)', async () => {
    let fail = true;
    const { port, captured } = fakeSdk({
      onCreate: () => {
        if (fail) {
          fail = false;
          throw namedError('NetworkError', 'transient');
        }
      },
    });
    const client = new CursorCloudClient({ apiKey: 'k', model: 'composer-2.5', sdk: port });

    await errorOf(client.dispatch({ repoUrl: 'u', task: 't' }));
    await client.dispatch({ repoUrl: 'u', task: 't' });

    expect(captured.listModelCalls).toBe(2);
  });
});

describe('CursorCloudClient error classification', () => {
  const dispatchWith = (err: Error): Promise<unknown> => {
    const { port } = fakeSdk({
      onCreate: () => {
        throw err;
      },
    });
    const client = new CursorCloudClient({ apiKey: 'k', model: 'composer-2.5', sdk: port });
    return errorOf(client.dispatch({ repoUrl: 'u', task: 't' }));
  };

  it('classifies auth errors as fatal', async () => {
    const e = (await dispatchWith(namedError('AuthenticationError', '401'))) as CursorClientError;
    expect(e.code).toBe('auth');
    expect(e.retryable).toBe(false);
  });

  it('classifies network errors as retryable', async () => {
    const e = (await dispatchWith(namedError('NetworkError', 'ECONNRESET'))) as CursorClientError;
    expect(e.code).toBe('network');
    expect(e.retryable).toBe(true);
  });

  it('classifies rate-limit errors as retryable', async () => {
    const e = (await dispatchWith(namedError('RateLimitError', '429'))) as CursorClientError;
    expect(e.code).toBe('rate-limit');
    expect(e.retryable).toBe(true);
  });

  it('classifies unknown errors as retryable by default', async () => {
    const e = (await dispatchWith(new Error('???'))) as CursorClientError;
    expect(e.code).toBe('unknown');
    expect(e.retryable).toBe(true);
  });

  it('wraps a non-Error throw into a CursorClientError', async () => {
    const { port } = fakeSdk({
      onCreate: () => {
        throw 'raw string failure';
      },
    });
    const client = new CursorCloudClient({ apiKey: 'k', model: 'composer-2.5', sdk: port });
    const e = (await errorOf(client.dispatch({ repoUrl: 'u', task: 't' }))) as CursorClientError;
    expect(e).toBeInstanceOf(CursorClientError);
    expect(e.message).toContain('raw string failure');
  });
});

describe('CursorCloudClient secret hygiene', () => {
  const KEY = 'crsr-secret-abcdef';

  it('redacts the key from the whole error chain (message, stack, cause)', async () => {
    const inner = new Error(`inner ${KEY}`);
    const outer = namedError('AuthenticationError', `outer ${KEY}`, inner);
    const { port } = fakeSdk({
      onCreate: () => {
        throw outer;
      },
    });
    const client = new CursorCloudClient({ apiKey: KEY, model: 'composer-2.5', sdk: port });

    const err = (await errorOf(client.dispatch({ repoUrl: 'u', task: 't' }))) as CursorClientError;
    expect(err).toBeInstanceOf(CursorClientError);
    expect(err.message).toContain('[redacted]');
    // The entire serialized error (message + stack + full cause chain) must be key-free.
    expect(inspect(err, { depth: null })).not.toContain(KEY);
  });

  it('redacts the key from a getRun error', async () => {
    const { port } = fakeSdk({
      onGetRun: () => {
        throw new Error(`boom ${KEY}`);
      },
    });
    const client = new CursorCloudClient({ apiKey: KEY, model: 'composer-2.5', sdk: port });

    const err = (await errorOf(client.getRun('a', 'r'))) as CursorClientError;
    expect(inspect(err, { depth: null })).not.toContain(KEY);
  });

  it('redacts the key from a model-validation (models.list) error', async () => {
    const { port } = fakeSdk({
      onListModels: () => {
        throw namedError('AuthenticationError', `list failed ${KEY}`);
      },
    });
    const client = new CursorCloudClient({ apiKey: KEY, model: 'composer-2.5', sdk: port });

    const err = (await errorOf(client.dispatch({ repoUrl: 'u', task: 't' }))) as CursorClientError;
    expect(err.code).toBe('auth');
    expect(inspect(err, { depth: null })).not.toContain(KEY);
  });

  it('leaves short/degenerate keys unscrubbed but still wrapped', async () => {
    const { port } = fakeSdk({
      onCreate: () => {
        throw new Error('contains k somewhere');
      },
    });
    const client = new CursorCloudClient({ apiKey: 'k', model: 'composer-2.5', sdk: port });
    const err = (await errorOf(client.dispatch({ repoUrl: 'u', task: 't' }))) as CursorClientError;
    expect(err).toBeInstanceOf(CursorClientError);
    expect(err.message).toBe('contains k somewhere');
  });

  it('never serializes the key and injects a sentinel', () => {
    const client = new CursorCloudClient({
      apiKey: KEY,
      model: 'composer-2.5',
      sdk: fakeSdk().port,
    });
    const serialized = JSON.stringify({ client });
    expect(serialized).toContain('[CursorCloudClient]');
    expect(serialized).not.toContain(KEY);
    expect(client.toJSON()).toBe('[CursorCloudClient]');
  });
});

describe('CursorCloudClient.getRun', () => {
  const clientFor = (run: CursorRunLike): CursorCloudClient =>
    new CursorCloudClient({ apiKey: 'k', model: 'composer-2.5', sdk: fakeSdk({ run }).port });

  it('maps a running run', async () => {
    expect(await clientFor({ status: 'running' }).getRun('a', 'r')).toEqual({
      status: 'running',
      pendingPr: false,
    });
  });

  it('extracts prUrl and summary from a finished run', async () => {
    const run: CursorRunLike = {
      status: 'finished',
      result: 'opened PR',
      git: { branches: [{ repoUrl: 'u' }, { repoUrl: 'u', prUrl: 'https://pr/1' }] },
    };
    expect(await clientFor(run).getRun('a', 'r')).toEqual({
      status: 'finished',
      prUrl: 'https://pr/1',
      summary: 'opened PR',
      pendingPr: false,
    });
  });

  it('flags finished-without-prUrl as pendingPr (no git)', async () => {
    expect(await clientFor({ status: 'finished', result: 'done' }).getRun('a', 'r')).toEqual({
      status: 'finished',
      summary: 'done',
      pendingPr: true,
    });
  });

  it('flags finished with branches but no prUrl as pendingPr', async () => {
    const run: CursorRunLike = {
      status: 'finished',
      git: { branches: [{ repoUrl: 'u', branch: 'feature-x' }] },
    };
    expect(await clientFor(run).getRun('a', 'r')).toEqual({ status: 'finished', pendingPr: true });
  });

  it('treats an empty-string prUrl as not-yet-present (pendingPr)', async () => {
    const run: CursorRunLike = {
      status: 'finished',
      git: { branches: [{ repoUrl: 'u', prUrl: '' }] },
    };
    expect(await clientFor(run).getRun('a', 'r')).toEqual({ status: 'finished', pendingPr: true });
  });

  it('maps a cancelled run as terminal', async () => {
    expect(await clientFor({ status: 'cancelled' }).getRun('a', 'r')).toEqual({
      status: 'cancelled',
      pendingPr: false,
    });
  });

  it('maps an error run as terminal', async () => {
    expect(await clientFor({ status: 'error' }).getRun('a', 'r')).toEqual({
      status: 'error',
      pendingPr: false,
    });
  });

  it('normalizes an unrecognized SDK status to running (keep polling)', async () => {
    const run = { status: 'queued' } as unknown as CursorRunLike;
    expect(await clientFor(run).getRun('a', 'r')).toEqual({ status: 'running', pendingPr: false });
  });
});
