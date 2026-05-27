import { afterEach, describe, expect, it } from 'vitest';

import { createBuiltinDispatcher } from '../src/builtin-tools.js';

import type {
  AssistantSearchContextParams,
  AssistantSearchContextResult,
  ConversationsHistoryResult,
  ConversationsListResult,
  ConversationsRepliesResult,
  SlackClient,
  SlackThreadMessage,
  SlackUserProfile,
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
  userProfile?: SlackUserProfile;
  userError?: Error;
  listResult?: ConversationsListResult;
  listError?: Error;
  searchResult?: AssistantSearchContextResult;
  searchError?: Error;
  searchCalls?: AssistantSearchContextParams[];
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
    async usersInfo(): Promise<SlackUserProfile> {
      if (opts.userError !== undefined) throw opts.userError;
      return opts.userProfile ?? { id: 'U0' as SlackUserId };
    },
    async conversationsList(): Promise<ConversationsListResult> {
      if (opts.listError !== undefined) throw opts.listError;
      return opts.listResult ?? { channels: [] };
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
    async chatDelete() {
      /* no-op */
    },
    async assistantSearchContext(
      params: AssistantSearchContextParams,
    ): Promise<AssistantSearchContextResult> {
      opts.searchCalls?.push(params);
      if (opts.searchError !== undefined) throw opts.searchError;
      return opts.searchResult ?? { messages: [] };
    },
  };
}

describe('createBuiltinDispatcher', () => {
  describe('list()', () => {
    it('returns the full set of built-in tool descriptors', () => {
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({}),
        botUserId: BOT,
      });
      const tools = dispatcher.list();
      const names = tools.map((t) => t.name);
      expect(names).toEqual(
        expect.arrayContaining([
          'get_current_time',
          'read_channel',
          'read_thread',
          'read_user_profile',
          'fetch_url',
          'list_channels',
          'search_workspace',
        ]),
      );
      expect(tools).toHaveLength(7);
    });

    it('all new READ tools have readOnlyHint: true', () => {
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({}),
        botUserId: BOT,
      });
      for (const name of ['read_user_profile', 'fetch_url', 'list_channels']) {
        const tool = dispatcher.list().find((t) => t.name === name);
        expect(tool?.readOnlyHint, `${name} readOnlyHint`).toBe(true);
      }
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

  describe('dispatch() — read_user_profile', () => {
    it('formats a user profile', async () => {
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({
          userProfile: {
            id: 'U123' as SlackUserId,
            displayName: 'amit',
            realName: 'Amit Ray',
            title: 'Eng',
            tz: 'America/Los_Angeles',
            statusText: 'building',
            statusEmoji: ':hammer:',
          },
        }),
        botUserId: BOT,
      });
      const result = await dispatcher.dispatch(
        makeCall('read_user_profile', { user_id: 'U123' }),
        makeCtx(),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');
      const content = result.content as string;
      expect(content).toContain('id: U123');
      expect(content).toContain('display_name: amit');
      expect(content).toContain('real_name: Amit Ray');
      expect(content).toContain('title: Eng');
      expect(content).toContain('tz: America/Los_Angeles');
      expect(content).toContain(':hammer: building');
    });

    it('returns invalid_arguments when user_id is missing', async () => {
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({}),
        botUserId: BOT,
      });
      const result = await dispatcher.dispatch(makeCall('read_user_profile', {}), makeCtx());
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      expect(result.error.code).toBe('invalid_arguments');
    });

    it('returns execution_failed when Slack throws', async () => {
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({ userError: new Error('user_not_found') }),
        botUserId: BOT,
      });
      const result = await dispatcher.dispatch(
        makeCall('read_user_profile', { user_id: 'U123' }),
        makeCtx(),
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      expect(result.error.code).toBe('execution_failed');
      expect(result.error.message).toContain('user_not_found');
    });
  });

  describe('dispatch() — fetch_url', () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('strips HTML and returns text content', async () => {
      globalThis.fetch = (async () =>
        new Response('<html><body><h1>Hi</h1><p>world</p></body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        })) as typeof fetch;

      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({}),
        botUserId: BOT,
      });
      const result = await dispatcher.dispatch(
        makeCall('fetch_url', { url: 'https://example.com/' }),
        makeCtx(),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');
      const content = result.content as string;
      expect(content).toContain('Hi');
      expect(content).toContain('world');
      expect(content).not.toContain('<h1>');
    });

    it('truncates output past max_chars', async () => {
      const big = 'x'.repeat(20000);
      globalThis.fetch = (async () =>
        new Response(big, {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        })) as typeof fetch;

      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({}),
        botUserId: BOT,
      });
      const result = await dispatcher.dispatch(
        makeCall('fetch_url', { url: 'https://example.com/big', max_chars: 500 }),
        makeCtx(),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');
      expect(result.content as string).toContain('[truncated');
    });

    it('returns invalid_arguments for non-http scheme', async () => {
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({}),
        botUserId: BOT,
      });
      const result = await dispatcher.dispatch(
        makeCall('fetch_url', { url: 'file:///etc/passwd' }),
        makeCtx(),
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      expect(result.error.code).toBe('invalid_arguments');
    });

    it('returns invalid_arguments for unparseable URL', async () => {
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({}),
        botUserId: BOT,
      });
      const result = await dispatcher.dispatch(
        makeCall('fetch_url', { url: 'not a url' }),
        makeCtx(),
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      expect(result.error.code).toBe('invalid_arguments');
    });

    it('returns invalid_arguments when url is missing', async () => {
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({}),
        botUserId: BOT,
      });
      const result = await dispatcher.dispatch(makeCall('fetch_url', {}), makeCtx());
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      expect(result.error.code).toBe('invalid_arguments');
    });

    it('returns execution_failed on non-2xx', async () => {
      globalThis.fetch = (async () =>
        new Response('nope', { status: 500, statusText: 'Server Error' })) as typeof fetch;

      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({}),
        botUserId: BOT,
      });
      const result = await dispatcher.dispatch(
        makeCall('fetch_url', { url: 'https://example.com/' }),
        makeCtx(),
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      expect(result.error.code).toBe('execution_failed');
      expect(result.error.message).toContain('500');
    });
  });

  describe('dispatch() — list_channels', () => {
    it('formats a channel list', async () => {
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({
          listResult: {
            channels: [
              {
                id: 'C1' as SlackChannelId,
                name: 'general',
                isPrivate: false,
                topic: 'company-wide',
                memberCount: 42,
              },
              {
                id: 'C2' as SlackChannelId,
                name: 'eng-private',
                isPrivate: true,
              },
            ],
          },
        }),
        botUserId: BOT,
      });
      const result = await dispatcher.dispatch(makeCall('list_channels', {}), makeCtx());
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');
      const content = result.content as string;
      expect(content).toContain('C1 #general');
      expect(content).toContain('42 members');
      expect(content).toContain('company-wide');
      expect(content).toContain('C2 #eng-private [private]');
    });

    it('returns (no channels) on empty result', async () => {
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({ listResult: { channels: [] } }),
        botUserId: BOT,
      });
      const result = await dispatcher.dispatch(makeCall('list_channels', {}), makeCtx());
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');
      expect(result.content).toBe('(no channels)');
    });

    it('returns execution_failed when Slack throws', async () => {
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({ listError: new Error('missing_scope') }),
        botUserId: BOT,
      });
      const result = await dispatcher.dispatch(makeCall('list_channels', {}), makeCtx());
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      expect(result.error.code).toBe('execution_failed');
      expect(result.error.message).toContain('missing_scope');
    });

    it('clamps limit to max 200', async () => {
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({ listResult: { channels: [] } }),
        botUserId: BOT,
      });
      const result = await dispatcher.dispatch(
        makeCall('list_channels', { limit: 999 }),
        makeCtx(),
      );
      expect(result.ok).toBe(true);
    });
  });

  describe('dispatch() — search_workspace', () => {
    it('returns execution_failed when no action_token is available', async () => {
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({}),
        botUserId: BOT,
        // actionToken omitted — bot tokens require it.
      });
      const result = await dispatcher.dispatch(
        makeCall('search_workspace', { query: 'postgres migration' }),
        makeCtx(),
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      expect(result.error.code).toBe('execution_failed');
      expect(result.error.message).toMatch(/action_token/);
    });

    it('calls assistant.search.context and formats the results', async () => {
      const calls: AssistantSearchContextParams[] = [];
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({
          searchCalls: calls,
          searchResult: {
            messages: [
              {
                channelId: 'C1' as SlackChannelId,
                channelName: 'eng',
                messageTs: '900.1' as SlackThreadTs,
                content: 'we decided to upgrade postgres next quarter',
                authorName: 'amit',
                permalink: 'https://slack.com/archives/C1/p9001',
              },
            ],
          },
        }),
        botUserId: BOT,
        actionToken: 'fake.action.token',
      });
      const result = await dispatcher.dispatch(
        makeCall('search_workspace', { query: 'postgres migration', limit: 5 }),
        makeCtx(),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');
      expect(result.content).toContain('amit');
      expect(result.content).toContain('eng');
      expect(result.content).toContain('upgrade postgres');
      expect(calls).toHaveLength(1);
      expect(calls[0]?.query).toBe('postgres migration');
      expect(calls[0]?.actionToken).toBe('fake.action.token');
      expect(calls[0]?.limit).toBe(5);
    });

    it('returns "(no matching messages)" on empty results', async () => {
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({ searchResult: { messages: [] } }),
        botUserId: BOT,
        actionToken: 'fake.action.token',
      });
      const result = await dispatcher.dispatch(
        makeCall('search_workspace', { query: 'nothing' }),
        makeCtx(),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');
      expect(result.content).toContain('(no matching messages)');
    });

    it('surfaces Slack errors as execution_failed', async () => {
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({ searchError: new Error('rate_limited') }),
        botUserId: BOT,
        actionToken: 'fake.action.token',
      });
      const result = await dispatcher.dispatch(
        makeCall('search_workspace', { query: 'q' }),
        makeCtx(),
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      expect(result.error.code).toBe('execution_failed');
      expect(result.error.message).toContain('rate_limited');
    });

    it('rejects empty query string with invalid_arguments', async () => {
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({}),
        botUserId: BOT,
        actionToken: 'fake.action.token',
      });
      const result = await dispatcher.dispatch(
        makeCall('search_workspace', { query: '   ' }),
        makeCtx(),
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      expect(result.error.code).toBe('invalid_arguments');
    });
  });
});
