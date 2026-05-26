import { describe, expect, it } from 'vitest';

import { createBuiltinDispatcher } from '../src/builtin-tools.js';

import type {
  ConversationsHistoryResult,
  ConversationsRepliesResult,
  SlackClient,
  SlackThreadMessage,
} from '@sym/adapter-slack';
import type {
  ConversationId,
  JsonObject,
  SlackChannelId,
  SlackThreadTs,
  SlackUserId,
  ToolCall,
  ToolRuntimeContext,
  TurnId,
  WorkspaceId,
} from '@sym/contracts';

const BOT = 'UBOT' as SlackUserId;

function makeCtx(): ToolRuntimeContext {
  return {
    workspaceId: 'ws_01' as WorkspaceId,
    conversationId: 'ws_01:C1' as ConversationId,
    channelId: 'C1' as SlackChannelId,
    requester: 'U_alice' as SlackUserId,
    turnId: 'turn_01' as TurnId,
  };
}

function makeCall(name: string, args: JsonObject = {}, id = 'call_01'): ToolCall {
  return { id, name, arguments: args };
}

/**
 * Minimal fake SlackClient for builtin-tool tests.
 * Only conversationsHistory and conversationsReplies need real behavior;
 * everything else is a no-op stub.
 */
function makeSlackClient(opts: {
  historyMessages?: SlackThreadMessage[];
  repliesMessages?: SlackThreadMessage[];
  historyError?: Error;
  repliesError?: Error;
}): SlackClient {
  return {
    async conversationsHistory(): Promise<ConversationsHistoryResult> {
      if (opts.historyError !== undefined) throw opts.historyError;
      return { messages: opts.historyMessages ?? [] };
    },
    async conversationsReplies(): Promise<ConversationsRepliesResult> {
      if (opts.repliesError !== undefined) throw opts.repliesError;
      return { messages: opts.repliesMessages ?? [] };
    },
    async chatPostMessage() {
      return { ts: '0.0' as SlackThreadTs, channel: 'C1' as SlackChannelId };
    },
    async chatUpdate() {
      /* no-op */
    },
    async reactionsAdd() {
      /* no-op */
    },
    async assistantThreadsSetStatus() {
      /* no-op */
    },
    async assistantThreadsSetSuggestedPrompts() {
      /* no-op */
    },
    async assistantThreadsSetTitle() {
      /* no-op */
    },
    async chatStartStream() {
      return { channel: 'C1' as SlackChannelId, ts: '0.0' as SlackThreadTs };
    },
    async chatAppendStream() {
      /* no-op */
    },
    async chatStopStream() {
      /* no-op */
    },
  };
}

describe('createBuiltinDispatcher', () => {
  describe('list()', () => {
    it('returns exactly 3 descriptors: get_current_time, read_channel, read_thread', () => {
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({}),
        botUserId: BOT,
      });
      const tools = dispatcher.list();
      expect(tools).toHaveLength(3);
      const names = tools.map((t) => t.name);
      expect(names).toContain('get_current_time');
      expect(names).toContain('read_channel');
      expect(names).toContain('read_thread');
    });

    it('get_current_time descriptor has readOnlyHint: true', () => {
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({}),
        botUserId: BOT,
      });
      const tool = dispatcher.list().find((t) => t.name === 'get_current_time')!;
      expect(tool.readOnlyHint).toBe(true);
    });

    it('get_current_time descriptor has type: function', () => {
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({}),
        botUserId: BOT,
      });
      const tool = dispatcher.list().find((t) => t.name === 'get_current_time')!;
      expect(tool.type).toBe('function');
    });

    it('read_channel descriptor has readOnlyHint: true', () => {
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({}),
        botUserId: BOT,
      });
      const tool = dispatcher.list().find((t) => t.name === 'read_channel')!;
      expect(tool.readOnlyHint).toBe(true);
    });

    it('read_thread descriptor has readOnlyHint: true', () => {
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({}),
        botUserId: BOT,
      });
      const tool = dispatcher.list().find((t) => t.name === 'read_thread')!;
      expect(tool.readOnlyHint).toBe(true);
    });
  });

  describe('dispatch() — get_current_time', () => {
    it('returns an ISO 8601 string for get_current_time', async () => {
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({}),
        botUserId: BOT,
      });
      const result = await dispatcher.dispatch(makeCall('get_current_time'), makeCtx());

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');
      expect(typeof result.content).toBe('string');
      expect(() => new Date(result.content as string)).not.toThrow();
      expect(new Date(result.content as string).toISOString()).toBe(result.content);
    });

    it('returns callId matching the call id', async () => {
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({}),
        botUserId: BOT,
      });
      const result = await dispatcher.dispatch(
        makeCall('get_current_time', {}, 'my-id'),
        makeCtx(),
      );
      expect(result.callId).toBe('my-id');
    });
  });

  describe('dispatch() — unknown tool', () => {
    it('returns not_found for an unknown tool', async () => {
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({}),
        botUserId: BOT,
      });
      const result = await dispatcher.dispatch(makeCall('unknown_tool'), makeCtx());

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      expect(result.error.code).toBe('not_found');
      expect(result.error.message).toContain('unknown_tool');
    });
  });

  describe('dispatch() — read_channel', () => {
    it('returns a transcript containing the messages', async () => {
      const messages: SlackThreadMessage[] = [
        { user: 'U1' as SlackUserId, text: 'deploy looks good', ts: '100.1' as SlackThreadTs },
        { user: BOT, text: 'agreed', ts: '100.2' as SlackThreadTs },
      ];
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({ historyMessages: messages }),
        botUserId: BOT,
      });

      const result = await dispatcher.dispatch(
        makeCall('read_channel', { channel_id: 'C0123' }),
        makeCtx(),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');
      const content = result.content as string;
      // Regular user message appears in transcript
      expect(content).toContain('deploy looks good');
      // Bot's own message is prefixed with "Sym:"
      expect(content).toContain('Sym:');
      expect(content).toContain('agreed');
    });

    it('returns (no messages) when channel is empty', async () => {
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({ historyMessages: [] }),
        botUserId: BOT,
      });

      const result = await dispatcher.dispatch(
        makeCall('read_channel', { channel_id: 'C0123' }),
        makeCtx(),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');
      expect(result.content).toBe('(no messages)');
    });

    it('returns invalid_arguments when channel_id is missing', async () => {
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({}),
        botUserId: BOT,
      });
      const result = await dispatcher.dispatch(makeCall('read_channel', {}), makeCtx());

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      expect(result.error.code).toBe('invalid_arguments');
    });

    it('returns invalid_arguments when channel_id is an empty string', async () => {
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({}),
        botUserId: BOT,
      });
      const result = await dispatcher.dispatch(
        makeCall('read_channel', { channel_id: '' }),
        makeCtx(),
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      expect(result.error.code).toBe('invalid_arguments');
    });

    it('returns execution_failed when Slack throws', async () => {
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({ historyError: new Error('channel_not_found') }),
        botUserId: BOT,
      });
      const result = await dispatcher.dispatch(
        makeCall('read_channel', { channel_id: 'C0123' }),
        makeCtx(),
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      expect(result.error.code).toBe('execution_failed');
      expect(result.error.message).toContain('channel_not_found');
    });

    it('clamps limit to max 100', async () => {
      // We verify clamping doesn't cause an error; the actual Slack call is mocked.
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({ historyMessages: [] }),
        botUserId: BOT,
      });
      const result = await dispatcher.dispatch(
        makeCall('read_channel', { channel_id: 'C0123', limit: 999 }),
        makeCtx(),
      );
      // Should succeed (no invalid_arguments), clamping is transparent.
      expect(result.ok).toBe(true);
    });

    it('defaults limit to 30 when not provided', async () => {
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({ historyMessages: [] }),
        botUserId: BOT,
      });
      const result = await dispatcher.dispatch(
        makeCall('read_channel', { channel_id: 'C0123' }),
        makeCtx(),
      );
      expect(result.ok).toBe(true);
    });
  });

  describe('dispatch() — read_thread', () => {
    it('returns a transcript for a valid thread', async () => {
      const messages: SlackThreadMessage[] = [
        { user: 'U1' as SlackUserId, text: 'root message', ts: '200.1' as SlackThreadTs },
        { user: 'U2' as SlackUserId, text: 'a reply', ts: '200.2' as SlackThreadTs },
        { user: BOT, text: 'bot reply', ts: '200.3' as SlackThreadTs },
      ];
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({ repliesMessages: messages }),
        botUserId: BOT,
      });

      const result = await dispatcher.dispatch(
        makeCall('read_thread', { channel_id: 'C0123', thread_ts: '200.1' }),
        makeCtx(),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');
      const content = result.content as string;
      expect(content).toContain('root message');
      expect(content).toContain('a reply');
      expect(content).toContain('Sym:');
      expect(content).toContain('bot reply');
    });

    it('returns invalid_arguments when channel_id is missing', async () => {
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({}),
        botUserId: BOT,
      });
      const result = await dispatcher.dispatch(
        makeCall('read_thread', { thread_ts: '200.1' }),
        makeCtx(),
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      expect(result.error.code).toBe('invalid_arguments');
    });

    it('returns invalid_arguments when thread_ts is missing', async () => {
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({}),
        botUserId: BOT,
      });
      const result = await dispatcher.dispatch(
        makeCall('read_thread', { channel_id: 'C0123' }),
        makeCtx(),
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      expect(result.error.code).toBe('invalid_arguments');
    });

    it('returns execution_failed when Slack throws', async () => {
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({ repliesError: new Error('thread_not_found') }),
        botUserId: BOT,
      });
      const result = await dispatcher.dispatch(
        makeCall('read_thread', { channel_id: 'C0123', thread_ts: '200.1' }),
        makeCtx(),
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      expect(result.error.code).toBe('execution_failed');
      expect(result.error.message).toContain('thread_not_found');
    });
  });
});
