import { afterEach, describe, expect, it, vi } from 'vitest';

import { WebApiSlackClient } from './slack-client.js';

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
    const body = callBody(fetchFn, 0);
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
    expect(callBody(fetchFn, 1)['cursor']).toBe('CURSOR2');
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
    expect(callBody(fetchFn, 0)['limit']).toBe(2);
  });

  it('throws on a Slack error (e.g. missing_scope) so the caller can fall back', async () => {
    mockFetch([{ ok: false, error: 'missing_scope' }]);
    const client = new WebApiSlackClient('xoxb-test');
    await expect(client.conversationsReplies({ channel: CHANNEL, ts: ROOT })).rejects.toThrow(
      'missing_scope',
    );
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

  it('appendStream sends ts + markdown_text', async () => {
    const fetchFn = mockFetch([{ ok: true }]);
    const client = new WebApiSlackClient('xoxb-test');

    await client.chatAppendStream({
      channel: CHANNEL,
      ts: '500.1' as SlackThreadTs,
      markdownText: 'chunk',
    });

    expect(callBody(fetchFn, 0)).toMatchObject({ ts: '500.1', markdown_text: 'chunk' });
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
