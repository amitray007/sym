import { describe, expect, it, vi } from 'vitest';

import { handleAssistantThreadStarted } from '../src/assistant.js';

import type {
  AssistantThreadStarted,
  SetSuggestedPromptsParams,
  SetTitleParams,
  SlackClient,
} from '@sym/adapter-slack';
import type { SlackChannelId, SlackThreadTs } from '@sym/contracts';

const THREAD: AssistantThreadStarted = {
  channelId: 'D999' as SlackChannelId,
  threadTs: '1700000020.000001' as SlackThreadTs,
};

interface MockSlackClient {
  setTitleCalls: SetTitleParams[];
  setSuggestedPromptsCalls: SetSuggestedPromptsParams[];
  client: SlackClient;
}

function makeMock(opts?: { failTitle?: boolean; failPrompts?: boolean }): MockSlackClient {
  const setTitleCalls: SetTitleParams[] = [];
  const setSuggestedPromptsCalls: SetSuggestedPromptsParams[] = [];
  const client = {
    assistantThreadsSetTitle: async (p: SetTitleParams) => {
      setTitleCalls.push(p);
      if (opts?.failTitle) throw new Error('title_failed');
    },
    assistantThreadsSetSuggestedPrompts: async (p: SetSuggestedPromptsParams) => {
      setSuggestedPromptsCalls.push(p);
      if (opts?.failPrompts) throw new Error('prompts_failed');
    },
  } as unknown as SlackClient;
  return { setTitleCalls, setSuggestedPromptsCalls, client };
}

describe('handleAssistantThreadStarted', () => {
  it('sets both title and suggested prompts on the opened assistant thread', async () => {
    const mock = makeMock();

    await handleAssistantThreadStarted(mock.client, THREAD);

    expect(mock.setTitleCalls).toHaveLength(1);
    expect(mock.setTitleCalls[0]?.channelId).toBe('D999');
    expect(mock.setTitleCalls[0]?.threadTs).toBe('1700000020.000001');
    expect(mock.setTitleCalls[0]?.title).toBe('New chat with Sym');

    expect(mock.setSuggestedPromptsCalls).toHaveLength(1);
    expect(mock.setSuggestedPromptsCalls[0]?.channelId).toBe('D999');
    expect(mock.setSuggestedPromptsCalls[0]?.threadTs).toBe('1700000020.000001');
    const prompts = mock.setSuggestedPromptsCalls[0]?.prompts ?? [];
    expect(prompts).toHaveLength(4);
    expect(prompts.every((p) => p.title && p.message)).toBe(true);
  });

  it('still sets suggested prompts when setTitle throws', async () => {
    const mock = makeMock({ failTitle: true });

    await expect(handleAssistantThreadStarted(mock.client, THREAD)).resolves.toBeUndefined();

    expect(mock.setTitleCalls).toHaveLength(1);
    expect(mock.setSuggestedPromptsCalls).toHaveLength(1);
  });

  it('swallows setSuggestedPrompts errors so the event ACK is never blocked', async () => {
    const slack = {
      assistantThreadsSetTitle: vi.fn().mockResolvedValue(undefined),
      assistantThreadsSetSuggestedPrompts: vi.fn().mockRejectedValue(new Error('missing_scope')),
    } as unknown as SlackClient;

    await expect(handleAssistantThreadStarted(slack, THREAD)).resolves.toBeUndefined();
  });
});
