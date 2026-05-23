/**
 * Change-policy classifier tests.
 *
 * All tests use a fake `ProviderInterface` — no DB, no network.
 * The fake provider returns controlled JSON responses.
 */

import { describe, expect, it } from 'vitest';

import { classify } from './classifier.js';

import type { MemoryEntry, ProviderInterface, Turn } from '@sym/contracts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal Turn for testing. */
function makeTurn(text: string): Turn {
  return {
    id: 'turn-1' as Turn['id'],
    workspaceId: 'ws-1' as Turn['workspaceId'],
    conversationId: 'conv-1' as Turn['conversationId'],
    entrySurface: 'app_mention',
    requester: 'U_actor' as Turn['requester'],
    text,
    receivedAt: new Date(),
  };
}

/** Build a minimal MemoryEntry. */
function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: 'mem-1' as MemoryEntry['id'],
    workspaceId: 'ws-1' as MemoryEntry['workspaceId'],
    scope: 'dm',
    actorId: 'U_actor' as MemoryEntry['actorId'],
    content: 'User prefers dark mode',
    status: 'active',
    subjectConsentStatus: 'not_applicable',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/** Create a fake provider that returns the given JSON string. */
function fakeProvider(jsonResponse: string): ProviderInterface {
  return {
    id: 'fake',
    async *complete() {
      yield { delta: { content: jsonResponse } };
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('classify — pre-classifier heuristics', () => {
  it('ignores very short candidates with no signal on first mention', async () => {
    const turn = makeTurn('ok');
    const result = await classify(turn, 'ok', [], fakeProvider('{}'), 1);
    expect(result.decision).toBe('ignore');
  });

  it('does NOT pre-classify with explicit "remember" signal', async () => {
    // Even short candidate, explicit signal → provider is called
    const provider = fakeProvider(
      '{"decision":"add","reason":"explicit signal","existing_id":null}',
    );
    const turn = makeTurn('remember this: dark mode');
    const result = await classify(turn, 'dark mode', [], provider, 1);
    expect(result.decision).toBe('add');
  });

  it('does NOT pre-classify with repetitionCount >= 2', async () => {
    const provider = fakeProvider('{"decision":"add","reason":"repeated","existing_id":null}');
    const turn = makeTurn('dark mode');
    const result = await classify(turn, 'dark mode', [], provider, 2);
    expect(result.decision).toBe('add');
  });
});

describe('classify — add decisions', () => {
  it('returns add when model says add with no existing entries', async () => {
    const provider = fakeProvider(
      '{"decision":"add","reason":"new independent fact","existing_id":null}',
    );
    const turn = makeTurn('I always use TypeScript, never JavaScript');
    const result = await classify(turn, 'User always uses TypeScript', [], provider);
    expect(result.decision).toBe('add');
    expect(result.reason).toBe('new independent fact');
    expect(result.existingId).toBeUndefined();
  });

  it('handles preference statement ("I prefer") → add', async () => {
    const provider = fakeProvider(
      '{"decision":"add","reason":"preference statement","existing_id":null}',
    );
    const turn = makeTurn('I prefer tabs over spaces');
    const result = await classify(turn, 'User prefers tabs', [], provider);
    expect(result.decision).toBe('add');
  });

  it('handles "from now on" explicit signal → add', async () => {
    const provider = fakeProvider(
      '{"decision":"add","reason":"explicit directive","existing_id":null}',
    );
    const turn = makeTurn('from now on, always address me as Dr. Smith');
    const result = await classify(turn, 'User prefers to be called Dr. Smith', [], provider);
    expect(result.decision).toBe('add');
  });
});

describe('classify — update decisions', () => {
  it('returns update with existingId when model says update', async () => {
    const existing = makeEntry({ id: 'mem-42' as MemoryEntry['id'], content: 'prefers tabs' });
    const provider = fakeProvider(
      '{"decision":"update","reason":"sharpens existing preference","existing_id":"mem-42"}',
    );
    const turn = makeTurn('I prefer 4-space tabs');
    const result = await classify(turn, 'User prefers 4-space tabs', [existing], provider);
    expect(result.decision).toBe('update');
    expect(result.existingId).toBe('mem-42');
  });
});

describe('classify — supersede decisions', () => {
  it('returns supersede with existingId when fact contradicts', async () => {
    const existing = makeEntry({
      id: 'mem-99' as MemoryEntry['id'],
      content: 'User is in London',
    });
    const provider = fakeProvider(
      '{"decision":"supersede","reason":"contradicts previous location","existing_id":"mem-99"}',
    );
    const turn = makeTurn('I moved to Berlin last month');
    const result = await classify(turn, 'User is in Berlin', [existing], provider);
    expect(result.decision).toBe('supersede');
    expect(result.existingId).toBe('mem-99');
  });
});

describe('classify — ignore decisions', () => {
  it('returns ignore for casual chitchat', async () => {
    const provider = fakeProvider(
      '{"decision":"ignore","reason":"casual single mention","existing_id":null}',
    );
    const turn = makeTurn('haha yeah i like coffee sometimes');
    // repetitionCount=2 to bypass heuristic pre-filter, let model decide
    const result = await classify(turn, 'likes coffee', [], provider, 2);
    expect(result.decision).toBe('ignore');
  });

  it('returns ignore for Sym output quoted back', async () => {
    const provider = fakeProvider(
      '{"decision":"ignore","reason":"Sym own output repeated","existing_id":null}',
    );
    const turn = makeTurn('you said: "I will help you schedule the meeting"');
    const result = await classify(turn, 'will schedule meeting', [], provider, 2);
    expect(result.decision).toBe('ignore');
  });

  it('returns ignore for a short first-mention with no signal (heuristic)', async () => {
    // No provider call made — pre-classified as ignore
    const turn = makeTurn('ok');
    const result = await classify(turn, 'ok', [], fakeProvider('NEVER_CALLED'), 1);
    expect(result.decision).toBe('ignore');
  });
});

describe('classify — JSON parsing', () => {
  it('handles markdown-fenced JSON in provider output', async () => {
    const provider = fakeProvider(
      '```json\n{"decision":"add","reason":"fenced json","existing_id":null}\n```',
    );
    const turn = makeTurn('I prefer dark mode. Please remember this.');
    const result = await classify(turn, 'prefers dark mode', [], provider);
    expect(result.decision).toBe('add');
  });

  it('throws on invalid JSON from provider', async () => {
    const provider = fakeProvider('NOT JSON AT ALL');
    const turn = makeTurn('remember this: something important');
    await expect(classify(turn, 'something important', [], provider)).rejects.toThrow(
      'failed to parse provider output',
    );
  });

  it('throws on unknown decision value', async () => {
    const provider = fakeProvider('{"decision":"maybe","reason":"unsure","existing_id":null}');
    // "from now on" is a recognized explicit signal, so this bypasses the
    // casual fast-path and actually invokes the provider (whose bad decision
    // must surface as a throw).
    const turn = makeTurn('from now on use dark mode');
    await expect(classify(turn, 'use dark mode', [], provider)).rejects.toThrow(
      'unrecognized decision',
    );
  });
});

describe('classify — repetition threshold', () => {
  it('passes repetitionCount to the provider prompt', async () => {
    let capturedPrompt = '';
    const provider: ProviderInterface = {
      id: 'capture',
      async *complete(req) {
        // Capture the user message content
        const userMsg = req.messages.find((m) => m.role === 'user');
        capturedPrompt = userMsg?.content ?? '';
        yield {
          delta: { content: '{"decision":"add","reason":"repeated fact","existing_id":null}' },
        };
      },
    };
    const turn = makeTurn('I always use vim');
    await classify(turn, 'uses vim', [], provider, 3);
    expect(capturedPrompt).toContain('3');
  });
});
