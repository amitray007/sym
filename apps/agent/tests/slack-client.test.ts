import { afterEach, describe, expect, it, vi } from 'vitest';

import { WebApiSlackClient } from '../src/slack-client.js';

import type { SlackChannelId, SlackThreadTs, SlackUserId } from '@sym/contracts';

const CHANNEL = 'C1' as SlackChannelId;
const ROOT = '100.1' as SlackThreadTs;

/** Stub `fetch` to return each given JSON body in order, as a 200 response. */
function mockFetch(bodies: unknown[]): ReturnType<typeof vi.fn> {
  const fn = vi.fn();
  for (const body of bodies) {
    fn.mockResolvedValueOnce({ status: 200, json: async () => body });
  }
  vi.stubGlobal('fetch', fn);
  return fn;
}

/** Parse the JSON request body of the Nth fetch call. */
function callBody(fn: ReturnType<typeof vi.fn>, n: number): Record<string, unknown> {
  return JSON.parse((fn.mock.calls[n]![1] as { body: string }).body) as Record<string, unknown>;
}

/**
 * Parse the form-urlencoded request body of the Nth fetch call. Slack read
 * methods (conversations.replies / conversations.history) send
 * `application/x-www-form-urlencoded`, so every value comes back as a string.
 */
function callFormBody(fn: ReturnType<typeof vi.fn>, n: number): Record<string, string> {
  const body = (fn.mock.calls[n]![1] as { body: string }).body;
  return Object.fromEntries(new URLSearchParams(body));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('WebApiSlackClient.conversationsReplies', () => {
  it('fetches a single page and maps user vs bot messages', async () => {
    const fetchFn = mockFetch([
      {
        ok: true,
        messages: [
          { user: 'U1', text: 'root question', ts: '100.1' },
          { bot_id: 'B9', text: 'beep', ts: '100.2', subtype: 'bot_message' },
        ],
      },
    ]);

    const client = new WebApiSlackClient('xoxb-test');
    const { messages } = await client.conversationsReplies({ channel: CHANNEL, ts: ROOT });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(messages).toEqual([
      { user: 'U1', text: 'root question', ts: '100.1' },
      { botId: 'B9', text: 'beep', ts: '100.2', subtype: 'bot_message' },
    ]);
    // First page request carries channel + ts and no cursor.
    const body = callFormBody(fetchFn, 0);
    expect(body['channel']).toBe('C1');
    expect(body['ts']).toBe('100.1');
    expect(body['cursor']).toBeUndefined();
  });

  it('paginates via next_cursor and concatenates pages', async () => {
    const fetchFn = mockFetch([
      {
        ok: true,
        messages: [{ user: 'U1', text: 'a', ts: '1' }],
        response_metadata: { next_cursor: 'CURSOR2' },
      },
      { ok: true, messages: [{ user: 'U2', text: 'b', ts: '2' }] },
    ]);

    const client = new WebApiSlackClient('xoxb-test');
    const { messages } = await client.conversationsReplies({ channel: CHANNEL, ts: ROOT });

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(messages.map((m) => m.text)).toEqual(['a', 'b']);
    // Second page forwards the cursor Slack handed back.
    expect(callFormBody(fetchFn, 1)['cursor']).toBe('CURSOR2');
  });

  it('stops paginating once the limit ceiling is met, even if more remain', async () => {
    const fetchFn = mockFetch([
      {
        ok: true,
        messages: [
          { user: 'U1', text: 'a', ts: '1' },
          { user: 'U2', text: 'b', ts: '2' },
        ],
        response_metadata: { next_cursor: 'CURSOR2' },
      },
    ]);

    const client = new WebApiSlackClient('xoxb-test');
    const { messages } = await client.conversationsReplies({
      channel: CHANNEL,
      ts: ROOT,
      limit: 2,
    });

    // Ceiling reached after page 1 → no second fetch despite next_cursor.
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(messages).toHaveLength(2);
    expect(callFormBody(fetchFn, 0)['limit']).toBe('2');
  });

  it('throws on a Slack error (e.g. missing_scope) so the caller can fall back', async () => {
    mockFetch([{ ok: false, error: 'missing_scope' }]);
    const client = new WebApiSlackClient('xoxb-test');
    await expect(client.conversationsReplies({ channel: CHANNEL, ts: ROOT })).rejects.toThrow(
      'missing_scope',
    );
  });
});

describe('WebApiSlackClient.conversationsHistory', () => {
  it('fetches a single page, reverses newest-first to oldest-first', async () => {
    const fetchFn = mockFetch([
      {
        ok: true,
        messages: [
          { user: 'U2', text: 'newer message', ts: '200.2' },
          { user: 'U1', text: 'older message', ts: '200.1' },
        ],
      },
    ]);

    const client = new WebApiSlackClient('xoxb-test');
    const { messages } = await client.conversationsHistory({ channel: CHANNEL });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    // Slack returned newest-first; impl must reverse to oldest-first.
    expect(messages.map((m) => m.text)).toEqual(['older message', 'newer message']);
    // Channel is passed; no ts field (unlike replies).
    const body = callFormBody(fetchFn, 0);
    expect(body['channel']).toBe('C1');
    expect(body['ts']).toBeUndefined();
    expect(body['cursor']).toBeUndefined();
  });

  it('paginates via next_cursor and returns all messages oldest-first', async () => {
    const fetchFn = mockFetch([
      {
        ok: true,
        messages: [
          { user: 'U1', text: 'newest page1', ts: '300.3' },
          { user: 'U1', text: 'newer page1', ts: '300.2' },
        ],
        response_metadata: { next_cursor: 'CURSOR2' },
      },
      {
        ok: true,
        messages: [{ user: 'U1', text: 'older page2', ts: '300.1' }],
      },
    ]);

    const client = new WebApiSlackClient('xoxb-test');
    const { messages } = await client.conversationsHistory({ channel: CHANNEL });

    expect(fetchFn).toHaveBeenCalledTimes(2);
    // Second call should carry the cursor.
    expect(callFormBody(fetchFn, 1)['cursor']).toBe('CURSOR2');
    // After collecting both pages (interleaved newest-first), reversed to oldest-first.
    // Page 1 had ts 300.3, 300.2 and page 2 had 300.1; all collected then reversed.
    expect(messages.map((m) => m.ts)).toEqual(['300.1', '300.2', '300.3']);
  });

  it('maps user vs bot messages correctly', async () => {
    mockFetch([
      {
        ok: true,
        messages: [
          { bot_id: 'B1', text: 'bot msg', ts: '400.2', subtype: 'bot_message' },
          { user: 'U1', text: 'user msg', ts: '400.1' },
        ],
      },
    ]);

    const client = new WebApiSlackClient('xoxb-test');
    const { messages } = await client.conversationsHistory({ channel: CHANNEL });

    // Reversed: user msg first, then bot msg.
    expect(messages[0]).toEqual({ user: 'U1', text: 'user msg', ts: '400.1' });
    expect(messages[1]).toEqual({
      botId: 'B1',
      text: 'bot msg',
      ts: '400.2',
      subtype: 'bot_message',
    });
  });

  it('stops paginating once the limit ceiling is met', async () => {
    const fetchFn = mockFetch([
      {
        ok: true,
        messages: [
          { user: 'U1', text: 'a', ts: '1' },
          { user: 'U2', text: 'b', ts: '2' },
        ],
        response_metadata: { next_cursor: 'CURSOR2' },
      },
    ]);

    const client = new WebApiSlackClient('xoxb-test');
    const { messages } = await client.conversationsHistory({ channel: CHANNEL, limit: 2 });

    // Ceiling reached after page 1 → no second fetch despite next_cursor.
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(messages).toHaveLength(2);
  });
});

describe('WebApiSlackClient assistant + streaming methods', () => {
  it('startStream returns the stream handle and omits recipient_* for DMs', async () => {
    const fetchFn = mockFetch([{ ok: true, channel: 'D1', ts: '500.1' }]);
    const client = new WebApiSlackClient('xoxb-test');

    const handle = await client.chatStartStream({
      channel: 'D1' as SlackChannelId,
      threadTs: ROOT,
    });

    expect(handle).toEqual({ channel: 'D1', ts: '500.1' });
    const body = callBody(fetchFn, 0);
    expect(body['thread_ts']).toBe('100.1');
    expect(body['recipient_user_id']).toBeUndefined();
    expect(body['recipient_team_id']).toBeUndefined();
  });

  it('startStream forwards recipient_* when streaming to a channel', async () => {
    const fetchFn = mockFetch([{ ok: true, channel: 'C1', ts: '500.2' }]);
    const client = new WebApiSlackClient('xoxb-test');

    await client.chatStartStream({
      channel: CHANNEL,
      threadTs: ROOT,
      recipientUserId: 'U1' as SlackUserId,
      recipientTeamId: 'T1',
    });

    const body = callBody(fetchFn, 0);
    expect(body['recipient_user_id']).toBe('U1');
    expect(body['recipient_team_id']).toBe('T1');
  });

  it('appendStream normalises markdownText into a markdown_text chunk', async () => {
    const fetchFn = mockFetch([{ ok: true }]);
    const client = new WebApiSlackClient('xoxb-test');

    await client.chatAppendStream({
      channel: CHANNEL,
      ts: '500.1' as SlackThreadTs,
      markdownText: 'chunk',
    });

    // Slack drops the top-level markdown_text param when interleaved with
    // chunks in the same stream — we always send via `chunks`.
    expect(callBody(fetchFn, 0)).toMatchObject({
      ts: '500.1',
      chunks: [{ type: 'markdown_text', text: 'chunk' }],
    });
    expect(callBody(fetchFn, 0)['markdown_text']).toBeUndefined();
  });

  it('authTest returns the identity the token is acting as', async () => {
    const fetchFn = mockFetch([
      { ok: true, user_id: 'U1', team_id: 'T1', user: 'amit', bot_id: undefined },
    ]);
    const client = new WebApiSlackClient('xoxp-user');
    const result = await client.authTest();
    expect(result.userId).toBe('U1');
    expect(result.teamId).toBe('T1');
    expect(result.user).toBe('amit');
    expect(result.isBot).toBeUndefined();
    expect(fetchFn).toHaveBeenCalled();
  });

  it('searchMessages POSTs form-urlencoded query and maps Slack matches', async () => {
    const fetchFn = mockFetch([
      {
        ok: true,
        messages: {
          total: 1,
          matches: [
            {
              channel: { id: 'C1', name: 'eng' },
              username: 'amit',
              user: 'U1',
              ts: '900.1',
              text: 'upgrade postgres',
              permalink: 'https://slack.com/archives/C1/p9001',
            },
          ],
        },
      },
    ]);
    const client = new WebApiSlackClient('xoxp-user');
    const result = await client.searchMessages({ query: 'postgres', count: 5 });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.channelId).toBe('C1');
    expect(result.matches[0]?.channelName).toBe('eng');
    expect(result.matches[0]?.username).toBe('amit');
    expect(result.matches[0]?.text).toBe('upgrade postgres');
    expect(result.matches[0]?.permalink).toBe('https://slack.com/archives/C1/p9001');
    expect(result.total).toBe(1);
    // search.messages is form-urlencoded, not JSON.
    expect(fetchFn.mock.calls[0]?.[1]).toMatchObject({
      headers: expect.objectContaining({
        'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
      }),
    });
  });

  it('appendStream forwards task_update chunks unchanged', async () => {
    const fetchFn = mockFetch([{ ok: true }]);
    const client = new WebApiSlackClient('xoxb-test');

    await client.chatAppendStream({
      channel: CHANNEL,
      ts: '500.1' as SlackThreadTs,
      chunks: [{ type: 'task_update', id: 'task-1', title: 'Reading', status: 'in_progress' }],
    });

    expect(callBody(fetchFn, 0)).toMatchObject({
      ts: '500.1',
      chunks: [{ type: 'task_update', id: 'task-1', title: 'Reading', status: 'in_progress' }],
    });
  });

  it('stopStream attaches bottom blocks when provided', async () => {
    const fetchFn = mockFetch([{ ok: true }]);
    const client = new WebApiSlackClient('xoxb-test');

    await client.chatStopStream({
      channel: CHANNEL,
      ts: '500.1' as SlackThreadTs,
      blocks: [{ type: 'context' }],
    });

    expect(callBody(fetchFn, 0)['blocks']).toEqual([{ type: 'context' }]);
  });

  it('setSuggestedPrompts and setTitle use channel_id/thread_ts', async () => {
    const fetchFn = mockFetch([{ ok: true }, { ok: true }]);
    const client = new WebApiSlackClient('xoxb-test');

    await client.assistantThreadsSetSuggestedPrompts({
      channelId: 'D1' as SlackChannelId,
      threadTs: ROOT,
      prompts: [{ title: 'Catch me up', message: 'Summarize this thread' }],
    });
    await client.assistantThreadsSetTitle({
      channelId: 'D1' as SlackChannelId,
      threadTs: ROOT,
      title: 'Migration risks',
    });

    expect(callBody(fetchFn, 0)).toMatchObject({
      channel_id: 'D1',
      thread_ts: '100.1',
      prompts: [{ title: 'Catch me up', message: 'Summarize this thread' }],
    });
    expect(callBody(fetchFn, 1)).toMatchObject({ channel_id: 'D1', title: 'Migration risks' });
  });
});

describe('WebApiSlackClient retry layer', () => {
  it('retries on HTTP 429 then succeeds (automatic, no per-call opt-in)', async () => {
    vi.useFakeTimers();
    try {
      const fetchFn = vi.fn();
      fetchFn.mockResolvedValueOnce({
        status: 429,
        headers: { get: () => '0' },
        json: async () => ({}),
      });
      fetchFn.mockResolvedValueOnce({
        status: 200,
        json: async () => ({ ok: true, ts: '9.9', channel: 'C1' }),
      });
      vi.stubGlobal('fetch', fetchFn);

      const client = new WebApiSlackClient('xoxb-test');
      const promise = client.chatPostMessage({ channel: CHANNEL, text: 'hi' });
      await vi.runAllTimersAsync(); // drive the backoff sleep + the retry
      const result = await promise;

      expect(fetchFn).toHaveBeenCalledTimes(2);
      expect(result.ts).toBe('9.9');
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces a terminal Slack error as an Error, without retrying', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce({
      status: 200,
      json: async () => ({ ok: false, error: 'channel_not_found' }),
    });
    vi.stubGlobal('fetch', fetchFn);

    const client = new WebApiSlackClient('xoxb-test');
    await expect(client.chatPostMessage({ channel: CHANNEL, text: 'hi' })).rejects.toThrow(
      'channel_not_found',
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
