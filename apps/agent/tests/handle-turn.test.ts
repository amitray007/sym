import { beforeEach, describe, expect, it, vi } from 'vitest';

import { handleTurn } from '../src/handle-turn.js';
import { NameResolver } from '../src/name-resolver.js';

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

// Mock the LLM cleanup backstop so tests are hermetic. Default: returns the
// draft unchanged (no settling update); individual tests override per call.
vi.mock('../src/reply-cleanup.js', () => {
  const mockFn = vi.fn(async (draft: string) => draft);
  return { cleanupReply: mockFn, __mockCleanupReply: mockFn };
});
import * as replyCleanupModule from '../src/reply-cleanup.js';
const mockCleanupReply = (
  replyCleanupModule as unknown as { __mockCleanupReply: ReturnType<typeof vi.fn> }
).__mockCleanupReply;

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
  UpdateMessageParams,
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
import type { ToolRegistry } from '@sym/kernel';

// ---------------------------------------------------------------------------
// Fake Fireworks credentials (value doesn't matter — Pi is mocked).
// ---------------------------------------------------------------------------

const FAKE_FIREWORKS = { baseUrl: 'http://fake.fireworks', apiKey: 'fake-key' };
const FAKE_BEHAVIOR = {
  taskCardThreshold: 0,
  taskCardAfter: 'delete' as const,
  ownerPostMarker: true,
};
const FAKE_RESOLVER = new NameResolver();

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
  /** When truthy, chatAppendStream rejects with this error (simulates a dead stream). */
  appendStreamError: Error | undefined = undefined;
  /** When truthy, chatStopStream rejects with this error. */
  stopStreamError: Error | undefined = undefined;

  async chatPostMessage(params: PostMessageParams): Promise<PostMessageResult> {
    this.posts.push(params);
    return { ts: '111.222' as SlackThreadTs, channel: params.channel };
  }
  readonly updateCalls: UpdateMessageParams[] = [];
  async chatUpdate(params: UpdateMessageParams): Promise<void> {
    this.updateCalls.push(params);
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
    if (this.appendStreamError !== undefined) throw this.appendStreamError;
    if (params.markdownText !== undefined) {
      this.appendedText += params.markdownText;
    }
  }
  async chatStopStream(params: StopStreamParams): Promise<void> {
    this.stopStreamCalls.push(params);
    if (this.stopStreamError !== undefined) throw this.stopStreamError;
  }
  async chatDelete(): Promise<void> {
    /* no-op mock */
  }
  async usersInfo() {
    return { id: 'U0' as SlackUserId };
  }
  async usersList() {
    return { users: [] };
  }
  async conversationsList() {
    return { channels: [] };
  }
  async conversationsInfo() {
    return { id: 'D0' as SlackChannelId, isIm: false, isMpim: false };
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
      nameResolver: FAKE_RESOLVER,
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

  // --- replySink: slash response_url delivery for conversations Sym can't post in ---
  it('delivers via replySink instead of chatPostMessage when a sink is provided', async () => {
    mockRunLoopPi.mockResolvedValueOnce(
      makeReply({
        markdown: 'Answer for a private chat',
        receipt: {
          turnId: 'turn-1' as TurnId,
          model: 'accounts/fireworks/models/gpt-oss-120b',
          toolsInvoked: ['flip_coin'],
          durationMs: 1200,
        },
      }),
    );
    const slack = new MockSlackClient();
    const sinkCalls: { text: string; blocks: unknown[]; receiptText: string }[] = [];
    await handleTurn(makeTurn({ entrySurface: 'slash_command' }), {
      fireworks: FAKE_FIREWORKS,
      model: 'accounts/fireworks/models/gpt-oss-120b',
      slackClient: slack,
      botUserId: BOT,
      slackTeamId: 'T-TEST',
      behavior: FAKE_BEHAVIOR,
      nameResolver: FAKE_RESOLVER,
      replySink: async (msg) => {
        sinkCalls.push(msg);
      },
    });

    // No Slack post — Sym isn't a member of this conversation; the sink owns delivery.
    expect(slack.posts).toHaveLength(0);
    expect(sinkCalls).toHaveLength(1);
    expect(sinkCalls[0]!.text).toBe('Answer for a private chat');
    const sinkBlocks = sinkCalls[0]!.blocks as { type: string; text?: string }[];
    expect(sinkBlocks[0]?.type).toBe('markdown');
    expect(sinkBlocks[0]?.text).toBe('Answer for a private chat');
    expect(sinkBlocks.at(-1)?.type).toBe('context'); // receipt footer still present
    // Plain-text receipt for the text-only fallback tier (model shortened + tools).
    expect(sinkCalls[0]!.receiptText).toContain('gpt-oss-120b');
    expect(sinkCalls[0]!.receiptText).toContain('flip_coin');
  });

  it('replySink path never opens a stream, even for a threaded turn', async () => {
    mockRunLoopPi.mockResolvedValueOnce(makeReply({ markdown: 'no streaming here' }));
    const slack = new MockSlackClient();
    const sinkCalls: { text: string; blocks: unknown[] }[] = [];
    await handleTurn(makeTurn({ threadTs: '900.1' as SlackThreadTs }), {
      fireworks: FAKE_FIREWORKS,
      model: 'accounts/fireworks/models/gpt-oss-120b',
      slackClient: slack,
      botUserId: BOT,
      slackTeamId: 'T-TEST',
      behavior: FAKE_BEHAVIOR,
      nameResolver: FAKE_RESOLVER,
      replySink: async (msg) => {
        sinkCalls.push(msg);
      },
    });

    expect(slack.startStreamCalls).toHaveLength(0); // streaming skipped
    expect(slack.posts).toHaveLength(0);
    expect(sinkCalls).toHaveLength(1);
    expect(sinkCalls[0]!.text).toBe('no streaming here');
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
      nameResolver: FAKE_RESOLVER,
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
    // First call rotates per-turn via pickShimmerStatus — we assert the
    // shape ("is X…") rather than a specific phrase so reshuffling the
    // SHIMMER_PHRASES list doesn't churn this test.
    expect(slack.setStatusCalls.length).toBeGreaterThanOrEqual(1);
    expect(slack.setStatusCalls[0]?.status).toMatch(/^is .+…$/);
    // The opener carries a native rotation set (Slack animates through these);
    // each entry is a shimmer phrase, capped at 10.
    const loading = slack.setStatusCalls[0]?.loadingMessages;
    expect(loading).toBeDefined();
    expect(loading!.length).toBeGreaterThan(1);
    expect(loading!.length).toBeLessThanOrEqual(10);
    expect(loading!.every((m) => /^is .+…$/.test(m))).toBe(true);
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
      nameResolver: FAKE_RESOLVER,
    });

    const statuses = slack.setStatusCalls.map((c) => c.status);
    // Initial opener (rotated per-turn, "is X…" shape) + two loop emissions
    // + trailing '' clear (stopStream does not auto-clear setStatus).
    expect(statuses).toHaveLength(4);
    expect(statuses[0]).toMatch(/^is .+…$/); // rotated opener
    expect(statuses[1]).toBe('is searching Slack…');
    expect(statuses[2]).toBe('is writing the reply…');
    expect(statuses[3]).toBe('');
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
      nameResolver: FAKE_RESOLVER,
    });

    // setStatus: initial rotated opener ("is X…") + trailing '' clear after stopStream.
    expect(slack.setStatusCalls).toHaveLength(2);
    expect(slack.setStatusCalls[0]?.status).toMatch(/^is .+…$/);
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
      nameResolver: FAKE_RESOLVER,
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
      nameResolver: FAKE_RESOLVER,
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
        nameResolver: FAKE_RESOLVER,
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
      nameResolver: FAKE_RESOLVER,
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
        nameResolver: FAKE_RESOLVER,
      },
    );

    // The background context block must be the FIRST history message. The
    // viewed channel id doesn't resolve in this mock → generic, id-free label
    // (never the raw "C-VIEWED").
    const backgroundMsg = capturedHistory[0];
    expect(backgroundMsg?.content).toMatch(
      /^Background — the user is currently viewing another channel in Slack\./,
    );
    expect(backgroundMsg?.content).not.toContain('C-VIEWED');
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
        nameResolver: FAKE_RESOLVER,
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
        nameResolver: FAKE_RESOLVER,
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
        nameResolver: FAKE_RESOLVER,
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
      nameResolver: FAKE_RESOLVER,
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
      nameResolver: FAKE_RESOLVER,
    });

    // All three tasks must end in `complete` (or `error`) state in the chunks.
    const task1 = chunks.filter((c) => c.id === 'task-1').at(-1);
    const task2 = chunks.filter((c) => c.id === 'task-2').at(-1);
    const task3 = chunks.filter((c) => c.id === 'task-3').at(-1);
    expect(task1?.status).toBe('complete');
    expect(task2?.status).toBe('complete');
    expect(task3?.status).toBe('complete');

    // The threshold-flush batch must include all three task ids — that's the
    // user-visible "cards rendered" signal.
    const taskChunks = chunks.filter((c) => c.id.startsWith('task-'));
    const flushBatch = new Set(taskChunks.slice(0, 3).map((c) => c.id));
    expect(flushBatch.has('task-1')).toBe(true);
    expect(flushBatch.has('task-2')).toBe(true);
    expect(flushBatch.has('task-3')).toBe(true);
  });

  it('always opens chatStartStream with task_display_mode=plan (one grouped block, even without set_plan)', async () => {
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
      nameResolver: FAKE_RESOLVER,
    });

    expect(slack.startStreamCalls).toHaveLength(1);
    expect(slack.startStreamCalls[0]?.taskDisplayMode).toBe('plan');
  });

  it('opens the stream with task_display_mode=plan once the model latches a plan', async () => {
    mockRunLoopPi.mockImplementationOnce(
      async (_turn: unknown, _cfg: unknown, reg: unknown, opts: unknown) => {
        // Model calls set_plan early — flips the plan controller active, so the
        // stream opens as a grouped plan block instead of a timeline of cards.
        const dispatcher = (reg as ToolRegistry).getDispatcher();
        await dispatcher?.dispatch(
          {
            id: 'c1',
            name: 'set_plan',
            arguments: { items: ['Find the incident', 'Summarize it'] },
          },
          {
            workspaceId: 'ws-1' as WorkspaceId,
            conversationId: 'ws-1:C1' as Turn['conversationId'],
            channelId: 'C1' as SlackChannelId,
            requester: 'U1' as SlackUserId,
            turnId: 'turn-1' as TurnId,
          },
        );
        const o = opts as { onDelta?: (d: string) => Promise<void> };
        await o.onDelta?.('done');
        return makeReply({ markdown: 'done' });
      },
    );

    const slack = new MockSlackClient();
    await handleTurn(makeTurn({ threadTs: '901.1' as SlackThreadTs }), {
      fireworks: FAKE_FIREWORKS,
      model: 'accounts/fireworks/models/gpt-oss-120b',
      slackClient: slack,
      botUserId: BOT,
      slackTeamId: 'T-TEST',
      behavior: FAKE_BEHAVIOR,
      nameResolver: FAKE_RESOLVER,
    });

    expect(slack.startStreamCalls).toHaveLength(1);
    expect(slack.startStreamCalls[0]?.taskDisplayMode).toBe('plan');
  });

  it('settles a multi-step streamed reply to the LLM-cleaned version', async () => {
    mockRunLoopPi.mockImplementationOnce(
      async (_turn: unknown, _cfg: unknown, _reg: unknown, opts: unknown) => {
        const o = opts as { onDelta?: (d: string) => Promise<void> };
        await o.onDelta?.('Now start p1. Here is the answer.');
        return makeReply({
          markdown: 'Now start p1. Here is the answer.',
          // >1 tool → needsLlmCleanup fires.
          receipt: {
            turnId: 'turn-1' as TurnId,
            model: 'm',
            toolsInvoked: ['search_messages', 'read_channel'],
            durationMs: 5,
          },
        });
      },
    );
    mockCleanupReply.mockResolvedValueOnce('Here is the answer.');

    const slack = new MockSlackClient();
    await handleTurn(makeTurn({ threadTs: '950.1' as SlackThreadTs }), {
      fireworks: FAKE_FIREWORKS,
      model: 'accounts/fireworks/models/gpt-oss-120b',
      slackClient: slack,
      botUserId: BOT,
      slackTeamId: 'T-TEST',
      behavior: FAKE_BEHAVIOR,
      nameResolver: FAKE_RESOLVER,
    });

    expect(mockCleanupReply).toHaveBeenCalledWith(
      'Now start p1. Here is the answer.',
      expect.anything(),
    );
    expect(slack.updateCalls).toHaveLength(1);
    expect(slack.updateCalls[0]?.text).toContain('Here is the answer.');
    expect(slack.updateCalls[0]?.text).not.toContain('Now start p1');
  });

  it('runs cleanup on a ONE-tool turn that narrates (regression: > 1 gate skipped it)', async () => {
    mockRunLoopPi.mockImplementationOnce(
      async (_turn: unknown, _cfg: unknown, _reg: unknown, opts: unknown) => {
        const o = opts as { onDelta?: (d: string) => Promise<void> };
        await o.onDelta?.('Mark p1 complete.Now finalize.The time is 3pm.');
        return makeReply({
          markdown: 'Mark p1 complete.Now finalize.The time is 3pm.',
          // Exactly ONE real tool (the model narrated a fake plan around it).
          receipt: {
            turnId: 'turn-1' as TurnId,
            model: 'm',
            toolsInvoked: ['get_current_time'],
            durationMs: 5,
          },
        });
      },
    );
    mockCleanupReply.mockResolvedValueOnce('The time is 3pm.');

    const slack = new MockSlackClient();
    await handleTurn(makeTurn({ threadTs: '952.1' as SlackThreadTs }), {
      fireworks: FAKE_FIREWORKS,
      model: 'accounts/fireworks/models/gpt-oss-120b',
      slackClient: slack,
      botUserId: BOT,
      slackTeamId: 'T-TEST',
      behavior: FAKE_BEHAVIOR,
      nameResolver: FAKE_RESOLVER,
    });

    expect(mockCleanupReply).toHaveBeenCalledTimes(1);
    expect(slack.updateCalls).toHaveLength(1);
    expect(slack.updateCalls[0]?.text).toContain('The time is 3pm.');
    expect(slack.updateCalls[0]?.text).not.toContain('Mark p1 complete');
  });

  it('buffers the body and delivers it cleaned when a tool fires before any text (no flash, no chat.update)', async () => {
    mockRunLoopPi.mockImplementationOnce(
      async (_turn: unknown, _cfg: unknown, _reg: unknown, opts: unknown) => {
        const o = opts as {
          onDelta?: (d: string) => Promise<void>;
          onToolStart?: (id: string, label: string) => Promise<void>;
        };
        // Tool fires BEFORE any answer text → buffer mode latches.
        await o.onToolStart?.('c1', 'reading the channel');
        await o.onDelta?.('Mark p1 complete. The answer is 42.');
        return makeReply({
          markdown: 'Mark p1 complete. The answer is 42.',
          receipt: {
            turnId: 'turn-1' as TurnId,
            model: 'm',
            toolsInvoked: ['read_channel'],
            durationMs: 5,
          },
        });
      },
    );
    mockCleanupReply.mockResolvedValueOnce('The answer is 42.');

    const slack = new MockSlackClient();
    await handleTurn(makeTurn({ threadTs: '953.1' as SlackThreadTs }), {
      fireworks: FAKE_FIREWORKS,
      model: 'accounts/fireworks/models/gpt-oss-120b',
      slackClient: slack,
      botUserId: BOT,
      slackTeamId: 'T-TEST',
      // Threshold 1 → task card opens the stream on the first tool.
      behavior: { taskCardThreshold: 1, taskCardAfter: 'delete' as const, ownerPostMarker: true },
      nameResolver: FAKE_RESOLVER,
    });

    expect(mockCleanupReply).toHaveBeenCalledTimes(1);
    // Only the cleaned body reached the message body — narration never streamed.
    expect(slack.appendedText).toBe('The answer is 42.');
    expect(slack.appendedText).not.toContain('Mark p1 complete');
    // Buffer mode delivers once — no chat.update settle.
    expect(slack.updateCalls).toHaveLength(0);
    expect(slack.stopStreamCalls).toHaveLength(1);
  });

  it('falls back to postMessage when the buffered stream is dead (long turn / timeout)', async () => {
    mockRunLoopPi.mockImplementationOnce(
      async (_turn: unknown, _cfg: unknown, _reg: unknown, opts: unknown) => {
        const o = opts as {
          onDelta?: (d: string) => Promise<void>;
          onToolStart?: (id: string, label: string) => Promise<void>;
        };
        await o.onToolStart?.('c1', 'searching'); // buffer mode
        await o.onDelta?.('the pricing answer');
        return makeReply({
          markdown: 'the pricing answer',
          receipt: {
            turnId: 'turn-1' as TurnId,
            model: 'm',
            toolsInvoked: ['search_messages'],
            durationMs: 5,
          },
        });
      },
    );
    mockCleanupReply.mockResolvedValueOnce('the pricing answer');

    const slack = new MockSlackClient();
    // Stream opens (task card), but the streaming session has expired → append fails.
    slack.appendStreamError = new Error('message_not_found');
    await handleTurn(makeTurn({ threadTs: '955.1' as SlackThreadTs }), {
      fireworks: FAKE_FIREWORKS,
      model: 'accounts/fireworks/models/gpt-oss-120b',
      slackClient: slack,
      botUserId: BOT,
      slackTeamId: 'T-TEST',
      behavior: { taskCardThreshold: 1, taskCardAfter: 'delete' as const, ownerPostMarker: true },
      nameResolver: FAKE_RESOLVER,
    });

    // The answer must STILL land — as a normal posted message.
    expect(slack.posts).toHaveLength(1);
    expect(slack.posts[0]?.text).toContain('the pricing answer');
  });

  it('does NOT double-post when buffered append succeeds but stopStream fails', async () => {
    mockRunLoopPi.mockImplementationOnce(
      async (_turn: unknown, _cfg: unknown, _reg: unknown, opts: unknown) => {
        const o = opts as {
          onDelta?: (d: string) => Promise<void>;
          onToolStart?: (id: string, label: string) => Promise<void>;
        };
        await o.onToolStart?.('c1', 'searching'); // buffer mode
        await o.onDelta?.('the answer');
        return makeReply({
          markdown: 'the answer',
          receipt: {
            turnId: 'turn-1' as TurnId,
            model: 'm',
            toolsInvoked: ['search_messages'],
            durationMs: 5,
          },
        });
      },
    );
    mockCleanupReply.mockResolvedValueOnce('the answer');

    const slack = new MockSlackClient();
    // Body appends fine (visible in the stream), but the close fails.
    slack.stopStreamError = new Error('message_not_in_streaming_state');
    await handleTurn(makeTurn({ threadTs: '956.1' as SlackThreadTs }), {
      fireworks: FAKE_FIREWORKS,
      model: 'accounts/fireworks/models/gpt-oss-120b',
      slackClient: slack,
      botUserId: BOT,
      slackTeamId: 'T-TEST',
      behavior: { taskCardThreshold: 1, taskCardAfter: 'delete' as const, ownerPostMarker: true },
      nameResolver: FAKE_RESOLVER,
    });

    // The body was appended to the stream; a failed close must NOT re-post it.
    expect(slack.appendedText).toBe('the answer');
    expect(slack.posts).toHaveLength(0);
  });

  it('streams live (no buffering, no cleanup) for a no-tool reply', async () => {
    mockRunLoopPi.mockImplementationOnce(
      async (_turn: unknown, _cfg: unknown, _reg: unknown, opts: unknown) => {
        const o = opts as { onDelta?: (d: string) => Promise<void> };
        await o.onDelta?.('Hey! ');
        await o.onDelta?.('Here is the plain answer.');
        return makeReply({ markdown: 'Hey! Here is the plain answer.' }); // no tools
      },
    );

    const slack = new MockSlackClient();
    await handleTurn(makeTurn({ threadTs: '954.1' as SlackThreadTs }), {
      fireworks: FAKE_FIREWORKS,
      model: 'accounts/fireworks/models/gpt-oss-120b',
      slackClient: slack,
      botUserId: BOT,
      slackTeamId: 'T-TEST',
      behavior: FAKE_BEHAVIOR,
      nameResolver: FAKE_RESOLVER,
    });

    expect(mockCleanupReply).not.toHaveBeenCalled();
    expect(slack.appendedText).toBe('Hey! Here is the plain answer.');
    expect(slack.updateCalls).toHaveLength(0);
  });

  it('skips the LLM cleanup on a single-shot reply', async () => {
    mockRunLoopPi.mockImplementationOnce(
      async (_turn: unknown, _cfg: unknown, _reg: unknown, opts: unknown) => {
        const o = opts as { onDelta?: (d: string) => Promise<void> };
        await o.onDelta?.('The time is 3pm.');
        return makeReply({ markdown: 'The time is 3pm.' }); // no tools, no plan
      },
    );

    const slack = new MockSlackClient();
    await handleTurn(makeTurn({ threadTs: '951.1' as SlackThreadTs }), {
      fireworks: FAKE_FIREWORKS,
      model: 'accounts/fireworks/models/gpt-oss-120b',
      slackClient: slack,
      botUserId: BOT,
      slackTeamId: 'T-TEST',
      behavior: FAKE_BEHAVIOR,
      nameResolver: FAKE_RESOLVER,
    });

    expect(mockCleanupReply).not.toHaveBeenCalled();
    expect(slack.updateCalls).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // ID-resolution coverage at the handle-turn boundary. Each entry surface
  // that hands text to the model gets a defensive rewrite pass so raw
  // `<@U…>` / `<#C…>` markup never reaches the loop. See name-resolver.ts.
  // -----------------------------------------------------------------------
  describe('name resolver — rewrites raw Slack ids before the loop sees them', () => {
    it("keeps `<@U…>` tokens in the owner's own turn text so the reply can tag them", async () => {
      // Capture the turn the loop was invoked with so we can assert on the
      // text that actually gets embedded in the user-turn metadata block.
      let capturedTurn: Turn | undefined;
      mockRunLoopPi.mockImplementationOnce(
        async (turn: unknown, _cfg: unknown, _reg: unknown, _opts: unknown) => {
          capturedTurn = turn as Turn;
          return makeReply();
        },
      );

      const resolver = new NameResolver();
      resolver.primeForTests({ U777: 'Sarah' }, {});

      const slack = new MockSlackClient();
      await handleTurn(
        makeTurn({
          // Pure post-message path keeps the assertion focused on turn rewriting.
          text: 'draft a reply to <@U777> about the rollout',
        }),
        {
          fireworks: FAKE_FIREWORKS,
          model: 'accounts/fireworks/models/gpt-oss-120b',
          slackClient: slack,
          botUserId: BOT,
          slackTeamId: 'T-TEST',
          behavior: FAKE_BEHAVIOR,
          nameResolver: resolver,
        },
      );

      // The canonical mention token is preserved verbatim — the model can pass
      // it straight through so the reply renders a live @Sarah mention.
      expect(capturedTurn?.text).toBe('draft a reply to <@U777> about the rollout');
    });

    it('rewrites `<@U…>` / `<#C…>` markup inside history message bodies', async () => {
      let capturedHistory: ChatMessage[] = [];
      mockRunLoopPi.mockImplementationOnce(
        async (_turn: unknown, _cfg: unknown, _reg: unknown, opts: unknown) => {
          capturedHistory = (opts as { history?: ChatMessage[] }).history ?? [];
          return makeReply();
        },
      );

      const resolver = new NameResolver();
      // Channel resolution would normally hit conversations.list — prime so
      // the test stays hermetic. Pre-cache both user and channel.
      resolver.primeForTests({ U042: 'Amit' }, { C999: 'design' });

      const slack = new MockSlackClient();
      slack.replies = [
        {
          user: 'U1' as SlackUserId,
          text: 'ping <@U042> about <#C999|design>',
          ts: '500.1' as SlackThreadTs,
        },
      ];

      await handleTurn(
        makeTurn({
          threadTs: '500.0' as SlackThreadTs,
          ts: '500.2' as SlackThreadTs,
          text: 'what is this thread about',
        }),
        {
          fireworks: FAKE_FIREWORKS,
          model: 'accounts/fireworks/models/gpt-oss-120b',
          slackClient: slack,
          botUserId: BOT,
          slackTeamId: 'T-TEST',
          behavior: FAKE_BEHAVIOR,
          nameResolver: resolver,
        },
      );

      // Loop received history with normalized bodies — canonical tokens kept
      // (Slack renders them), stale inline channel label dropped.
      const histText = capturedHistory.map((m) => m.content ?? '').join('\n');
      expect(histText).toContain('<@U042>');
      expect(histText).toContain('<#C999>');
      expect(histText).not.toContain('<#C999|design>');
    });

    it('keeps `<@U…>` tokens in the viewed-channel background block', async () => {
      let capturedHistory: ChatMessage[] = [];
      mockRunLoopPi.mockImplementationOnce(
        async (_turn: unknown, _cfg: unknown, _reg: unknown, opts: unknown) => {
          capturedHistory = (opts as { history?: ChatMessage[] }).history ?? [];
          return makeReply();
        },
      );

      const resolver = new NameResolver();
      resolver.primeForTests({ U999: 'Bob' }, { 'C-VIEWED': 'rollout' });

      const slack = new MockSlackClient();
      slack.historyMessages = [
        {
          user: 'U1' as SlackUserId,
          text: 'cc <@U999> on the deploy',
          ts: '800.1' as SlackThreadTs,
        },
      ];

      await handleTurn(
        makeTurn({
          entrySurface: 'dm',
          channelId: 'D1' as SlackChannelId,
          threadTs: '500.0' as SlackThreadTs,
          text: 'what is happening',
        }),
        {
          fireworks: FAKE_FIREWORKS,
          model: 'accounts/fireworks/models/gpt-oss-120b',
          slackClient: slack,
          botUserId: BOT,
          slackTeamId: 'T-TEST',
          behavior: FAKE_BEHAVIOR,
          viewedChannelId: 'C-VIEWED',
          nameResolver: resolver,
        },
      );

      const backgroundMsg = capturedHistory[0]?.content ?? '';
      // Channel id resolved to #name in the id-free lead-in, AND the `<@U…>`
      // token kept verbatim inside the transcript body (Slack renders @Bob).
      expect(backgroundMsg).toContain('viewing #rollout');
      expect(backgroundMsg).toContain('<@U999>');
    });
  });
});
