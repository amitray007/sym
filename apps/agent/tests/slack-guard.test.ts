/**
 * Tests for the Slack-read relevance guard.
 *
 * `parseVerdict` is pure and fails open to `allow`. `judgeSlackToolUse` is
 * exercised against a mocked pi Agent so we cover verdict mapping and the
 * fail-open path without any network/model.
 */

import { describe, expect, it, vi } from 'vitest';

// Drive the mocked Agent's emitted text via a module-level handle.
let nextResponse = '';
let shouldThrow = false;

vi.mock('@earendil-works/pi-agent-core', () => {
  type Subscriber = (event: unknown) => void;
  class FakeAgent {
    #subs: Subscriber[] = [];
    subscribe(fn: Subscriber): void {
      this.#subs.push(fn);
    }
    async prompt(_text: string): Promise<void> {
      if (shouldThrow) throw new Error('model unavailable');
      for (const fn of this.#subs) {
        fn({
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: nextResponse },
        });
      }
    }
    abort(): void {
      /* no-op */
    }
  }
  return { Agent: FakeAgent };
});

// model.ts pulls in heavy deps; stub the builder to a trivial object.
vi.mock('../src/pi/model.js', () => ({
  buildFireworksModel: () => ({ id: 'fake', api: 'anthropic-messages' }),
}));

import { judgeSlackToolUse, parseVerdict, SLACK_GUARD_TOOLS } from '../src/slack-guard.js';

const DEPS = {
  fireworks: { baseUrl: 'http://fake', apiKey: 'fake' },
  model: 'fake-model',
  visibility: 'shared' as const,
};

describe('parseVerdict', () => {
  it('maps the three recognized words', () => {
    expect(parseVerdict('ALLOW')).toBe('allow');
    expect(parseVerdict('REDIRECT')).toBe('redirect');
    expect(parseVerdict('CONFIRM')).toBe('confirm');
  });

  it('is case-insensitive and tolerates surrounding prose', () => {
    expect(parseVerdict('redirect')).toBe('redirect');
    expect(parseVerdict('The verdict is: CONFIRM.')).toBe('confirm');
    expect(parseVerdict('I think this should be allow here')).toBe('allow');
  });

  it('fails open to allow on unrecognized / empty output', () => {
    expect(parseVerdict('')).toBe('allow');
    expect(parseVerdict('hmm not sure')).toBe('allow');
    expect(parseVerdict('REDIRECTED elsewhere')).toBe('allow'); // no whole-word match
  });
});

describe('SLACK_GUARD_TOOLS', () => {
  it('covers the broad-reach Slack reads, not contextual ones', () => {
    expect(SLACK_GUARD_TOOLS.has('search_messages')).toBe(true);
    expect(SLACK_GUARD_TOOLS.has('list_channels')).toBe(true);
    expect(SLACK_GUARD_TOOLS.has('read_user_profile')).toBe(true);
    // read_channel/read_thread are about the current conversation — not guarded.
    expect(SLACK_GUARD_TOOLS.has('read_channel')).toBe(false);
    expect(SLACK_GUARD_TOOLS.has('read_thread')).toBe(false);
  });
});

describe('judgeSlackToolUse', () => {
  it('returns the model verdict for an external-system task', async () => {
    nextResponse = 'REDIRECT';
    shouldThrow = false;
    expect(await judgeSlackToolUse('raise a PR in the shopify repo', DEPS)).toBe('redirect');
  });

  it('allows a genuine Slack-recap request', async () => {
    nextResponse = 'ALLOW';
    shouldThrow = false;
    expect(await judgeSlackToolUse('what did I miss in #general today', DEPS)).toBe('allow');
  });

  it('asks for confirmation when flagged', async () => {
    nextResponse = 'CONFIRM';
    shouldThrow = false;
    expect(await judgeSlackToolUse('summarize my DMs here', DEPS)).toBe('confirm');
  });

  it('fails open to allow on an empty user message (no LLM call)', async () => {
    nextResponse = 'REDIRECT';
    shouldThrow = false;
    expect(await judgeSlackToolUse('   ', DEPS)).toBe('allow');
  });

  it('fails open to allow when the model throws', async () => {
    nextResponse = 'REDIRECT';
    shouldThrow = true;
    expect(await judgeSlackToolUse('raise a PR', DEPS)).toBe('allow');
  });
});
