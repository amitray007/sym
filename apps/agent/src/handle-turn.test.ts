import { describe, expect, it, vi } from 'vitest';

import { handleTurn } from './handle-turn.js';

import type {
  AppendStreamParams,
  ConversationsHistoryResult,
  ConversationsRepliesResult,
  PostMessageParams,
  PostMessageResult,
  SetStatusParams,
  SlackClient,
  SlackThreadMessage,
  StartStreamParams,
  StopStreamParams,
  StreamHandle,
} from '@sym/adapter-slack';
import type { AppendInput } from '@sym/audit';
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
  /** Channel history the mock returns from conversationsHistory (set per test). */
  historyMessages: SlackThreadMessage[] = [];

  /** Captured chatStartStream calls. */
  readonly startStreamCalls: StartStreamParams[] = [];
  /** All appended markdown text, concatenated in order. */
  appendedText = '';
  /** Captured chatStopStream calls. */
  readonly stopStreamCalls: StopStreamParams[] = [];
  /** Captured assistantThreadsSetStatus calls. */
  readonly setStatusCalls: SetStatusParams[] = [];

  /** When truthy, chatStartStream rejects with this error. */
  startStreamError: Error | undefined = undefined;

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
  async assistantThreadsSetStatus(params: SetStatusParams): Promise<void> {
    this.setStatusCalls.push(params);
  }
  async conversationsReplies(): Promise<ConversationsRepliesResult> {
    return { messages: this.replies };
  }
  async conversationsHistory(): Promise<ConversationsHistoryResult> {
    return { messages: this.historyMessages };
  }
  async assistantThreadsSetSuggestedPrompts(): Promise<void> {
    /* no-op mock */
  }
  async assistantThreadsSetTitle(): Promise<void> {
    /* no-op mock */
  }
  async chatStartStream(params: StartStreamParams): Promise<StreamHandle> {
    this.startStreamCalls.push(params);
    if (this.startStreamError !== undefined) {
      throw this.startStreamError;
    }
    return { channel: params.channel, ts: '111.stream' as SlackThreadTs };
  }
  async chatAppendStream(params: AppendStreamParams): Promise<void> {
    this.appendedText += params.markdownText;
  }
  async chatStopStream(params: StopStreamParams): Promise<void> {
    this.stopStreamCalls.push(params);
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
      slackTeamId: 'T-TEST',
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

  it('streams (not chatPostMessage) when the turn is threaded (app_mention)', async () => {
    const slack = new MockSlackClient();
    await handleTurn(makeTurn({ threadTs: '900.1' as SlackThreadTs }), {
      db: stubDb(),
      provider: fakeProvider,
      model: 'test-model',
      slackClient: slack,
      botUserId: BOT,
      slackTeamId: 'T-TEST',
    });

    // Streaming path was taken — no chatPostMessage.
    expect(slack.posts).toHaveLength(0);

    // chatStartStream was called with the thread ts.
    expect(slack.startStreamCalls).toHaveLength(1);
    const start = slack.startStreamCalls[0]!;
    expect(start.threadTs).toBe('900.1');

    // app_mention is NOT a DM, so recipient ids are set.
    expect(start.recipientUserId).toBe('U1');
    expect(start.recipientTeamId).toBe('T-TEST');
  });

  it('streams a DM turn, calls setStatus, and startStream has no recipient ids', async () => {
    const slack = new MockSlackClient();
    await handleTurn(makeTurn({ entrySurface: 'dm', threadTs: '500.0' as SlackThreadTs }), {
      db: stubDb(),
      provider: fakeProvider,
      model: 'test-model',
      slackClient: slack,
      botUserId: BOT,
      slackTeamId: 'T-TEST',
    });

    // setStatus was called for DM/assistant thread.
    expect(slack.setStatusCalls).toHaveLength(1);
    expect(slack.setStatusCalls[0]?.status).toBe('is thinking…');

    // startStream was called WITHOUT recipient ids (DM/assistant thread).
    expect(slack.startStreamCalls).toHaveLength(1);
    const start = slack.startStreamCalls[0]!;
    expect('recipientUserId' in start).toBe(false);
    expect('recipientTeamId' in start).toBe(false);

    // Appended text equals the full model output.
    expect(slack.appendedText).toBe('Hello world');

    // stopStream was called with a receipt block.
    expect(slack.stopStreamCalls).toHaveLength(1);
    const stop = slack.stopStreamCalls[0]!;
    expect(stop.blocks).toHaveLength(1);
    expect((stop.blocks as { type: string }[])[0]?.type).toBe('context');

    // No chatPostMessage.
    expect(slack.posts).toHaveLength(0);
  });

  it('falls back to chatPostMessage when chatStartStream rejects', async () => {
    const slack = new MockSlackClient();
    slack.startStreamError = new Error('stream_unavailable');

    await handleTurn(makeTurn({ threadTs: '900.1' as SlackThreadTs }), {
      db: stubDb(),
      provider: fakeProvider,
      model: 'test-model',
      slackClient: slack,
      botUserId: BOT,
      slackTeamId: 'T-TEST',
    });

    // Fell back to postMessage.
    expect(slack.posts).toHaveLength(1);
    expect(slack.posts[0]?.text).toBe('Hello world');

    // startStream was attempted once then failed; no appendStream / stopStream.
    expect(slack.startStreamCalls).toHaveLength(1);
    expect(slack.appendedText).toBe('');
    expect(slack.stopStreamCalls).toHaveLength(0);
  });

  it('skips posting when the turn has no channel', async () => {
    const slack = new MockSlackClient();
    await handleTurn(makeTurn({ channelId: undefined }), {
      db: stubDb(),
      provider: fakeProvider,
      model: 'test-model',
      slackClient: slack,
      botUserId: BOT,
      slackTeamId: 'T-TEST',
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
        slackTeamId: 'T-TEST',
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

  it('wired round-trip: builtin get_current_time dispatched, final text streamed without error', async () => {
    // Call-counter provider: call 1 emits a tool_call, call 2 emits final text.
    let providerCallCount = 0;
    const twoStepProvider: ProviderInterface = {
      id: 'two-step',
      async *complete(): AsyncIterable<CompletionChunk> {
        providerCallCount++;
        if (providerCallCount === 1) {
          yield {
            delta: {
              toolCalls: [{ index: 0, id: 'tc1', name: 'get_current_time', argumentsDelta: '{}' }],
            },
          };
          yield { delta: {}, finishReason: 'tool_calls' };
        } else {
          yield { delta: { content: 'The time is now.' }, finishReason: 'stop' };
        }
      },
    };

    const slack = new MockSlackClient();
    await handleTurn(makeTurn({ entrySurface: 'dm', threadTs: '500.0' as SlackThreadTs }), {
      db: stubDb(),
      provider: twoStepProvider,
      model: 'test-model',
      slackClient: slack,
      botUserId: BOT,
      slackTeamId: 'T-TEST',
    });

    // Provider was called twice (tool loop ran).
    expect(providerCallCount).toBe(2);

    // Final reply text is from step 2.
    expect(slack.appendedText).toContain('The time is now.');

    // No errors — streaming completed normally (stopStream was called).
    expect(slack.stopStreamCalls).toHaveLength(1);
    expect(slack.posts).toHaveLength(0);
  });

  it('prepends viewed-channel background context as the first history message for DM turns', async () => {
    const slack = new MockSlackClient();
    // The channel the user is viewing has these recent messages (oldest-first).
    slack.historyMessages = [
      { user: 'U1' as SlackUserId, text: 'deploy went out', ts: '800.1' as SlackThreadTs },
      { user: 'U2' as SlackUserId, text: 'looks good to me', ts: '800.2' as SlackThreadTs },
    ];
    const cap = capturingProvider();

    await handleTurn(
      makeTurn({
        entrySurface: 'dm',
        channelId: 'D1' as SlackChannelId,
        threadTs: '500.0' as SlackThreadTs,
        text: 'summarize this channel',
      }),
      {
        db: stubDb(),
        provider: cap.provider,
        model: 'test-model',
        slackClient: slack,
        botUserId: BOT,
        slackTeamId: 'T-TEST',
        viewedChannelId: 'C-VIEWED',
      },
    );

    const messages = cap.captured();
    // The background context block must be the FIRST history message (after system prompt).
    const backgroundMsg = messages[1];
    expect(backgroundMsg?.content).toMatch(
      /^Background — the user is currently viewing channel C-VIEWED in Slack\./,
    );
    expect(backgroundMsg?.content).toContain('deploy went out');
    expect(backgroundMsg?.content).toContain('looks good to me');
  });

  it('calls the audit sink with app.turn.complete after the reply is delivered (stream path)', async () => {
    const auditCalls: AppendInput[] = [];
    const audit = vi.fn((input: AppendInput) => {
      auditCalls.push(input);
      return Promise.resolve();
    });

    const slack = new MockSlackClient();
    const turn = makeTurn({ entrySurface: 'dm', threadTs: '500.0' as SlackThreadTs });

    await handleTurn(turn, {
      db: stubDb(),
      provider: fakeProvider,
      model: 'test-model',
      slackClient: slack,
      botUserId: BOT,
      slackTeamId: 'T-TEST',
      audit,
    });

    // Audit must be called exactly once (stream path).
    expect(audit).toHaveBeenCalledTimes(1);

    const call = auditCalls[0]!;
    expect(call.kind).toBe('app.turn.complete');
    expect(call.workspaceId).toBe(turn.workspaceId);
    expect(call.actorKind).toBe('slack_user');
    expect(call.actorId).toBe(turn.requester);
    expect(call.targetKind).toBe('conversation');
    expect(call.targetId).toBe(turn.conversationId);

    // Payload must contain model + toolsInvoked.
    expect(typeof call.payload['model']).toBe('string');
    expect(Array.isArray(call.payload['toolsInvoked'])).toBe(true);
  });

  it('calls the audit sink with app.turn.complete after the reply is delivered (post path)', async () => {
    const auditCalls: AppendInput[] = [];
    const audit = vi.fn((input: AppendInput) => {
      auditCalls.push(input);
      return Promise.resolve();
    });

    const slack = new MockSlackClient();
    // No threadTs → postMessage path (no streaming).
    const turn = makeTurn({ entrySurface: 'app_mention' });

    await handleTurn(turn, {
      db: stubDb(),
      provider: fakeProvider,
      model: 'test-model',
      slackClient: slack,
      botUserId: BOT,
      slackTeamId: 'T-TEST',
      audit,
    });

    expect(slack.posts).toHaveLength(1);

    expect(audit).toHaveBeenCalledTimes(1);
    const call = auditCalls[0]!;
    expect(call.kind).toBe('app.turn.complete');
    expect(Array.isArray(call.payload['toolsInvoked'])).toBe(true);
  });

  it('does not call audit when audit dep is absent (existing tests stay green)', async () => {
    // Simply running without an audit dep must not throw.
    const slack = new MockSlackClient();
    await expect(
      handleTurn(makeTurn(), {
        db: stubDb(),
        provider: fakeProvider,
        model: 'test-model',
        slackClient: slack,
        botUserId: BOT,
        slackTeamId: 'T-TEST',
        // no audit
      }),
    ).resolves.toBeUndefined();
    expect(slack.posts).toHaveLength(1);
  });
});
