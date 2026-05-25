import { describe, expect, it } from 'vitest';

import { createBuiltinDispatcher } from './builtin-tools.js';

import type {
  ConversationId,
  SlackChannelId,
  SlackUserId,
  ToolCall,
  ToolRuntimeContext,
  TurnId,
  WorkspaceId,
} from '@sym/contracts';

function makeCtx(): ToolRuntimeContext {
  return {
    workspaceId: 'ws_01' as WorkspaceId,
    conversationId: 'ws_01:C1' as ConversationId,
    channelId: 'C1' as SlackChannelId,
    requester: 'U_alice' as SlackUserId,
    turnId: 'turn_01' as TurnId,
  };
}

function makeCall(name: string, id = 'call_01'): ToolCall {
  return { id, name, arguments: {} };
}

describe('createBuiltinDispatcher', () => {
  describe('list()', () => {
    it('returns exactly one descriptor: get_current_time', () => {
      const dispatcher = createBuiltinDispatcher();
      const tools = dispatcher.list();
      expect(tools).toHaveLength(1);
      expect(tools[0]?.name).toBe('get_current_time');
    });

    it('get_current_time descriptor has readOnlyHint: true', () => {
      const dispatcher = createBuiltinDispatcher();
      const tool = dispatcher.list()[0]!;
      expect(tool.readOnlyHint).toBe(true);
    });

    it('get_current_time descriptor has type: function', () => {
      const dispatcher = createBuiltinDispatcher();
      const tool = dispatcher.list()[0]!;
      expect(tool.type).toBe('function');
    });
  });

  describe('dispatch()', () => {
    it('returns an ISO 8601 string for get_current_time', async () => {
      const dispatcher = createBuiltinDispatcher();
      const result = await dispatcher.dispatch(makeCall('get_current_time'), makeCtx());

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');
      expect(typeof result.content).toBe('string');
      // Must be a valid ISO 8601 date string.
      expect(() => new Date(result.content as string)).not.toThrow();
      expect(new Date(result.content as string).toISOString()).toBe(result.content);
    });

    it('returns callId matching the call id', async () => {
      const dispatcher = createBuiltinDispatcher();
      const result = await dispatcher.dispatch(makeCall('get_current_time', 'my-id'), makeCtx());
      expect(result.callId).toBe('my-id');
    });

    it('returns not_found for an unknown tool', async () => {
      const dispatcher = createBuiltinDispatcher();
      const result = await dispatcher.dispatch(makeCall('unknown_tool'), makeCtx());

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      expect(result.error.code).toBe('not_found');
      expect(result.error.message).toContain('unknown_tool');
    });
  });
});
