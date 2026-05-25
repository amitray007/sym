import { describe, expect, it } from 'vitest';

import { handleTurn } from './handle-turn.js';

import type { PostMessageParams, PostMessageResult, SlackClient } from '@sym/adapter-slack';
import type {
  CompletionChunk,
  ProviderInterface,
  SlackChannelId,
  SlackThreadTs,
  SlackUserId,
  Turn,
  TurnId,
  WorkspaceId,
} from '@sym/contracts';
import type { Database } from '@sym/db';

/**
 * Minimal chainable no-op `Database` stub. Persistence is exercised against real
 * Postgres in integration tests; here it must satisfy the type and stay out of
 * the way of the reply assertions (every query resolves to an empty result).
 */
function stubDb(): Database {
  const h = {
    insert: () => h,
    values: () => h,
    onConflictDoNothing: () => h,
    select: () => h,
    from: () => h,
    where: () => h,
    orderBy: () => h,
    limit: () => Promise.resolve([]),
    update: () => h,
    set: () => h,
    then: (onF: (v: unknown[]) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve([]).then(onF, onR),
  };
  return h as unknown as Database;
}

class MockSlackClient implements SlackClient {
  readonly posts: PostMessageParams[] = [];
  async chatPostMessage(params: PostMessageParams): Promise<PostMessageResult> {
    this.posts.push(params);
    return { ts: '111.222' as SlackThreadTs, channel: params.channel };
  }
  async chatUpdate(): Promise<void> {
    /* no-op mock */
  }
  async reactionsAdd(): Promise<void> {
    /* no-op mock */
  }
  async assistantThreadsSetStatus(): Promise<void> {
    /* no-op mock */
  }
}

const fakeProvider: ProviderInterface = {
  id: 'fake',
  async *complete(): AsyncIterable<CompletionChunk> {
    yield { delta: { content: 'Hello ' } };
    yield { delta: { content: 'world' } };
    yield {
      delta: {},
      finishReason: 'stop',
      usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
    };
  },
};

function makeTurn(overrides: Partial<Turn> = {}): Turn {
  return {
    id: 'turn-1' as TurnId,
    workspaceId: 'ws-1' as WorkspaceId,
    conversationId: 'ws-1:C1' as Turn['conversationId'],
    entrySurface: 'app_mention',
    requester: 'U1' as SlackUserId,
    channelId: 'C1' as SlackChannelId,
    text: 'hi sym',
    receivedAt: new Date(),
    ...overrides,
  };
}

describe('handleTurn', () => {
  it('runs the loop and posts the reply with a markdown block + receipt footer', async () => {
    const slack = new MockSlackClient();
    await handleTurn(makeTurn(), {
      db: stubDb(),
      provider: fakeProvider,
      model: 'test-model',
      slackClient: slack,
    });

    expect(slack.posts).toHaveLength(1);
    const post = slack.posts[0]!;
    expect(post.channel).toBe('C1');
    expect(post.text).toBe('Hello world');

    const blocks = (post.blocks ?? []) as { type: string; text?: string }[];
    expect(blocks[0]?.type).toBe('markdown');
    expect(blocks[0]?.text).toBe('Hello world');
    expect(blocks[1]?.type).toBe('context'); // receipt footer
  });

  it('replies in-thread when the turn is threaded', async () => {
    const slack = new MockSlackClient();
    await handleTurn(makeTurn({ threadTs: '900.1' as SlackThreadTs }), {
      db: stubDb(),
      provider: fakeProvider,
      model: 'test-model',
      slackClient: slack,
    });
    expect(slack.posts[0]?.thread_ts).toBe('900.1');
  });

  it('skips posting when the turn has no channel', async () => {
    const slack = new MockSlackClient();
    await handleTurn(makeTurn({ channelId: undefined }), {
      db: stubDb(),
      provider: fakeProvider,
      model: 'test-model',
      slackClient: slack,
    });
    expect(slack.posts).toHaveLength(0);
  });
});
