import { describe, expect, it } from 'vitest';

import { CloudRunStore } from '@sym/cursor-runtime';

import { createBuiltinDispatcher, type BuiltinToolDeps } from '../src/tools/registry.js';

import type { SlackClient } from '@sym/adapter-slack';
import type {
  SlackChannelId,
  SlackThreadTs,
  SlackUserId,
  ToolRuntimeContext,
} from '@sym/contracts';
import type { CursorCloudClient, RepoAllowlist } from '@sym/cursor-runtime';

const baseDeps: BuiltinToolDeps = {
  slackClient: {} as unknown as SlackClient,
  botUserId: 'UBOT' as SlackUserId,
};

function cursorDeps(confirm: boolean): NonNullable<BuiltinToolDeps['cursor']> {
  return {
    client: {} as unknown as CursorCloudClient,
    store: new CloudRunStore({ dbPath: ':memory:' }),
    allowlist: [] as RepoAllowlist,
    channel: 'C1' as SlackChannelId,
    threadTs: 'T1' as SlackThreadTs,
    confirm,
  };
}

const hasTool = (deps: BuiltinToolDeps): boolean =>
  createBuiltinDispatcher(deps)
    .list()
    .some((t) => t.name === 'dispatch_cloud_agent');

describe('dispatch_cloud_agent conditional registration', () => {
  it('is absent from list() and dispatch when cursor deps are not provided', async () => {
    const dispatcher = createBuiltinDispatcher(baseDeps);
    expect(hasTool(baseDeps)).toBe(false);

    const res = await dispatcher.dispatch(
      { id: 'c', name: 'dispatch_cloud_agent', arguments: {} },
      {} as ToolRuntimeContext,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('not_found');
  });

  it('is present in list() when cursor deps are provided', () => {
    expect(hasTool({ ...baseDeps, cursor: cursorDeps(true) })).toBe(true);
  });

  it('descriptor destructiveHint tracks the confirm flag (gate opt-out)', () => {
    const on = createBuiltinDispatcher({ ...baseDeps, cursor: cursorDeps(true) });
    const off = createBuiltinDispatcher({ ...baseDeps, cursor: cursorDeps(false) });
    expect(on.list().find((t) => t.name === 'dispatch_cloud_agent')?.destructiveHint).toBe(true);
    expect(off.list().find((t) => t.name === 'dispatch_cloud_agent')?.destructiveHint).toBe(false);
  });
});
