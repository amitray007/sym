import { beforeEach, describe, expect, it, vi } from 'vitest';

import { handleTurn } from './handle-turn.js';

// ---------------------------------------------------------------------------
// Mock the Pi loop so tests are hermetic (no real HTTP calls to Fireworks).
// vi.mock is hoisted before imports, so we can't reference module-scope vars
// inside the factory — instead we export a ref from the mock that tests drive.
// ---------------------------------------------------------------------------

vi.mock('./pi/loop.js', () => {
  const mockFn = vi.fn();
  return { runLoopPi: mockFn, __mockRunLoopPi: mockFn };
});

import * as piLoopModule from './pi/loop.js';

// Typed handle to the hoisted mock — cast through unknown to reach the hidden export.
const mockRunLoopPi = (piLoopModule as unknown as { __mockRunLoopPi: ReturnType<typeof vi.fn> })
  .__mockRunLoopPi;

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
  Reply,
  SlackChannelId,
  SlackThreadTs,
  SlackUserId,
  Turn,
  TurnId,
  WorkspaceId,
} from '@sym/contracts';
import type { Database } from '@sym/db';

// ---------------------------------------------------------------------------
// Fake Fireworks credentials (value doesn't matter — Pi is mocked).
// ---------------------------------------------------------------------------

const FAKE_FIREWORKS = { baseUrl: 'http://fake.fireworks', apiKey: 'fake-key' };

// ---------------------------------------------------------------------------
// Default reply returned by the mock loop unless overridden.
// ---------------------------------------------------------------------------

function makeReply(overrides: Partial<Reply> = {}): Reply {
  return {
    turnId: 'turn-1' as TurnId,
    markdown: 'Hello world',
    receipt: {
      turnId: 'turn-1' as TurnId,
      model: 'test-model',
      toolsInvoked: [],
      durationMs: 10,
    },
    ...overrides,
  };
}

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
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs the loop and posts the reply with a markdown block + receipt footer', async () => {
    mockRunLoopPi.mockResolvedValueOnce(makeReply());
    const slack = new MockSlackClient();
    await handleTurn(makeTurn(), {
      db: stubDb(),
      fireworks: FAKE_FIREWORKS,
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
    // The mock streams deltas via onDelta so appendedText is populated.
    mockRunLoopPi.mockImplementationOnce(
      async (_turn: unknown, _cfg: unknown, _reg: unknown, opts: unknown) => {
        const o = opts as { onDelta?: (d: string) => Promise<void> };
        await o.onDelta?.('Hello ');
        await o.onDelta?.('world');
        return makeReply({ markdown: 'Hello world' });
      },
    );

    const slack = new MockSlackClient();
    await handleTurn(makeTurn({ threadTs: '900.1' as SlackThreadTs }), {
      db: stubDb(),
      fireworks: FAKE_FIREWORKS,
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
    mockRunLoopPi.mockImplementationOnce(
      async (_turn: unknown, _cfg: unknown, _reg: unknown, opts: unknown) => {
        const o = opts as { onDelta?: (d: string) => Promise<void> };
        await o.onDelta?.('Hello ');
        await o.onDelta?.('world');
        return makeReply({ markdown: 'Hello world' });
      },
    );

    const slack = new MockSlackClient();
    await handleTurn(makeTurn({ entrySurface: 'dm', threadTs: '500.0' as SlackThreadTs }), {
      db: stubDb(),
      fireworks: FAKE_FIREWORKS,
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
    // Pi loop is called once per path. startStream fails → fallback calls the loop again.
    mockRunLoopPi.mockResolvedValue(makeReply());

    const slack = new MockSlackClient();
    slack.startStreamError = new Error('stream_unavailable');

    await handleTurn(makeTurn({ threadTs: '900.1' as SlackThreadTs }), {
      db: stubDb(),
      fireworks: FAKE_FIREWORKS,
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
      fireworks: FAKE_FIREWORKS,
      model: 'test-model',
      slackClient: slack,
      botUserId: BOT,
      slackTeamId: 'T-TEST',
    });
    expect(slack.posts).toHaveLength(0);
    // runLoopPi must not be called when there is no channelId.
    expect(mockRunLoopPi).not.toHaveBeenCalled();
  });

  it('feeds the live Slack thread as history on a channel mention, excluding the trigger', async () => {
    let capturedHistory: ChatMessage[] = [];
    mockRunLoopPi.mockImplementationOnce(
      async (_turn: unknown, _cfg: unknown, _reg: unknown, opts: unknown) => {
        capturedHistory = (opts as { history?: ChatMessage[] }).history ?? [];
        return makeReply();
      },
    );

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

    await handleTurn(
      makeTurn({
        threadTs: '900.1' as SlackThreadTs,
        ts: '900.3' as SlackThreadTs, // the triggering mention
        text: 'summarize the risks',
      }),
      {
        db: stubDb(),
        fireworks: FAKE_FIREWORKS,
        model: 'test-model',
        slackClient: slack,
        botUserId: BOT,
        slackTeamId: 'T-TEST',
      },
    );

    // Earlier human + Sym messages become labelled history; Sym's is assistant.
    expect(capturedHistory).toEqual([
      { role: 'user', content: 'U1: we should migrate to PG16' },
      { role: 'assistant', content: 'here were the tradeoffs' },
    ]);
  });

  it('runLoopPi is called: verifies the Pi path is always taken (tool receipt flows through)', async () => {
    mockRunLoopPi.mockImplementationOnce(
      async (_turn: unknown, _cfg: unknown, _reg: unknown, opts: unknown) => {
        const o = opts as { onDelta?: (d: string) => Promise<void> };
        await o.onDelta?.('The time is now.');
        return makeReply({
          markdown: 'The time is now.',
          receipt: {
            turnId: 'turn-1' as TurnId,
            model: 'test-model',
            toolsInvoked: ['get_current_time'],
            durationMs: 10,
          },
        });
      },
    );

    const slack = new MockSlackClient();
    await handleTurn(makeTurn({ entrySurface: 'dm', threadTs: '500.0' as SlackThreadTs }), {
      db: stubDb(),
      fireworks: FAKE_FIREWORKS,
      model: 'test-model',
      slackClient: slack,
      botUserId: BOT,
      slackTeamId: 'T-TEST',
    });

    // Pi was called exactly once.
    expect(mockRunLoopPi).toHaveBeenCalledOnce();

    // Final reply text came through the streaming path.
    expect(slack.appendedText).toBe('The time is now.');
    expect(slack.stopStreamCalls).toHaveLength(1);
    expect(slack.posts).toHaveLength(0);
  });

  it('prepends viewed-channel background context as the first history message for DM turns', async () => {
    let capturedHistory: ChatMessage[] = [];
    mockRunLoopPi.mockImplementationOnce(
      async (_turn: unknown, _cfg: unknown, _reg: unknown, opts: unknown) => {
        capturedHistory = (opts as { history?: ChatMessage[] }).history ?? [];
        return makeReply();
      },
    );

    const slack = new MockSlackClient();
    // The channel the user is viewing has these recent messages (oldest-first).
    slack.historyMessages = [
      { user: 'U1' as SlackUserId, text: 'deploy went out', ts: '800.1' as SlackThreadTs },
      { user: 'U2' as SlackUserId, text: 'looks good to me', ts: '800.2' as SlackThreadTs },
    ];

    await handleTurn(
      makeTurn({
        entrySurface: 'dm',
        channelId: 'D1' as SlackChannelId,
        threadTs: '500.0' as SlackThreadTs,
        text: 'summarize this channel',
      }),
      {
        db: stubDb(),
        fireworks: FAKE_FIREWORKS,
        model: 'test-model',
        slackClient: slack,
        botUserId: BOT,
        slackTeamId: 'T-TEST',
        viewedChannelId: 'C-VIEWED',
      },
    );

    // The background context block must be the FIRST history message.
    const backgroundMsg = capturedHistory[0];
    expect(backgroundMsg?.content).toMatch(
      /^Background — the user is currently viewing channel C-VIEWED in Slack\./,
    );
    expect(backgroundMsg?.content).toContain('deploy went out');
    expect(backgroundMsg?.content).toContain('looks good to me');
  });

  it('calls the audit sink with app.turn.complete after the reply is delivered (stream path)', async () => {
    mockRunLoopPi.mockImplementationOnce(
      async (_turn: unknown, _cfg: unknown, _reg: unknown, opts: unknown) => {
        const o = opts as { onDelta?: (d: string) => Promise<void> };
        await o.onDelta?.('reply');
        return makeReply({ markdown: 'reply' });
      },
    );

    const auditCalls: AppendInput[] = [];
    const audit = vi.fn((input: AppendInput) => {
      auditCalls.push(input);
      return Promise.resolve();
    });

    const slack = new MockSlackClient();
    const turn = makeTurn({ entrySurface: 'dm', threadTs: '500.0' as SlackThreadTs });

    await handleTurn(turn, {
      db: stubDb(),
      fireworks: FAKE_FIREWORKS,
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
    mockRunLoopPi.mockResolvedValueOnce(makeReply());

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
      fireworks: FAKE_FIREWORKS,
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
    mockRunLoopPi.mockResolvedValueOnce(makeReply());

    // Simply running without an audit dep must not throw.
    const slack = new MockSlackClient();
    await expect(
      handleTurn(makeTurn(), {
        db: stubDb(),
        fireworks: FAKE_FIREWORKS,
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
