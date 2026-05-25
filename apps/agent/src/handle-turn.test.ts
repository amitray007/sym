import { describe, expect, it } from 'vitest';

import { handleTurn } from './handle-turn.js';

import type {
  ConversationsRepliesResult,
  PostMessageParams,
  PostMessageResult,
  SlackClient,
  SlackThreadMessage,
} from '@sym/adapter-slack';
import type {
  ChatMessage,
  CompletionChunk,
  CompletionRequest,
  ProviderInterface,
  SlackChannelId,
  SlackThreadTs,
  SlackUserId,
  Turn,
  TurnId,
  WorkspaceId,
} from '@sym/contracts';
import type { Database } from '@sym/db';

const BOT = 'UBOT' as SlackUserId;

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
  /** Thread the mock returns from conversationsReplies (set per test). */
  replies: SlackThreadMessage[] = [];
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
  async conversationsReplies(): Promise<ConversationsRepliesResult> {
    return { messages: this.replies };
  }
}

/** A provider that records the messages it was asked to complete. */
function capturingProvider(): { provider: ProviderInterface; captured: () => ChatMessage[] } {
  let seen: ChatMessage[] = [];
  const provider: ProviderInterface = {
    id: 'capture',
    async *complete(req: CompletionRequest): AsyncIterable<CompletionChunk> {
      seen = req.messages;
      yield { delta: { content: 'ok' } };
      yield {
        delta: {},
        finishReason: 'stop',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    },
  };
  return { provider, captured: () => seen };
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
      botUserId: BOT,
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
      botUserId: BOT,
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
      botUserId: BOT,
    });
    expect(slack.posts).toHaveLength(0);
  });

  it('feeds the live Slack thread as history on a channel mention, excluding the trigger', async () => {
    const slack = new MockSlackClient();
    slack.replies = [
      {
        user: 'U1' as SlackUserId,
        text: 'we should migrate to PG16',
        ts: '900.1' as SlackThreadTs,
      },
      { user: BOT, text: 'here were the tradeoffs', ts: '900.2' as SlackThreadTs },
      {
        user: 'U2' as SlackUserId,
        text: '<@UBOT> summarize the risks',
        ts: '900.3' as SlackThreadTs,
      },
    ];
    const cap = capturingProvider();

    await handleTurn(
      makeTurn({
        threadTs: '900.1' as SlackThreadTs,
        ts: '900.3' as SlackThreadTs, // the triggering mention
        text: 'summarize the risks',
      }),
      {
        db: stubDb(),
        provider: cap.provider,
        model: 'test-model',
        slackClient: slack,
        botUserId: BOT,
      },
    );

    const messages = cap.captured();
    const history = messages.slice(1, -1); // drop the system prompt + the final turn

    // Earlier human + Sym messages become labelled history; Sym's is assistant.
    expect(history).toEqual([
      { role: 'user', content: 'U1: we should migrate to PG16' },
      { role: 'assistant', content: 'here were the tradeoffs' },
    ]);
    // The triggering message appears once — as the current turn, not in history.
    const mentions = messages.filter((m) => m.content?.includes('summarize the risks'));
    expect(mentions).toHaveLength(1);
    expect(messages.at(-1)?.role).toBe('user');
  });
});
