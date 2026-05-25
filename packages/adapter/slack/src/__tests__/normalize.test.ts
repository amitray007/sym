import { describe, expect, it } from 'vitest';

import {
  assistantThreadContextChanged,
  assistantThreadStarted,
  normalizeSlackEvent,
  slackTurnInputToTurn,
  type RawSlackEvent,
} from '../normalize.js';

import type { SlackUserId, WorkspaceId } from '@sym/contracts';

// ---- fixtures --------------------------------------------------------------

const WORKSPACE_ID = 'ws-test-001' as WorkspaceId;
const BOT_USER_ID = 'UBOT001' as SlackUserId;

function appMentionEvent(): RawSlackEvent {
  return {
    type: 'event_callback',
    event_id: 'Ev001',
    team_id: 'T001',
    event: {
      type: 'app_mention',
      ts: '1700000001.000001',
      user: 'U001',
      channel: 'C001',
      thread_ts: '1700000000.000001',
      text: '<@UBOT001> hello world',
    },
  };
}

function dmEvent(): RawSlackEvent {
  return {
    type: 'event_callback',
    event_id: 'Ev002',
    team_id: 'T001',
    event: {
      type: 'message',
      channel_type: 'im',
      ts: '1700000002.000001',
      user: 'U001',
      channel: 'D001',
      text: 'hello from DM',
    },
  };
}

function shortcutEvent(): RawSlackEvent {
  return {
    type: 'shortcut',
    callback_id: 'send_to_sym',
    trigger_id: 'trigger001',
    user: { id: 'U001', team_id: 'T001' },
    team: { id: 'T001', domain: 'test' },
    message: {
      ts: '1700000003.000001',
      text: 'shortcut payload text',
      channel: 'C001',
      thread_ts: '1700000000.000001',
    },
  };
}

function slashCommandEvent(): RawSlackEvent {
  return {
    type: 'slash_command',
    command: '/sym',
    user_id: 'U001',
    channel_id: 'C001',
    team_id: 'T001',
    trigger_id: 'trigger002',
    text: 'status',
    // slash commands have no thread_ts
  };
}

/** app_mention posted at channel top level (no thread_ts). */
function topLevelMentionEvent(): RawSlackEvent {
  return {
    type: 'event_callback',
    event_id: 'Ev003',
    team_id: 'T001',
    event: {
      type: 'app_mention',
      ts: '1700000010.000001',
      user: 'U001',
      channel: 'C001',
      text: '<@UBOT001> hi there',
      // no thread_ts — posted at channel top level
    },
  };
}

// ---- tests -----------------------------------------------------------------

describe('normalizeSlackEvent', () => {
  it('normalizes app_mention to SlackTurnInput with mention stripped', () => {
    const result = normalizeSlackEvent({
      event: appMentionEvent(),
      workspaceId: WORKSPACE_ID,
      botUserId: BOT_USER_ID,
    });
    expect(result).not.toBeNull();
    expect(result!.entrySurface).toBe('app_mention');
    expect(result!.eventId).toBe('Ev001');
    expect(result!.requester).toBe('U001');
    expect(result!.channelId).toBe('C001');
    expect(result!.threadTs).toBe('1700000000.000001');
    expect(result!.ts).toBe('1700000001.000001');
    // Leading mention must be stripped
    expect(result!.text).toBe('hello world');
  });

  it('strips mention with extra whitespace', () => {
    const e = appMentionEvent();
    (e.event as Record<string, unknown>).text = '<@UBOT001>   trimmed text';
    const result = normalizeSlackEvent({
      event: e,
      workspaceId: WORKSPACE_ID,
      botUserId: BOT_USER_ID,
    });
    expect(result!.text).toBe('trimmed text');
  });

  it('normalizes dm event', () => {
    const result = normalizeSlackEvent({
      event: dmEvent(),
      workspaceId: WORKSPACE_ID,
      botUserId: BOT_USER_ID,
    });
    expect(result).not.toBeNull();
    expect(result!.entrySurface).toBe('dm');
    expect(result!.channelId).toBe('D001');
    expect(result!.threadTs).toBeUndefined();
    expect(result!.text).toBe('hello from DM');
  });

  it('normalizes shortcut event', () => {
    const result = normalizeSlackEvent({
      event: shortcutEvent(),
      workspaceId: WORKSPACE_ID,
      botUserId: BOT_USER_ID,
    });
    expect(result).not.toBeNull();
    expect(result!.entrySurface).toBe('shortcut');
    expect(result!.text).toBe('shortcut payload text');
    expect(result!.channelId).toBe('C001');
  });

  it('normalizes slash_command event', () => {
    const result = normalizeSlackEvent({
      event: slashCommandEvent(),
      workspaceId: WORKSPACE_ID,
      botUserId: BOT_USER_ID,
    });
    expect(result).not.toBeNull();
    expect(result!.entrySurface).toBe('slash_command');
    expect(result!.text).toBe('status');
    expect(result!.channelId).toBe('C001');
    expect(result!.threadTs).toBeUndefined();
  });

  it('returns null for unrecognized event type', () => {
    const e: RawSlackEvent = {
      type: 'event_callback',
      event_id: 'Ev999',
      team_id: 'T001',
      event: { type: 'reaction_added', user: 'U001', ts: '111.222', channel: 'C001', text: '' },
    };
    const result = normalizeSlackEvent({
      event: e,
      workspaceId: WORKSPACE_ID,
      botUserId: BOT_USER_ID,
    });
    expect(result).toBeNull();
  });
});

describe('slackTurnInputToTurn', () => {
  it('converts SlackTurnInput to Turn with generated IDs', () => {
    const input = normalizeSlackEvent({
      event: appMentionEvent(),
      workspaceId: WORKSPACE_ID,
      botUserId: BOT_USER_ID,
    })!;
    const turn = slackTurnInputToTurn(input);
    expect(turn.workspaceId).toBe(WORKSPACE_ID);
    expect(turn.entrySurface).toBe('app_mention');
    expect(turn.requester).toBe('U001');
    expect(turn.channelId).toBe('C001');
    expect(turn.text).toBe('hello world');
    expect(turn.ts).toBe(input.ts); // triggering message ts propagates to the Turn
    expect(typeof turn.id).toBe('string');
    expect(turn.id.length).toBeGreaterThan(0);
    expect(turn.receivedAt).toBeInstanceOf(Date);
  });
});

describe('reply threading (Sym answers in-thread, never at channel level)', () => {
  function toTurn(event: RawSlackEvent) {
    const input = normalizeSlackEvent({
      event,
      workspaceId: WORKSPACE_ID,
      botUserId: BOT_USER_ID,
    })!;
    return slackTurnInputToTurn(input);
  }

  it('roots a thread on a top-level mention (threadTs = the message ts)', () => {
    expect(toTurn(topLevelMentionEvent()).threadTs).toBe('1700000010.000001');
  });

  it('replies in the existing thread for an already-threaded mention', () => {
    expect(toTurn(appMentionEvent()).threadTs).toBe('1700000000.000001');
  });

  it('leaves DMs flat (no thread) so DM memory stays keyed per-channel', () => {
    expect(toTurn(dmEvent()).threadTs).toBeUndefined();
  });

  it('a top-level mention and its threaded replies resolve to one conversationId', () => {
    const top = toTurn(topLevelMentionEvent());
    const reply = toTurn({
      type: 'event_callback',
      event_id: 'Ev004',
      team_id: 'T001',
      event: {
        type: 'app_mention',
        ts: '1700000011.000001',
        user: 'U001',
        channel: 'C001',
        thread_ts: '1700000010.000001', // inside the thread Sym opened
        text: '<@UBOT001> follow-up',
      },
    });
    expect(top.conversationId).toBe(reply.conversationId);
  });
});

describe('assistantThreadStarted', () => {
  const startedEvent: RawSlackEvent = {
    type: 'event_callback',
    event_id: 'Ev100',
    team_id: 'T001',
    event: {
      type: 'assistant_thread_started',
      ts: '1700000020.000001',
      channel: '',
      text: '',
      assistant_thread: {
        user_id: 'U001',
        channel_id: 'D999',
        thread_ts: '1700000020.000001',
        context: { channel_id: 'C777', team_id: 'T001' },
      },
    },
  };

  it('extracts the assistant channel, thread, and viewed-channel context', () => {
    expect(assistantThreadStarted(startedEvent)).toEqual({
      channelId: 'D999',
      threadTs: '1700000020.000001',
      contextChannelId: 'C777',
    });
  });

  it('omits contextChannelId when the user is not viewing a channel', () => {
    const noContext: RawSlackEvent = {
      ...startedEvent,
      event: { ...startedEvent.event!, assistant_thread: { channel_id: 'D999', thread_ts: '1.1' } },
    };
    expect(assistantThreadStarted(noContext)).toEqual({ channelId: 'D999', threadTs: '1.1' });
  });

  it('returns null for non-assistant events (e.g. app_mention)', () => {
    expect(assistantThreadStarted(appMentionEvent())).toBeNull();
  });
});

describe('assistantThreadContextChanged', () => {
  const contextChangedEvent: RawSlackEvent = {
    type: 'event_callback',
    event_id: 'Ev200',
    team_id: 'T001',
    event: {
      type: 'assistant_thread_context_changed',
      ts: '1700000030.000001',
      channel: '',
      text: '',
      assistant_thread: {
        user_id: 'U001',
        channel_id: 'D999',
        thread_ts: '1700000020.000001',
        context: { channel_id: 'C888', team_id: 'T001' },
      },
    },
  };

  it('extracts the assistant channel, thread, and viewed-channel context', () => {
    expect(assistantThreadContextChanged(contextChangedEvent)).toEqual({
      channelId: 'D999',
      threadTs: '1700000020.000001',
      contextChannelId: 'C888',
    });
  });

  it('omits contextChannelId when there is no context channel', () => {
    const noContext: RawSlackEvent = {
      ...contextChangedEvent,
      event: {
        ...contextChangedEvent.event!,
        assistant_thread: { channel_id: 'D999', thread_ts: '1700000020.000001' },
      },
    };
    expect(assistantThreadContextChanged(noContext)).toEqual({
      channelId: 'D999',
      threadTs: '1700000020.000001',
    });
  });

  it('returns null for non-context-changed events (e.g. app_mention)', () => {
    expect(assistantThreadContextChanged(appMentionEvent())).toBeNull();
  });

  it('returns null for assistant_thread_started (different event type)', () => {
    const startedEvent: RawSlackEvent = {
      type: 'event_callback',
      event_id: 'Ev100',
      team_id: 'T001',
      event: {
        type: 'assistant_thread_started',
        ts: '1700000020.000001',
        channel: '',
        text: '',
        assistant_thread: {
          user_id: 'U001',
          channel_id: 'D999',
          thread_ts: '1700000020.000001',
          context: { channel_id: 'C777', team_id: 'T001' },
        },
      },
    };
    expect(assistantThreadContextChanged(startedEvent)).toBeNull();
  });
});
