import { describe, expect, it } from 'vitest';

import { normalizeSlackEvent, slackTurnInputToTurn, type RawSlackEvent } from '../normalize.js';

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
    expect(typeof turn.id).toBe('string');
    expect(turn.id.length).toBeGreaterThan(0);
    expect(turn.receivedAt).toBeInstanceOf(Date);
  });
});
