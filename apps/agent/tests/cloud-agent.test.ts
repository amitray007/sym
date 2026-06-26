import { describe, expect, it, vi } from 'vitest';

import { CloudRunStore } from '@sym/cursor-runtime';

import {
  DISPATCH_CLOUD_AGENT_DESCRIPTOR,
  handleDispatchCloudAgent,
  type CloudAgentToolDeps,
} from '../src/tools/cloud-agent.js';

import type { PostMessageParams, PostMessageResult, SlackClient } from '@sym/adapter-slack';
import type { JsonObject, SlackChannelId, SlackThreadTs, ToolCall } from '@sym/contracts';
import type { CursorCloudClient, RepoAllowlist } from '@sym/cursor-runtime';

const ALLOWLIST: RepoAllowlist = [{ name: 'sym', url: 'https://github.com/o/sym' }];

function makeCall(args: JsonObject): ToolCall {
  return { id: 'call-1', name: 'dispatch_cloud_agent', arguments: args };
}

function makeSlack(): { client: SlackClient; posts: PostMessageParams[] } {
  const posts: PostMessageParams[] = [];
  const client = {
    async chatPostMessage(params: PostMessageParams): Promise<PostMessageResult> {
      posts.push(params);
      return { ts: 'ts1' as SlackThreadTs, channel: params.channel };
    },
  } as unknown as SlackClient;
  return { client, posts };
}

function makeDeps(
  overrides: { dispatch?: CursorCloudClient['dispatch']; allowlist?: RepoAllowlist } = {},
): { deps: CloudAgentToolDeps; store: CloudRunStore; posts: PostMessageParams[] } {
  const store = new CloudRunStore({ dbPath: ':memory:' });
  const { client: slackClient, posts } = makeSlack();
  const dispatch = overrides.dispatch ?? (async () => ({ agentId: 'agent-1', runId: 'run-1' }));
  const client = { dispatch } as unknown as CursorCloudClient;
  const deps: CloudAgentToolDeps = {
    client,
    store,
    allowlist: overrides.allowlist ?? ALLOWLIST,
    slackClient,
    channel: 'C1' as SlackChannelId,
    threadTs: 'T1' as SlackThreadTs,
  };
  return { deps, store, posts };
}

describe('DISPATCH_CLOUD_AGENT_DESCRIPTOR', () => {
  it('is a destructive, non-readonly function tool', () => {
    expect(DISPATCH_CLOUD_AGENT_DESCRIPTOR.name).toBe('dispatch_cloud_agent');
    expect(DISPATCH_CLOUD_AGENT_DESCRIPTOR.destructiveHint).toBe(true);
    expect(DISPATCH_CLOUD_AGENT_DESCRIPTOR.readOnlyHint).toBe(false);
  });
});

describe('handleDispatchCloudAgent', () => {
  it('rejects a repo that is not allowlisted without dispatching or writing state', async () => {
    const dispatch = vi.fn(async () => ({ agentId: 'a', runId: 'r' }));
    const { deps, store } = makeDeps({ dispatch });

    const res = await handleDispatchCloudAgent(makeCall({ repo: 'secret', task: 'do x' }), deps);

    expect(res.ok).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
    expect(store.listActive()).toHaveLength(0);
  });

  it('rejects empty/invalid task args', async () => {
    const { deps } = makeDeps();
    const res = await handleDispatchCloudAgent(makeCall({ repo: 'sym', task: '   ' }), deps);
    expect(res.ok).toBe(false);
  });

  it('writes the intent row, dispatches, patches to running, posts, and returns ok', async () => {
    const dispatch = vi.fn(async () => ({ agentId: 'agent-9', runId: 'run-9' }));
    const { deps, store, posts } = makeDeps({ dispatch });

    const res = await handleDispatchCloudAgent(
      makeCall({ repo: 'sym', task: 'fix the flaky test', branch: 'dev' }),
      deps,
    );

    expect(res.ok).toBe(true);
    expect(dispatch).toHaveBeenCalledWith({
      repoUrl: 'https://github.com/o/sym',
      task: 'fix the flaky test',
      startingRef: 'dev',
    });
    const run = store.getByRunId('run-9');
    expect(run?.status).toBe('running');
    expect(run?.agentId).toBe('agent-9');
    expect(run?.channel).toBe('C1');
    expect(posts).toHaveLength(1);
    expect(posts[0]?.thread_ts).toBe('T1');
  });

  it('marks the intent row error and returns a failure when dispatch throws (no orphan)', async () => {
    const dispatch = vi.fn(async () => {
      throw new Error('boom');
    });
    const { deps, store, posts } = makeDeps({ dispatch });

    const res = await handleDispatchCloudAgent(makeCall({ repo: 'sym', task: 'do x' }), deps);

    expect(res.ok).toBe(false);
    // The intent row exists (written before dispatch) and is now terminal-error.
    const active = store.listActive();
    expect(active).toHaveLength(1);
    expect(active[0]?.status).toBe('error');
    expect(posts).toHaveLength(0);
  });
});
