import { describe, expect, it } from 'vitest';

import { threadToHistory } from '../src/thread.js';

import type { SlackThreadMessage } from '../src/client.js';
import type { SlackThreadTs, SlackUserId } from '@sym/contracts';

const BOT = 'UBOT' as SlackUserId;

function msg(
  over: Partial<SlackThreadMessage> & { ts: SlackThreadTs; text: string },
): SlackThreadMessage {
  return {
    ts: over.ts,
    text: over.text,
    ...(over.user !== undefined ? { user: over.user } : {}),
    ...(over.botId !== undefined ? { botId: over.botId } : {}),
    ...(over.subtype !== undefined ? { subtype: over.subtype } : {}),
  };
}

describe('threadToHistory', () => {
  it('maps Sym to assistant (no label) and others to labelled user messages', () => {
    const history = threadToHistory(
      [
        msg({
          ts: '1' as SlackThreadTs,
          user: 'U1' as SlackUserId,
          text: 'should we migrate to PG16?',
        }),
        msg({ ts: '2' as SlackThreadTs, user: BOT, text: 'here are the tradeoffs' }),
        msg({
          ts: '3' as SlackThreadTs,
          user: 'U2' as SlackUserId,
          text: 'what about extensions?',
        }),
      ],
      { botUserId: BOT },
    );

    expect(history).toEqual([
      { role: 'user', content: 'U1: should we migrate to PG16?' },
      { role: 'assistant', content: 'here are the tradeoffs' },
      { role: 'user', content: 'U2: what about extensions?' },
    ]);
  });

  it('strips a leading bot mention from thread text', () => {
    const history = threadToHistory(
      [
        msg({
          ts: '1' as SlackThreadTs,
          user: 'U1' as SlackUserId,
          text: '<@UBOT> summarize the risks',
        }),
      ],
      { botUserId: BOT },
    );
    expect(history[0]).toEqual({ role: 'user', content: 'U1: summarize the risks' });
  });

  it('drops the excluded (triggering) message', () => {
    const history = threadToHistory(
      [
        msg({ ts: '1' as SlackThreadTs, user: 'U1' as SlackUserId, text: 'earlier context' }),
        msg({ ts: '99' as SlackThreadTs, user: 'U2' as SlackUserId, text: '<@UBOT> do the thing' }),
      ],
      { botUserId: BOT, excludeTs: '99' as SlackThreadTs },
    );
    expect(history).toEqual([{ role: 'user', content: 'U1: earlier context' }]);
  });

  it('drops membership/admin noise and empty/mention-only messages', () => {
    const history = threadToHistory(
      [
        msg({ ts: '1' as SlackThreadTs, user: 'U1' as SlackUserId, text: 'real message' }),
        msg({
          ts: '2' as SlackThreadTs,
          user: 'U2' as SlackUserId,
          text: 'joined',
          subtype: 'channel_join',
        }),
        msg({ ts: '3' as SlackThreadTs, user: 'U3' as SlackUserId, text: '   ' }),
        msg({ ts: '4' as SlackThreadTs, user: 'U4' as SlackUserId, text: '<@UBOT>' }),
      ],
      { botUserId: BOT },
    );
    expect(history).toEqual([{ role: 'user', content: 'U1: real message' }]);
  });

  it('treats other bots as user-context, labelled by bot id', () => {
    const history = threadToHistory(
      [msg({ ts: '1' as SlackThreadTs, botId: 'B_CI', text: 'build passed' })],
      {
        botUserId: BOT,
      },
    );
    expect(history[0]).toEqual({ role: 'user', content: 'B_CI: build passed' });
  });

  it('uses the display-name map when provided', () => {
    const history = threadToHistory(
      [msg({ ts: '1' as SlackThreadTs, user: 'U1' as SlackUserId, text: 'hi' })],
      {
        botUserId: BOT,
        names: { U1: 'Alice' },
      },
    );
    expect(history[0]).toEqual({ role: 'user', content: 'Alice: hi' });
  });

  it('trims to maxMessages, keeping the root + most recent', () => {
    const messages = Array.from({ length: 10 }, (_, i) =>
      msg({ ts: String(i) as SlackThreadTs, user: 'U1' as SlackUserId, text: `m${i}` }),
    );
    const history = threadToHistory(messages, { botUserId: BOT, maxMessages: 3 });

    // root (m0) + last two (m8, m9)
    expect(history.map((h) => h.content)).toEqual(['U1: m0', 'U1: m8', 'U1: m9']);
  });
});
