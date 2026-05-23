/**
 * Unit tests for the tone-rewrite stage.
 *
 * Uses a fake ProviderInterface — no live network calls, no env vars.
 */

import { describe, expect, it } from 'vitest';

import { L0_CONTENT_MD } from './l0.js';
import { applyTone } from './tone-rewrite.js';

import type {
  CompletionChunk,
  CompletionRequest,
  ProviderInterface,
  SoulCascade,
} from '@sym/contracts';

// ---------------------------------------------------------------------------
// Fake provider factory
// ---------------------------------------------------------------------------

function makeFakeProvider(response: string): ProviderInterface {
  return {
    id: 'fake',
    async *complete(_req: CompletionRequest): AsyncIterable<CompletionChunk> {
      yield { delta: { content: response } };
    },
  };
}

// ---------------------------------------------------------------------------
// Shared cascade fixture
// ---------------------------------------------------------------------------

const simpleCascade: SoulCascade = {
  layers: [{ kind: 'l0_global', contentMd: L0_CONTENT_MD }],
  effectiveMd: L0_CONTENT_MD,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('applyTone', () => {
  it('accepts a rewrite that preserves all factual claims', async () => {
    const draft = 'There are 5 open issues in the queue.';
    // Rewrite changes phrasing but keeps the number.
    const provider = makeFakeProvider('Currently, the queue contains 5 open issues.');

    const result = await applyTone(draft, simpleCascade, provider, 'fake-model');

    expect(result.accepted).toBe(true);
    expect(result.rewrittenMarkdown).toBe('Currently, the queue contains 5 open issues.');
  });

  it('rejects a rewrite that changes a number (fact change)', async () => {
    const draft = 'There are 5 open issues.';
    // Rewrite mutates the number — substance-diff guard must reject.
    const provider = makeFakeProvider('There are 6 open issues.');

    const result = await applyTone(draft, simpleCascade, provider, 'fake-model');

    expect(result.accepted).toBe(false);
    expect(result.rejectionReason).toBeTruthy();
  });

  it('trims whitespace from provider response', async () => {
    const draft = 'All tests passed.';
    const provider = makeFakeProvider('  All tests passed.  ');

    const result = await applyTone(draft, simpleCascade, provider, 'fake-model');

    expect(result.rewrittenMarkdown).toBe('All tests passed.');
  });

  it('assembles multi-chunk streaming responses', async () => {
    const draft = 'The deploy took 12 minutes.';
    const fakeProvider: ProviderInterface = {
      id: 'fake',
      async *complete(_req: CompletionRequest): AsyncIterable<CompletionChunk> {
        yield { delta: { content: 'The deploy' } };
        yield { delta: { content: ' took 12 minutes.' } };
      },
    };

    const result = await applyTone(draft, simpleCascade, fakeProvider, 'fake-model');

    expect(result.rewrittenMarkdown).toBe('The deploy took 12 minutes.');
    expect(result.accepted).toBe(true);
  });

  it('accepts identical text (no-op rewrite)', async () => {
    const draft = 'The server is running at port 3000.';
    const provider = makeFakeProvider(draft);

    const result = await applyTone(draft, simpleCascade, provider, 'fake-model');

    expect(result.accepted).toBe(true);
  });

  it('passes the effectiveMd from cascade into the system prompt', async () => {
    const draft = 'Hello.';
    let capturedRequest: CompletionRequest | undefined;

    const capturingProvider: ProviderInterface = {
      id: 'fake',
      async *complete(req: CompletionRequest): AsyncIterable<CompletionChunk> {
        capturedRequest = req;
        yield { delta: { content: 'Hello.' } };
      },
    };

    await applyTone(draft, simpleCascade, capturingProvider, 'fake-model');

    expect(capturedRequest).toBeDefined();
    const systemMsg = capturedRequest?.messages.find((m) => m.role === 'system');
    expect(systemMsg?.content).toContain(L0_CONTENT_MD);
  });

  it('passes the specified model to the provider', async () => {
    const draft = 'Done.';
    let capturedModel: string | undefined;

    const modelCapturingProvider: ProviderInterface = {
      id: 'fake',
      async *complete(req: CompletionRequest): AsyncIterable<CompletionChunk> {
        capturedModel = req.model;
        yield { delta: { content: 'Done.' } };
      },
    };

    await applyTone(
      draft,
      simpleCascade,
      modelCapturingProvider,
      'accounts/fireworks/models/llama-v3p1-8b-instruct',
    );

    expect(capturedModel).toBe('accounts/fireworks/models/llama-v3p1-8b-instruct');
  });
});
