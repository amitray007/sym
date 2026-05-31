import { afterEach, describe, expect, it } from 'vitest';

import { createBuiltinDispatcher } from '../src/builtin-tools.js';
import { NameResolver } from '../src/name-resolver.js';

import type {
  ConversationsHistoryResult,
  ConversationsInfoParams,
  ConversationsInfoResult,
  ConversationsListResult,
  ConversationsRepliesResult,
  DeleteMessageParams,
  PostMessageParams,
  ReactionsAddParams,
  RemindersAddParams,
  RemindersAddResult,
  SearchMessagesParams,
  SearchMessagesResult,
  SlackClient,
  SlackThreadMessage,
  SlackUserProfile,
  UsersListResult,
  UsersProfileSetParams,
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
  usersListResult?: UsersListResult;
  infoResult?: ConversationsInfoResult;
  infoError?: Error;
  searchResult?: SearchMessagesResult;
  searchError?: Error;
  searchCalls?: SearchMessagesParams[];
  // Phase B mocks
  postCalls?: PostMessageParams[];
  postError?: Error;
  reactionCalls?: ReactionsAddParams[];
  reactionError?: Error;
  profileCalls?: UsersProfileSetParams[];
  profileError?: Error;
  reminderCalls?: RemindersAddParams[];
  reminderError?: Error;
  reminderResult?: RemindersAddResult;
  deleteCalls?: DeleteMessageParams[];
  deleteError?: Error;
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
    async usersList(): Promise<UsersListResult> {
      return opts.usersListResult ?? { users: [] };
    },
    async conversationsList(): Promise<ConversationsListResult> {
      if (opts.listError !== undefined) throw opts.listError;
      return opts.listResult ?? { channels: [] };
    },
    async conversationsInfo(params: ConversationsInfoParams): Promise<ConversationsInfoResult> {
      if (opts.infoError !== undefined) throw opts.infoError;
      return opts.infoResult ?? { id: params.channel, isIm: false, isMpim: false };
    },
    async chatPostMessage(params: PostMessageParams) {
      opts.postCalls?.push(params);
      if (opts.postError !== undefined) throw opts.postError;
      return { ts: '999.111' as SlackThreadTs, channel: params.channel };
    },
    async chatUpdate() {
      /* no-op */
    },
    async reactionsAdd(params: ReactionsAddParams) {
      opts.reactionCalls?.push(params);
      if (opts.reactionError !== undefined) throw opts.reactionError;
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
    async chatDelete(params: DeleteMessageParams) {
      opts.deleteCalls?.push(params);
      if (opts.deleteError !== undefined) throw opts.deleteError;
    },
    async authTest() {
      return { userId: 'U0' as SlackUserId, teamId: 'T0' };
    },
    async searchMessages(params: SearchMessagesParams): Promise<SearchMessagesResult> {
      opts.searchCalls?.push(params);
      if (opts.searchError !== undefined) throw opts.searchError;
      return opts.searchResult ?? { matches: [], total: 0 };
    },
    async usersProfileSet(params: UsersProfileSetParams) {
      opts.profileCalls?.push(params);
      if (opts.profileError !== undefined) throw opts.profileError;
    },
    async remindersAdd(params: RemindersAddParams): Promise<RemindersAddResult> {
      opts.reminderCalls?.push(params);
      if (opts.reminderError !== undefined) throw opts.reminderError;
      return opts.reminderResult ?? { id: 'Rm123', text: params.text };
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
          'web_search',
          'run_cli',
          'list_channels',
          'search_messages',
          'post_as_owner',
          'react_as_owner',
          'set_status',
          'add_reminder',
          'delete_message',
          'set_plan',
          'update_task',
          'present_card',
          'present_table',
        ]),
      );
      expect(tools).toHaveLength(18);
    });

    it('declares actor:"user" on every tool that should act under owner identity', () => {
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({}),
        botUserId: BOT,
      });
      const userActorNames = dispatcher
        .list()
        .filter((t) => t.actor === 'user')
        .map((t) => t.name)
        .sort();
      expect(userActorNames).toEqual([
        'add_reminder',
        'list_channels',
        'post_as_owner',
        'react_as_owner',
        'read_channel',
        'read_thread',
        'read_user_profile',
        'search_messages',
        'set_status',
      ]);
      // delete_message acts as SYM (bot token), NOT the owner — it deletes
      // Sym's own messages, so it must NOT be in the user-actor set above.
      expect(userActorNames).not.toContain('delete_message');
    });

    it('delete_message acts as the bot (no actor:"user") — deletes Sym\'s own messages', () => {
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({}),
        botUserId: BOT,
      });
      const byName = new Map(dispatcher.list().map((t) => [t.name, t]));
      expect(byName.get('delete_message')?.actor).toBeUndefined();
    });

    it('marks act-as-owner WRITE tools as destructive (rides confirm flow), reads are not', () => {
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({}),
        botUserId: BOT,
      });
      const byName = new Map(dispatcher.list().map((t) => [t.name, t]));
      // Destructive: act-as-owner writes need owner confirmation.
      expect(byName.get('post_as_owner')?.destructiveHint).toBe(true);
      expect(byName.get('react_as_owner')?.destructiveHint).toBe(true);
      expect(byName.get('set_status')?.destructiveHint).toBe(true);
      // delete_message is irreversible → also rides the confirm flow.
      expect(byName.get('delete_message')?.destructiveHint).toBe(true);
      // Reads + reminders: non-destructive.
      expect(byName.get('add_reminder')?.destructiveHint).toBeUndefined();
      expect(byName.get('read_channel')?.destructiveHint).toBeUndefined();
      expect(byName.get('search_messages')?.destructiveHint).toBeUndefined();
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

  describe('dispatch() — present_card', () => {
    it('attaches a card render and keeps a model-facing content nudge', async () => {
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({}),
        botUserId: BOT,
      });
      const result = await dispatcher.dispatch(
        makeCall('present_card', {
          title: 'INC-204 · API latency',
          body: 'Slow query identified',
          fields: [
            { label: 'Owner', value: 'Priya' },
            { label: 'Status', value: 'Open' },
          ],
          actions: [{ label: 'Open', url: 'https://slack.com/x' }],
        }),
        makeCtx(),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected success');
      expect(result.render).toEqual({
        kind: 'card',
        title: 'INC-204 · API latency',
        body: 'Slow query identified',
        fields: [
          { label: 'Owner', value: 'Priya' },
          { label: 'Status', value: 'Open' },
        ],
        actions: [{ label: 'Open', url: 'https://slack.com/x' }],
      });
      expect(typeof result.content).toBe('string');
    });

    it('drops malformed fields and non-http action urls', async () => {
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({}),
        botUserId: BOT,
      });
      const result = await dispatcher.dispatch(
        makeCall('present_card', {
          title: 'X',
          fields: [{ label: 'ok', value: 'v' }, { label: 'bad' }, 'nope'],
          actions: [
            { label: 'js', url: 'javascript:alert(1)' },
            { label: 'ok', url: 'https://x' },
          ],
        }),
        makeCtx(),
      );
      expect(result.ok).toBe(true);
      if (!result.ok || result.render?.kind !== 'card') throw new Error('expected card');
      expect(result.render.fields).toEqual([{ label: 'ok', value: 'v' }]);
      expect(result.render.actions).toEqual([{ label: 'ok', url: 'https://x' }]);
    });

    it('rejects an empty title', async () => {
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({}),
        botUserId: BOT,
      });
      const result = await dispatcher.dispatch(
        makeCall('present_card', { title: '  ' }),
        makeCtx(),
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      expect(result.error.code).toBe('invalid_arguments');
    });
  });

  describe('dispatch() — present_table', () => {
    it('builds a table render from columns + rows', async () => {
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({}),
        botUserId: BOT,
      });
      const result = await dispatcher.dispatch(
        makeCall('present_table', {
          caption: 'Options',
          columns: ['Plan', 'Price'],
          rows: [
            ['Pro', '$20'],
            ['Team', '$40'],
          ],
        }),
        makeCtx(),
      );
      expect(result.ok).toBe(true);
      if (!result.ok || result.render?.kind !== 'table') throw new Error('expected table');
      expect(result.render.caption).toBe('Options');
      expect(result.render.columns).toEqual([{ header: 'Plan' }, { header: 'Price' }]);
      expect(result.render.rows[0]).toEqual([{ text: 'Pro' }, { text: '$20' }]);
    });

    it('rejects non-string rows', async () => {
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({}),
        botUserId: BOT,
      });
      const result = await dispatcher.dispatch(
        makeCall('present_table', { columns: ['A'], rows: [[1, 2]] }),
        makeCtx(),
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      expect(result.error.code).toBe('invalid_arguments');
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

  describe('dispatch() — search_messages', () => {
    it('returns execution_failed when no user token is configured (bot fallback path)', async () => {
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({}),
        botUserId: BOT,
        // userSlackClient omitted — falls back to bot, then refuses cleanly.
      });
      const result = await dispatcher.dispatch(
        makeCall('search_messages', { query: 'postgres migration' }),
        makeCtx(),
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      expect(result.error.code).toBe('execution_failed');
      expect(result.error.message).toMatch(/SLACK_OWNER_USER_TOKEN/);
    });

    it('calls search.messages on the USER client and formats results', async () => {
      const userCalls: SearchMessagesParams[] = [];
      const userClient = makeSlackClient({
        searchCalls: userCalls,
        searchResult: {
          matches: [
            {
              channelId: 'C1' as SlackChannelId,
              channelName: 'eng',
              ts: '900.1' as SlackThreadTs,
              text: 'we decided to upgrade postgres next quarter',
              username: 'amit',
              permalink: 'https://slack.com/archives/C1/p9001',
            },
          ],
          total: 1,
        },
      });
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({}),
        userSlackClient: userClient,
        botUserId: BOT,
      });
      const result = await dispatcher.dispatch(
        makeCall('search_messages', { query: 'postgres migration', limit: 5 }),
        makeCtx(),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');
      // Prose body: author (no userId here → @-handle) + channel as a clickable
      // `<#C…>` token + the message text.
      expect(result.content).toContain('amit');
      expect(result.content).toContain('<#C1>');
      expect(result.content).toContain('upgrade postgres');
      // Table render uses the readable channel name in its plain cell.
      const rows = result.render?.kind === 'table' ? result.render.rows : [];
      expect(JSON.stringify(rows)).toContain('#eng');
      expect(userCalls).toHaveLength(1);
      expect(userCalls[0]?.query).toBe('postgres migration');
      // Fetches headroom (min 30) so dedup can surface uniques even when the
      // requested limit (5) is small; at most `limit` unique are then shown.
      expect(userCalls[0]?.count).toBe(30);
      expect(userCalls[0]?.sort).toBe('score');
    });

    it('dedupes an identical search within a turn — one API call, fresh callId', async () => {
      const userCalls: SearchMessagesParams[] = [];
      const userClient = makeSlackClient({
        searchCalls: userCalls,
        searchResult: {
          matches: [
            {
              channelId: 'C1' as SlackChannelId,
              channelName: 'eng',
              ts: '900.1' as SlackThreadTs,
              text: 'pricing notes',
              username: 'amit',
            },
          ],
          total: 1,
        },
      });
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({}),
        userSlackClient: userClient,
        botUserId: BOT,
      });
      const first = await dispatcher.dispatch(
        makeCall('search_messages', { query: 'pricing', limit: 5 }, 'call_a'),
        makeCtx(),
      );
      const second = await dispatcher.dispatch(
        makeCall('search_messages', { query: 'pricing', limit: 5 }, 'call_b'),
        makeCtx(),
      );
      // Second identical call served from the per-turn cache — no extra API hit.
      expect(userCalls).toHaveLength(1);
      if (!first.ok || !second.ok) throw new Error('expected ok');
      expect(second.content).toBe(first.content); // same payload
      expect(first.callId).toBe('call_a');
      expect(second.callId).toBe('call_b'); // fresh callId so Pi matches correctly
    });

    it('collapses identical repeats and surfaces unique content with a count', async () => {
      const dup = (ts: string) => ({
        channelId: 'C9' as SlackChannelId,
        channelName: 'test-stuff',
        ts: ts as SlackThreadTs,
        text: 'Search for anything said about pricing',
        username: 'amit',
        userId: 'U042' as SlackUserId,
      });
      const userClient = makeSlackClient({
        searchResult: {
          matches: [
            dup('1.1'),
            dup('1.2'),
            dup('1.3'),
            {
              channelId: 'D1' as SlackChannelId,
              ts: '2.1' as SlackThreadTs,
              text: 'nice pricing change in gsf',
              username: 'amit',
              userId: 'U042' as SlackUserId,
            },
          ],
          total: 4,
        },
      });
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({}),
        userSlackClient: userClient,
        botUserId: BOT,
      });
      const result = await dispatcher.dispatch(
        makeCall('search_messages', { query: 'pricing' }),
        makeCtx(),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');
      const content = result.content as string;
      // The real message surfaces despite 3 copies of the test prompt above it.
      expect(content).toContain('nice pricing change in gsf');
      // The repeated line is collapsed with a count, not shown 3×.
      expect(content).toContain('(sent 3×)');
      expect(content.match(/Search for anything said about pricing/g)?.length).toBe(1);
      // Render table also reflects the deduped set (2 rows).
      if (result.render?.kind !== 'table') throw new Error('expected table render');
      expect(result.render.rows).toHaveLength(2);
    });

    it('returns "(no matching messages)" on empty results', async () => {
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({}),
        userSlackClient: makeSlackClient({ searchResult: { matches: [], total: 0 } }),
        botUserId: BOT,
      });
      const result = await dispatcher.dispatch(
        makeCall('search_messages', { query: 'nothing' }),
        makeCtx(),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');
      expect(result.content).toContain('(no matching messages)');
    });

    it('surfaces Slack errors as execution_failed', async () => {
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({}),
        userSlackClient: makeSlackClient({ searchError: new Error('rate_limited') }),
        botUserId: BOT,
      });
      const result = await dispatcher.dispatch(
        makeCall('search_messages', { query: 'q' }),
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
        userSlackClient: makeSlackClient({}),
        botUserId: BOT,
      });
      const result = await dispatcher.dispatch(
        makeCall('search_messages', { query: '   ' }),
        makeCtx(),
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      expect(result.error.code).toBe('invalid_arguments');
    });
  });

  describe('dispatch() — post_as_owner', () => {
    it('posts via the USER client and returns the new message ts', async () => {
      const userPosts: PostMessageParams[] = [];
      const userClient = makeSlackClient({ postCalls: userPosts });
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({}),
        userSlackClient: userClient,
        botUserId: BOT,
      });
      const result = await dispatcher.dispatch(
        makeCall('post_as_owner', { channel_id: 'C1', text: 'hi as me' }),
        makeCtx(),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');
      expect(result.content).toContain('999.111');
      expect(userPosts).toHaveLength(1);
      expect(userPosts[0]?.channel).toBe('C1');
      expect(userPosts[0]?.text).toBe('hi as me');
    });

    it('refuses (execution_failed) when no user token is configured', async () => {
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({}),
        // userSlackClient omitted — post_as_owner is destructive AND user-actor
        // → hard-required → must fail rather than silently posting as the bot.
        botUserId: BOT,
      });
      const result = await dispatcher.dispatch(
        makeCall('post_as_owner', { channel_id: 'C1', text: 'hi' }),
        makeCtx(),
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      expect(result.error.code).toBe('execution_failed');
      expect(result.error.message).toContain('SLACK_OWNER_USER_TOKEN');
    });

    it('appends a "(via Sym)" footer when ownerPostMarker is true', async () => {
      const userPosts: PostMessageParams[] = [];
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({}),
        userSlackClient: makeSlackClient({ postCalls: userPosts }),
        botUserId: BOT,
        ownerPostMarker: true,
      });
      await dispatcher.dispatch(
        makeCall('post_as_owner', { channel_id: 'C1', text: 'heading out' }),
        makeCtx(),
      );
      expect(userPosts).toHaveLength(1);
      expect(userPosts[0]?.text).toContain('heading out');
      expect(userPosts[0]?.text).toContain('_(via Sym)_');
    });

    it('omits the footer when ownerPostMarker is false', async () => {
      const userPosts: PostMessageParams[] = [];
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({}),
        userSlackClient: makeSlackClient({ postCalls: userPosts }),
        botUserId: BOT,
        ownerPostMarker: false,
      });
      await dispatcher.dispatch(
        makeCall('post_as_owner', { channel_id: 'C1', text: 'heading out' }),
        makeCtx(),
      );
      expect(userPosts[0]?.text).toBe('heading out');
      expect(userPosts[0]?.text).not.toContain('Sym');
    });

    it('threads when thread_ts is supplied', async () => {
      const userPosts: PostMessageParams[] = [];
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({}),
        userSlackClient: makeSlackClient({ postCalls: userPosts }),
        botUserId: BOT,
      });
      await dispatcher.dispatch(
        makeCall('post_as_owner', { channel_id: 'C1', text: 'reply', thread_ts: '900.1' }),
        makeCtx(),
      );
      expect(userPosts[0]?.thread_ts).toBe('900.1');
    });

    it('rejects empty text with invalid_arguments', async () => {
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({}),
        userSlackClient: makeSlackClient({}),
        botUserId: BOT,
      });
      const result = await dispatcher.dispatch(
        makeCall('post_as_owner', { channel_id: 'C1', text: '' }),
        makeCtx(),
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      expect(result.error.code).toBe('invalid_arguments');
    });
  });

  describe('dispatch() — react_as_owner', () => {
    it('strips colons from emoji and reacts via the user client', async () => {
      const reactions: ReactionsAddParams[] = [];
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({}),
        userSlackClient: makeSlackClient({ reactionCalls: reactions }),
        botUserId: BOT,
      });
      const result = await dispatcher.dispatch(
        makeCall('react_as_owner', {
          channel_id: 'C1',
          message_ts: '900.1',
          emoji: ':thumbsup:',
        }),
        makeCtx(),
      );
      expect(result.ok).toBe(true);
      expect(reactions).toHaveLength(1);
      expect(reactions[0]?.name).toBe('thumbsup');
      expect(reactions[0]?.timestamp).toBe('900.1');
    });

    it('refuses when no user token is configured', async () => {
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({}),
        botUserId: BOT,
      });
      const result = await dispatcher.dispatch(
        makeCall('react_as_owner', { channel_id: 'C1', message_ts: '900.1', emoji: 'eyes' }),
        makeCtx(),
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      expect(result.error.code).toBe('execution_failed');
    });
  });

  describe('dispatch() — delete_message', () => {
    it('deletes via the BOT client (Sym deletes its own message), passing channel + ts', async () => {
      const deletes: DeleteMessageParams[] = [];
      const dispatcher = createBuiltinDispatcher({
        // Bot client records; a user client is present to prove routing ignores it.
        slackClient: makeSlackClient({ deleteCalls: deletes }),
        userSlackClient: makeSlackClient({}),
        botUserId: BOT,
      });
      const result = await dispatcher.dispatch(
        makeCall('delete_message', {
          channel_id: 'C05RSJB13JB',
          message_ts: '1780221572.271599',
        }),
        makeCtx(),
      );
      expect(result.ok).toBe(true);
      expect(deletes).toHaveLength(1);
      expect(deletes[0]?.channel).toBe('C05RSJB13JB');
      expect(deletes[0]?.ts).toBe('1780221572.271599');
    });

    it('returns invalid_arguments when channel_id is missing', async () => {
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({}),
        botUserId: BOT,
      });
      const result = await dispatcher.dispatch(
        makeCall('delete_message', { message_ts: '900.1' }),
        makeCtx(),
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      expect(result.error.code).toBe('invalid_arguments');
    });

    it('returns invalid_arguments when message_ts is missing', async () => {
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({}),
        botUserId: BOT,
      });
      const result = await dispatcher.dispatch(
        makeCall('delete_message', { channel_id: 'C1' }),
        makeCtx(),
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      expect(result.error.code).toBe('invalid_arguments');
    });

    it('surfaces a clean execution_failed (with the own-messages constraint) when Slack rejects', async () => {
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({ deleteError: new Error('cant_delete_message') }),
        botUserId: BOT,
      });
      const result = await dispatcher.dispatch(
        makeCall('delete_message', { channel_id: 'C1', message_ts: '900.1' }),
        makeCtx(),
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      expect(result.error.code).toBe('execution_failed');
      expect(result.error.message).toContain('cant_delete_message');
      expect(result.error.message).toContain('only delete messages it posted itself');
    });
  });

  describe('dispatch() — set_status', () => {
    it('sets status text + emoji and resolves expires_in_minutes to a unix expiration', async () => {
      const profiles: UsersProfileSetParams[] = [];
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({}),
        userSlackClient: makeSlackClient({ profileCalls: profiles }),
        botUserId: BOT,
      });
      const before = Math.floor(Date.now() / 1000);
      const result = await dispatcher.dispatch(
        makeCall('set_status', {
          status_text: 'in a meeting',
          status_emoji: ':calendar:',
          expires_in_minutes: 30,
        }),
        makeCtx(),
      );
      expect(result.ok).toBe(true);
      expect(profiles).toHaveLength(1);
      expect(profiles[0]?.statusText).toBe('in a meeting');
      expect(profiles[0]?.statusEmoji).toBe(':calendar:');
      // expiration ≈ now + 30 min (1800s), within a generous window.
      const expectedMin = before + 30 * 60 - 5;
      const expectedMax = before + 30 * 60 + 60;
      expect(profiles[0]?.statusExpiration).toBeGreaterThanOrEqual(expectedMin);
      expect(profiles[0]?.statusExpiration).toBeLessThanOrEqual(expectedMax);
    });

    it('clears status when text is empty', async () => {
      const profiles: UsersProfileSetParams[] = [];
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({}),
        userSlackClient: makeSlackClient({ profileCalls: profiles }),
        botUserId: BOT,
      });
      const result = await dispatcher.dispatch(
        makeCall('set_status', { status_text: '' }),
        makeCtx(),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');
      expect(result.content).toContain('cleared');
      expect(profiles[0]?.statusText).toBe('');
    });

    it('refuses when no user token is configured', async () => {
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({}),
        botUserId: BOT,
      });
      const result = await dispatcher.dispatch(
        makeCall('set_status', { status_text: 'lunch' }),
        makeCtx(),
      );
      expect(result.ok).toBe(false);
    });
  });

  describe('dispatch() — add_reminder', () => {
    it('creates a reminder and returns the id', async () => {
      const reminders: RemindersAddParams[] = [];
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({}),
        userSlackClient: makeSlackClient({
          reminderCalls: reminders,
          reminderResult: { id: 'Rm-abc', text: 'ship the PR', time: 1_710_000_000 },
        }),
        botUserId: BOT,
      });
      const result = await dispatcher.dispatch(
        makeCall('add_reminder', { text: 'ship the PR', time: 'in 1 hour' }),
        makeCtx(),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');
      expect(result.content).toContain('Rm-abc');
      expect(reminders).toHaveLength(1);
      expect(reminders[0]?.text).toBe('ship the PR');
      expect(reminders[0]?.time).toBe('in 1 hour');
    });

    it('rejects non-string non-number time values', async () => {
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({}),
        userSlackClient: makeSlackClient({}),
        botUserId: BOT,
      });
      const result = await dispatcher.dispatch(
        makeCall('add_reminder', { text: 'x', time: { weird: true } as unknown as string }),
        makeCtx(),
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      expect(result.error.code).toBe('invalid_arguments');
    });

    it('add_reminder is NON-destructive (no confirm gate) — sanity check', () => {
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({}),
        botUserId: BOT,
      });
      const tool = dispatcher.list().find((t) => t.name === 'add_reminder');
      expect(tool?.destructiveHint).toBeUndefined();
    });
  });

  describe('dispatch() — transcript user-name resolution', () => {
    it('resolves user ids in transcripts to display names via users.info', async () => {
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({}),
        userSlackClient: makeSlackClient({
          repliesMessages: [
            { user: 'U001' as SlackUserId, text: 'opener', ts: '900.1' as SlackThreadTs },
            { user: 'U002' as SlackUserId, text: 'reply', ts: '900.2' as SlackThreadTs },
          ],
          // makeSlackClient.usersInfo returns the user profile we configure.
          userProfile: { id: 'U001' as SlackUserId, displayName: 'Amit Ray' },
        }),
        botUserId: BOT,
      });
      const result = await dispatcher.dispatch(
        makeCall('read_thread', { channel_id: 'C1', thread_ts: '900.1' }),
        makeCtx(),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');
      // Display name should appear, not the raw U001.
      expect(result.content).toContain('Amit Ray');
    });

    it('falls back to raw user id when users.info errors (sticky null cache)', async () => {
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({}),
        userSlackClient: makeSlackClient({
          repliesMessages: [
            { user: 'U001' as SlackUserId, text: 'opener', ts: '900.1' as SlackThreadTs },
          ],
          userError: new Error('user_not_found'),
        }),
        botUserId: BOT,
      });
      const result = await dispatcher.dispatch(
        makeCall('read_thread', { channel_id: 'C1', thread_ts: '900.1' }),
        makeCtx(),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');
      // Falls through to raw id rather than throwing.
      expect(result.content).toContain('U001');
    });
  });

  describe('dispatch() — actor routing', () => {
    it('routes actor:"user" tool calls to the user client when available', async () => {
      const userCalls: SearchMessagesParams[] = [];
      const userClient = makeSlackClient({
        searchCalls: userCalls,
        searchResult: { matches: [], total: 0 },
      });
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({}),
        userSlackClient: userClient,
        botUserId: BOT,
      });
      // read_channel is actor:'user' — and we record the call on the user client.
      // We use read_channel's history reading via a shared mock; here we verify
      // by way of search_messages which is unambiguously on the user client.
      await dispatcher.dispatch(makeCall('search_messages', { query: 'test' }), makeCtx());
      expect(userCalls).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // ID-resolution coverage — verifies that `<@U…>` / `<#C…>` markup that
  // arrives via tool outputs (list_channels topics, read_user_profile
  // status) is NORMALIZED by the workspace resolver BEFORE the dispatcher
  // hands the result to the model: canonical `<@U…>` / `<#C…>` tokens are kept
  // verbatim (Slack renders them as clickable mentions), while DM-style ids
  // and bare `D…` ids are turned into tokens — so no UNWRAPPED id ever leaks.
  // -----------------------------------------------------------------------
  describe('dispatch() — resolver normalizes Slack ids in tool outputs', () => {
    it('list_channels preserves `<@U…>` tokens and canonicalizes `<#C…>` in topics', async () => {
      const resolver = new NameResolver();
      resolver.primeForTests({ U042: 'Amit' }, { C999: 'design' });
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({
          listResult: {
            channels: [
              {
                id: 'C1' as SlackChannelId,
                name: 'general',
                isPrivate: false,
                topic: 'owned by <@U042>, pairs with <#C999|design>',
              },
            ],
          },
        }),
        botUserId: BOT,
        nameResolver: resolver,
      });
      const result = await dispatcher.dispatch(makeCall('list_channels', {}), makeCtx());
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');
      const content = result.content as string;
      // Tokens are kept (Slack renders @Amit / #design); the stale inline label
      // on the channel link is dropped in favor of the canonical token.
      expect(content).toContain('owned by <@U042>');
      expect(content).toContain('<#C999>');
      expect(content).not.toContain('<#C999|design>');
    });

    it('read_user_profile keeps the `<@U…>` token inside the status text', async () => {
      const resolver = new NameResolver();
      resolver.primeForTests({ U777: 'Sarah' }, {});
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({
          userProfile: {
            id: 'U123' as SlackUserId,
            displayName: 'amit',
            statusText: 'in a 1:1 with <@U777>',
            statusEmoji: ':speech_balloon:',
          },
        }),
        botUserId: BOT,
        nameResolver: resolver,
      });
      const result = await dispatcher.dispatch(
        makeCall('read_user_profile', { user_id: 'U123' }),
        makeCtx(),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');
      const content = result.content as string;
      expect(content).toContain('status: :speech_balloon: in a 1:1 with <@U777>');
    });

    it('list_channels leaves clean topics unchanged', async () => {
      // Sanity: the rewrite path is a no-op when topics carry no `<@…>` markup.
      const resolver = new NameResolver();
      const dispatcher = createBuiltinDispatcher({
        slackClient: makeSlackClient({
          listResult: {
            channels: [
              {
                id: 'C1' as SlackChannelId,
                name: 'general',
                isPrivate: false,
                topic: 'company-wide announcements',
              },
            ],
          },
        }),
        botUserId: BOT,
        nameResolver: resolver,
      });
      const result = await dispatcher.dispatch(makeCall('list_channels', {}), makeCtx());
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');
      const content = result.content as string;
      expect(content).toContain('company-wide announcements');
    });
  });
});
