import { describe, expect, it } from 'vitest';

import { CursorCloudClient, type CursorRunLike, type CursorSdkPort } from '../src/client.js';

import type { AgentOptions } from '@cursor/sdk';

interface FakeConfig {
  models?: string[];
  run?: CursorRunLike;
  onCreate?: () => void;
  onGetRun?: () => void;
}

function fakeSdk(cfg: FakeConfig = {}): {
  port: CursorSdkPort;
  captured: { createOptions?: AgentOptions; task?: string };
} {
  const captured: { createOptions?: AgentOptions; task?: string } = {};
  const port: CursorSdkPort = {
    async createCloudAgent(options) {
      cfg.onCreate?.();
      captured.createOptions = options;
      return {
        agentId: 'agent-1',
        async send(task: string) {
          captured.task = task;
          return { id: 'run-1' };
        },
      };
    },
    async getCloudRun() {
      cfg.onGetRun?.();
      return cfg.run ?? { status: 'running' };
    },
    async listModelIds() {
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

  it('fails fast on an unknown model', async () => {
    const { port } = fakeSdk({ models: ['composer-2.5'] });
    const client = new CursorCloudClient({ apiKey: 'k', model: 'bogus', sdk: port });

    await expect(client.dispatch({ repoUrl: 'u', task: 't' })).rejects.toThrow(
      /unknown Cursor model: bogus/,
    );
  });

  it('redacts the api key from a thrown SDK error', async () => {
    const { port } = fakeSdk({
      onCreate: () => {
        throw new Error('401 invalid key crsr-secret-abc');
      },
    });
    const client = new CursorCloudClient({
      apiKey: 'crsr-secret-abc',
      model: 'composer-2.5',
      sdk: port,
    });

    const err = await errorOf(client.dispatch({ repoUrl: 'u', task: 't' }));
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('[redacted]');
    expect((err as Error).message).not.toContain('crsr-secret-abc');
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

  it('flags finished-without-prUrl as pendingPr', async () => {
    expect(await clientFor({ status: 'finished', result: 'done' }).getRun('a', 'r')).toEqual({
      status: 'finished',
      summary: 'done',
      pendingPr: true,
    });
  });

  it('maps a cancelled run as terminal', async () => {
    expect(await clientFor({ status: 'cancelled' }).getRun('a', 'r')).toEqual({
      status: 'cancelled',
      pendingPr: false,
    });
  });

  it('redacts the api key from a getRun error', async () => {
    const { port } = fakeSdk({
      onGetRun: () => {
        throw new Error('boom key=crsr-secret-xyz');
      },
    });
    const client = new CursorCloudClient({
      apiKey: 'crsr-secret-xyz',
      model: 'composer-2.5',
      sdk: port,
    });

    const err = await errorOf(client.getRun('a', 'r'));
    expect((err as Error).message).toContain('[redacted]');
    expect((err as Error).message).not.toContain('crsr-secret-xyz');
  });
});

describe('CursorCloudClient secret hygiene', () => {
  it('never serializes the api key', () => {
    const client = new CursorCloudClient({
      apiKey: 'super-secret',
      model: 'composer-2.5',
      sdk: fakeSdk().port,
    });
    expect(JSON.stringify({ client })).not.toContain('super-secret');
    expect(client.toJSON()).toBe('[CursorCloudClient]');
  });
});
