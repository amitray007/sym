import { describe, expect, it, vi } from 'vitest';

import { handleAssistantThreadStarted } from '../src/assistant.js';

import type {
  AssistantThreadStarted,
  PostMessageParams,
  PostMessageResult,
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
  postMessageCalls: PostMessageParams[];
  client: SlackClient;
}

function makeMock(opts?: {
  failTitle?: boolean;
  failPrompts?: boolean;
  failWelcome?: boolean;
}): MockSlackClient {
  const setTitleCalls: SetTitleParams[] = [];
  const setSuggestedPromptsCalls: SetSuggestedPromptsParams[] = [];
  const postMessageCalls: PostMessageParams[] = [];
  const client = {
    assistantThreadsSetTitle: async (p: SetTitleParams) => {
      setTitleCalls.push(p);
      if (opts?.failTitle) throw new Error('title_failed');
    },
    assistantThreadsSetSuggestedPrompts: async (p: SetSuggestedPromptsParams) => {
      setSuggestedPromptsCalls.push(p);
      if (opts?.failPrompts) throw new Error('prompts_failed');
    },
    chatPostMessage: async (p: PostMessageParams): Promise<PostMessageResult> => {
      postMessageCalls.push(p);
      if (opts?.failWelcome) throw new Error('welcome_failed');
      return { ts: '111.222' as SlackThreadTs, channel: p.channel };
    },
  } as unknown as SlackClient;
  return { setTitleCalls, setSuggestedPromptsCalls, postMessageCalls, client };
}

describe('handleAssistantThreadStarted', () => {
  it('sets title, suggested prompts, AND posts a welcome message on the opened assistant thread', async () => {
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
    // Prompts are sourced from slack/manifest.template.yml — keep assertion
    // loose (count + shape) so changes to that file don't churn the test.
    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts.every((p) => p.title && p.message)).toBe(true);

    // Welcome message lands in the same assistant thread.
    expect(mock.postMessageCalls).toHaveLength(1);
    expect(mock.postMessageCalls[0]?.channel).toBe('D999');
    expect(mock.postMessageCalls[0]?.thread_ts).toBe('1700000020.000001');
    expect(mock.postMessageCalls[0]?.text).toMatch(/Sym/);
  });

  it('still sets suggested prompts and welcome when setTitle throws', async () => {
    const mock = makeMock({ failTitle: true });

    await expect(handleAssistantThreadStarted(mock.client, THREAD)).resolves.toBeUndefined();

    expect(mock.setTitleCalls).toHaveLength(1);
    expect(mock.setSuggestedPromptsCalls).toHaveLength(1);
    expect(mock.postMessageCalls).toHaveLength(1);
  });

  it('swallows setSuggestedPrompts errors so the event ACK is never blocked', async () => {
    const slack = {
      assistantThreadsSetTitle: vi.fn().mockResolvedValue(undefined),
      assistantThreadsSetSuggestedPrompts: vi.fn().mockRejectedValue(new Error('missing_scope')),
      chatPostMessage: vi.fn().mockResolvedValue({ ts: '1.1', channel: 'D999' }),
    } as unknown as SlackClient;

    await expect(handleAssistantThreadStarted(slack, THREAD)).resolves.toBeUndefined();
  });

  it('swallows welcome-post errors so the event ACK is never blocked', async () => {
    const mock = makeMock({ failWelcome: true });

    await expect(handleAssistantThreadStarted(mock.client, THREAD)).resolves.toBeUndefined();

    expect(mock.setTitleCalls).toHaveLength(1);
    expect(mock.setSuggestedPromptsCalls).toHaveLength(1);
    expect(mock.postMessageCalls).toHaveLength(1);
  });
});
