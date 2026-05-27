import { beforeEach, describe, expect, it, vi } from 'vitest';

import { handleTurn } from '../src/handle-turn.js';

import type * as PiLoopModuleType from '../src/pi/loop.js';

// ---------------------------------------------------------------------------
// Mock the Pi loop so tests are hermetic (no real HTTP calls to Fireworks).
// vi.mock is hoisted before imports, so we can't reference module-scope vars
// inside the factory — instead we export a ref from the mock that tests drive.
// ---------------------------------------------------------------------------

vi.mock('../src/pi/loop.js', async (importOriginal) => {
  // Partial mock: stub runLoopPi (hermetic — no real HTTP), but keep the real
  // exports for whimsy helpers (WHIMSY_WORDS, nextWhimsicalStatus) that
  // handle-turn imports.
  const actual = await importOriginal<typeof PiLoopModuleType>();
  const mockFn = vi.fn();
  return { ...actual, runLoopPi: mockFn, __mockRunLoopPi: mockFn };
});

import * as piLoopModule from '../src/pi/loop.js';

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
  SetTitleParams,
  SlackClient,
  SlackThreadMessage,
  StartStreamParams,
  StopStreamParams,
  StreamHandle,
} from '@sym/adapter-slack';
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

// ---------------------------------------------------------------------------
// Fake Fireworks credentials (value doesn't matter — Pi is mocked).
// ---------------------------------------------------------------------------

const FAKE_FIREWORKS = { baseUrl: 'http://fake.fireworks', apiKey: 'fake-key' };
const FAKE_BEHAVIOR = {
  taskCardThreshold: 0,
  taskCardAfter: 'delete' as const,
  ownerPostMarker: true,
};

// ---------------------------------------------------------------------------
// Default reply returned by the mock loop unless overridden.
// ---------------------------------------------------------------------------

function makeReply(overrides: Partial<Reply> = {}): Reply {
  return {
    turnId: 'turn-1' as TurnId,
    markdown: 'Hello world',
    receipt: {
      turnId: 'turn-1' as TurnId,
      model: 'accounts/fireworks/models/gpt-oss-120b',
      toolsInvoked: [],
      durationMs: 10,
    },
    ...overrides,
  };
}

const BOT = 'UBOT' as SlackUserId;

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
  /** Captured assistantThreadsSetTitle calls. */
  readonly setTitleCalls: SetTitleParams[] = [];

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
  async assistantThreadsSetTitle(params: SetTitleParams): Promise<void> {
    this.setTitleCalls.push(params);
  }
  async chatStartStream(params: StartStreamParams): Promise<StreamHandle> {
    this.startStreamCalls.push(params);
    if (this.startStreamError !== undefined) {
      throw this.startStreamError;
    }
    return { channel: params.channel, ts: '111.stream' as SlackThreadTs };
  }
  async chatAppendStream(params: AppendStreamParams): Promise<void> {
    if (params.markdownText !== undefined) {
      this.appendedText += params.markdownText;
    }
  }
  async chatStopStream(params: StopStreamParams): Promise<void> {
    this.stopStreamCalls.push(params);
  }
  async chatDelete(): Promise<void> {
    /* no-op mock */
  }
  async usersInfo() {
    return { id: 'U0' as SlackUserId };
  }
  async conversationsList() {
    return { channels: [] };
  }
  async authTest() {
    return { userId: 'U0' as SlackUserId, teamId: 'T-TEST' };
  }
  async searchMessages() {
    return { matches: [], total: 0 };
  }
  async usersProfileSet() {
    /* no-op mock */
  }
  async remindersAdd() {
    return { id: 'Rm0', text: '' };
  }
}

function makeTurn(overrides: Partial<Turn> = {}): Turn {
  return Object.assign(
    {
      id: 'turn-1' as TurnId,
      workspaceId: 'ws-1' as WorkspaceId,
      conversationId: 'ws-1:C1' as Turn['conversationId'],
      entrySurface: 'app_mention' as const,
      requester: 'U1' as SlackUserId,
      channelId: 'C1' as SlackChannelId,
      text: 'hi sym',
      receivedAt: new Date(),
    },
    overrides,
  ) as Turn;
}

describe('handleTurn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs the loop and posts the reply with a markdown block + receipt footer', async () => {
    mockRunLoopPi.mockResolvedValueOnce(makeReply());
    const slack = new MockSlackClient();
    await handleTurn(makeTurn(), {
      fireworks: FAKE_FIREWORKS,
      model: 'accounts/fireworks/models/gpt-oss-120b',
      slackClient: slack,
      botUserId: BOT,
      slackTeamId: 'T-TEST',
      behavior: FAKE_BEHAVIOR,
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
      fireworks: FAKE_FIREWORKS,
      model: 'accounts/fireworks/models/gpt-oss-120b',
      slackClient: slack,
      botUserId: BOT,
      slackTeamId: 'T-TEST',
      behavior: FAKE_BEHAVIOR,
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

    // setStatus is now called for channel @-mentions too (Slack 2026-03-05
    // changelog made the API work in channel threads with chat:write).
    expect(slack.setStatusCalls.length).toBeGreaterThanOrEqual(1);
    expect(slack.setStatusCalls[0]?.status).toBe('is thinking…');
  });

  it('forwards Pi-loop onStatus emissions to Slack setStatus with the right phase strings', async () => {
    mockRunLoopPi.mockImplementationOnce(
      async (_turn: unknown, _cfg: unknown, _reg: unknown, opts: unknown) => {
        const o = opts as {
          onDelta?: (d: string) => Promise<void>;
          onStatus?: (s: string) => Promise<void>;
        };
        // Simulate the loop emitting a tool-phase status and then "writing".
        await o.onStatus?.('is searching Slack…');
        await o.onStatus?.('is writing the reply…');
        await o.onDelta?.('done');
        return makeReply({ markdown: 'done' });
      },
    );

    const slack = new MockSlackClient();
    await handleTurn(makeTurn({ threadTs: '900.1' as SlackThreadTs }), {
      fireworks: FAKE_FIREWORKS,
      model: 'accounts/fireworks/models/gpt-oss-120b',
      slackClient: slack,
      botUserId: BOT,
      slackTeamId: 'T-TEST',
      behavior: FAKE_BEHAVIOR,
    });

    const statuses = slack.setStatusCalls.map((c) => c.status);
    // Initial "is thinking…" + two loop emissions + the trailing '' clear
    // (stopStream does not auto-clear setStatus, so we do it explicitly).
    expect(statuses).toEqual(['is thinking…', 'is searching Slack…', 'is writing the reply…', '']);
  });

  // NOTE: we intentionally don't test the 90s keepalive timer. Fake-timer
  // interactions with async setStatus calls are flaky and the keepalive is a
  // straight setInterval/clearInterval pair around the stream path.

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
      fireworks: FAKE_FIREWORKS,
      model: 'accounts/fireworks/models/gpt-oss-120b',
      slackClient: slack,
      botUserId: BOT,
      slackTeamId: 'T-TEST',
      behavior: FAKE_BEHAVIOR,
    });

    // setStatus: initial 'is thinking…' + trailing '' clear after stopStream.
    expect(slack.setStatusCalls).toHaveLength(2);
    expect(slack.setStatusCalls[0]?.status).toBe('is thinking…');
    expect(slack.setStatusCalls[1]?.status).toBe('');

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
    // Drive a delta so the lazy startStream is actually attempted — otherwise
    // the no-deltas path posts directly without ever calling startStream.
    mockRunLoopPi.mockImplementationOnce(
      async (_turn: unknown, _cfg: unknown, _reg: unknown, opts: unknown) => {
        const o = opts as { onDelta?: (d: string) => Promise<void> };
        await o.onDelta?.('Hello world');
        return makeReply();
      },
    );

    const slack = new MockSlackClient();
    slack.startStreamError = new Error('stream_unavailable');

    await handleTurn(makeTurn({ threadTs: '900.1' as SlackThreadTs }), {
      fireworks: FAKE_FIREWORKS,
      model: 'accounts/fireworks/models/gpt-oss-120b',
      slackClient: slack,
      botUserId: BOT,
      slackTeamId: 'T-TEST',
      behavior: FAKE_BEHAVIOR,
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
    const noChannelTurn = makeTurn();
    delete (noChannelTurn as Partial<Turn>).channelId;
    await handleTurn(noChannelTurn, {
      fireworks: FAKE_FIREWORKS,
      model: 'accounts/fireworks/models/gpt-oss-120b',
      slackClient: slack,
      botUserId: BOT,
      slackTeamId: 'T-TEST',
      behavior: FAKE_BEHAVIOR,
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
        fireworks: FAKE_FIREWORKS,
        model: 'accounts/fireworks/models/gpt-oss-120b',
        slackClient: slack,
        botUserId: BOT,
        slackTeamId: 'T-TEST',
        behavior: FAKE_BEHAVIOR,
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
            model: 'accounts/fireworks/models/gpt-oss-120b',
            toolsInvoked: ['get_current_time'],
            durationMs: 10,
          },
        });
      },
    );

    const slack = new MockSlackClient();
    await handleTurn(makeTurn({ entrySurface: 'dm', threadTs: '500.0' as SlackThreadTs }), {
      fireworks: FAKE_FIREWORKS,
      model: 'accounts/fireworks/models/gpt-oss-120b',
      slackClient: slack,
      botUserId: BOT,
      slackTeamId: 'T-TEST',
      behavior: FAKE_BEHAVIOR,
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
        fireworks: FAKE_FIREWORKS,
        model: 'accounts/fireworks/models/gpt-oss-120b',
        slackClient: slack,
        botUserId: BOT,
        slackTeamId: 'T-TEST',
        behavior: FAKE_BEHAVIOR,
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

  it('derives a thread title from the user message on the first DM turn', async () => {
    mockRunLoopPi.mockResolvedValueOnce(makeReply());
    const slack = new MockSlackClient();

    await handleTurn(
      makeTurn({
        entrySurface: 'dm',
        channelId: 'D1' as SlackChannelId,
        threadTs: '500.0' as SlackThreadTs,
        text: '<@UBOT> summarize the postgres migration discussion from yesterday',
      }),
      {
        fireworks: FAKE_FIREWORKS,
        model: 'accounts/fireworks/models/gpt-oss-120b',
        slackClient: slack,
        botUserId: BOT,
        slackTeamId: 'T-TEST',
        behavior: FAKE_BEHAVIOR,
      },
    );

    // Allow the fire-and-forget setTitle to settle.
    await new Promise((r) => setTimeout(r, 0));

    expect(slack.setTitleCalls).toHaveLength(1);
    expect(slack.setTitleCalls[0]?.channelId).toBe('D1');
    expect(slack.setTitleCalls[0]?.threadTs).toBe('500.0');
    // Bot mention is stripped; title starts with capitalised first word.
    expect(slack.setTitleCalls[0]?.title).toMatch(/^Summarize/);
  });

  it('does NOT override the thread title once the user already has prior turns', async () => {
    mockRunLoopPi.mockResolvedValueOnce(makeReply());
    const slack = new MockSlackClient();
    // Prior user turn already in the thread — title should stay as-is.
    slack.replies = [
      { user: 'U1' as SlackUserId, text: 'earlier question', ts: '500.0' as SlackThreadTs },
      { user: BOT, text: 'earlier reply', ts: '500.1' as SlackThreadTs },
    ];

    await handleTurn(
      makeTurn({
        entrySurface: 'dm',
        channelId: 'D1' as SlackChannelId,
        threadTs: '500.0' as SlackThreadTs,
        ts: '500.2' as SlackThreadTs,
        text: 'follow-up question',
      }),
      {
        fireworks: FAKE_FIREWORKS,
        model: 'accounts/fireworks/models/gpt-oss-120b',
        slackClient: slack,
        botUserId: BOT,
        slackTeamId: 'T-TEST',
        behavior: FAKE_BEHAVIOR,
      },
    );

    await new Promise((r) => setTimeout(r, 0));

    expect(slack.setTitleCalls).toHaveLength(0);
  });

  it('does NOT setTitle for channel @-mentions (only assistant-panel DMs)', async () => {
    mockRunLoopPi.mockResolvedValueOnce(makeReply());
    const slack = new MockSlackClient();

    await handleTurn(
      makeTurn({ entrySurface: 'app_mention', threadTs: '900.1' as SlackThreadTs }),
      {
        fireworks: FAKE_FIREWORKS,
        model: 'accounts/fireworks/models/gpt-oss-120b',
        slackClient: slack,
        botUserId: BOT,
        slackTeamId: 'T-TEST',
        behavior: FAKE_BEHAVIOR,
      },
    );

    await new Promise((r) => setTimeout(r, 0));

    expect(slack.setTitleCalls).toHaveLength(0);
  });

  it('emits an error-status task_update chunk when a tool fails (graceful errors)', async () => {
    // Mocked loop fires onToolStart, then onToolEnd with errored=true,
    // then streams a "couldn't do X" recovery reply. We assert that the
    // task card flushes with the failed task marked status='error'.
    mockRunLoopPi.mockImplementationOnce(
      async (_turn: unknown, _cfg: unknown, _reg: unknown, opts: unknown) => {
        const o = opts as {
          onDelta?: (d: string) => Promise<void>;
          onToolStart?: (toolCallId: string, label: string) => Promise<void>;
          onToolEnd?: (toolCallId: string, errored: boolean) => Promise<void>;
        };
        await o.onToolStart?.('call-1', 'reading the channel');
        await o.onToolEnd?.('call-1', true);
        await o.onDelta?.("Couldn't read that channel — I'm not a member.");
        return makeReply({ markdown: "Couldn't read that channel — I'm not a member." });
      },
    );

    // Track chunks sent via chatAppendStream (the task_update chunks).
    const chunks: { type: string; id: string; status: string }[] = [];
    const slack = new MockSlackClient();
    const origAppend = slack.chatAppendStream.bind(slack);
    slack.chatAppendStream = async (params: AppendStreamParams): Promise<void> => {
      for (const c of params.chunks ?? []) {
        if (c.type === 'task_update') {
          chunks.push({ type: c.type, id: c.id, status: c.status });
        }
      }
      await origAppend(params);
    };

    await handleTurn(makeTurn({ threadTs: '900.1' as SlackThreadTs }), {
      fireworks: FAKE_FIREWORKS,
      model: 'accounts/fireworks/models/gpt-oss-120b',
      slackClient: slack,
      botUserId: BOT,
      slackTeamId: 'T-TEST',
      // Threshold 1 so the single tool triggers the card immediately.
      behavior: { taskCardThreshold: 1, taskCardAfter: 'delete' as const, ownerPostMarker: true },
    });

    // We expect at least an in_progress chunk then an error chunk for task-1.
    const task1 = chunks.filter((c) => c.id === 'task-1');
    expect(task1.length).toBeGreaterThanOrEqual(2);
    expect(task1[0]?.status).toBe('in_progress');
    expect(task1.at(-1)?.status).toBe('error');
  });

  it('renders task cards when Pi runs 3 tools in PARALLEL (start_A start_B start_C end_A end_B end_C)', async () => {
    // Regression: gpt-oss-120b commonly emits multiple tool calls per round
    // and Pi runs them in parallel. With a single currentTask slot, tasks
    // were overwritten before their ends fired — no cards rendered.
    mockRunLoopPi.mockImplementationOnce(
      async (_turn: unknown, _cfg: unknown, _reg: unknown, opts: unknown) => {
        const o = opts as {
          onDelta?: (d: string) => Promise<void>;
          onToolStart?: (toolCallId: string, label: string) => Promise<void>;
          onToolEnd?: (toolCallId: string, errored: boolean) => Promise<void>;
        };
        // All three starts fire BEFORE any end (parallel).
        await o.onToolStart?.('call-A', 'checking the time');
        await o.onToolStart?.('call-B', 'reading the channel');
        await o.onToolStart?.('call-C', 'looking up the user');
        // Ends interleave in completion order, not call order.
        await o.onToolEnd?.('call-B', false);
        await o.onToolEnd?.('call-A', false);
        await o.onToolEnd?.('call-C', false);
        await o.onDelta?.('here is your answer');
        return makeReply({ markdown: 'here is your answer' });
      },
    );

    const chunks: { id: string; status: string }[] = [];
    const slack = new MockSlackClient();
    const origAppend = slack.chatAppendStream.bind(slack);
    slack.chatAppendStream = async (params: AppendStreamParams): Promise<void> => {
      for (const c of params.chunks ?? []) {
        if (c.type === 'task_update') chunks.push({ id: c.id, status: c.status });
      }
      await origAppend(params);
    };

    await handleTurn(makeTurn({ threadTs: '900.1' as SlackThreadTs }), {
      fireworks: FAKE_FIREWORKS,
      model: 'accounts/fireworks/models/gpt-oss-120b',
      slackClient: slack,
      botUserId: BOT,
      slackTeamId: 'T-TEST',
      // Production-default threshold of 3 — the threshold-flush happens at
      // the third start, which is the case that was broken.
      behavior: { taskCardThreshold: 3, taskCardAfter: 'delete' as const, ownerPostMarker: true },
    });

    // All three tasks must end in `complete` (or `error`) state in the chunks.
    const task1 = chunks.filter((c) => c.id === 'task-1').at(-1);
    const task2 = chunks.filter((c) => c.id === 'task-2').at(-1);
    const task3 = chunks.filter((c) => c.id === 'task-3').at(-1);
    expect(task1?.status).toBe('complete');
    expect(task2?.status).toBe('complete');
    expect(task3?.status).toBe('complete');

    // And the FIRST chunk batch (the threshold flush) must include all three
    // tasks — that's the user-visible "cards rendered" signal.
    const ids = new Set(chunks.slice(0, 3).map((c) => c.id));
    expect(ids.has('task-1')).toBe(true);
    expect(ids.has('task-2')).toBe(true);
    expect(ids.has('task-3')).toBe(true);
  });

  it('sets task_display_mode=timeline on chatStartStream so chunks render as sequential cards', async () => {
    mockRunLoopPi.mockImplementationOnce(
      async (_turn: unknown, _cfg: unknown, _reg: unknown, opts: unknown) => {
        const o = opts as { onDelta?: (d: string) => Promise<void> };
        await o.onDelta?.('hi');
        return makeReply({ markdown: 'hi' });
      },
    );

    const slack = new MockSlackClient();
    await handleTurn(makeTurn({ threadTs: '900.1' as SlackThreadTs }), {
      fireworks: FAKE_FIREWORKS,
      model: 'accounts/fireworks/models/gpt-oss-120b',
      slackClient: slack,
      botUserId: BOT,
      slackTeamId: 'T-TEST',
      behavior: FAKE_BEHAVIOR,
    });

    expect(slack.startStreamCalls).toHaveLength(1);
    expect(slack.startStreamCalls[0]?.taskDisplayMode).toBe('timeline');
  });
});
