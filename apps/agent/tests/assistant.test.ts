import { describe, expect, it, vi } from 'vitest';

import { handleAssistantThreadStarted } from '../src/assistant.js';

import type {
  AssistantThreadStarted,
  SetSuggestedPromptsParams,
  SlackClient,
} from '@sym/adapter-slack';
import type { SlackChannelId, SlackThreadTs } from '@sym/contracts';

const THREAD: AssistantThreadStarted = {
  channelId: 'D999' as SlackChannelId,
  threadTs: '1700000020.000001' as SlackThreadTs,
};

describe('handleAssistantThreadStarted', () => {
  it('sets suggested prompts on the opened assistant thread', async () => {
    const calls: SetSuggestedPromptsParams[] = [];
    const slack = {
      assistantThreadsSetSuggestedPrompts: async (p: SetSuggestedPromptsParams) => {
        calls.push(p);
      },
    } as unknown as SlackClient;

    await handleAssistantThreadStarted(slack, THREAD);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.channelId).toBe('D999');
    expect(calls[0]?.threadTs).toBe('1700000020.000001');
    expect(calls[0]?.prompts.length).toBeGreaterThan(0);
    expect(calls[0]?.prompts.every((p) => p.title && p.message)).toBe(true);
  });

  it('swallows API errors so the event ACK is never blocked', async () => {
    const slack = {
      assistantThreadsSetSuggestedPrompts: vi.fn().mockRejectedValue(new Error('missing_scope')),
    } as unknown as SlackClient;

    await expect(handleAssistantThreadStarted(slack, THREAD)).resolves.toBeUndefined();
  });
});
