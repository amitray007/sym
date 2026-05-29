import { describe, expect, it } from 'vitest';

import { applyRemovals, parseRemovals } from '../src/reply-cleanup.js';

describe('applyRemovals — non-lossy span deletion', () => {
  it('removes only exact verbatim fragments, preserving the rest', () => {
    const draft = "Now start p1.Start p2.Here's the answer: 3 messages.";
    expect(applyRemovals(draft, ['Now start p1.', 'Start p2.'])).toBe(
      "Here's the answer: 3 messages.",
    );
  });

  it('skips fragments not found verbatim (fails toward keeping content)', () => {
    const draft = 'Real answer with important details.';
    // Model hallucinated / mis-quoted fragments that are not in the draft.
    expect(applyRemovals(draft, ['Now reply.', 'planning step'])).toBe(
      'Real answer with important details.',
    );
  });

  it('never rewrites or paraphrases kept content', () => {
    const draft = 'Now get profile.\n\nPriya owns INC-204 (SEV-2). Link: https://x/1';
    expect(applyRemovals(draft, ['Now get profile.'])).toBe(
      'Priya owns INC-204 (SEV-2). Link: https://x/1',
    );
  });

  it('collapses blank-line runs left by a removal', () => {
    expect(applyRemovals('A.\n\nNow reply.\n\nB.', ['Now reply.'])).toBe('A.\n\nB.');
  });

  it('returns empty only when everything was a flagged fragment', () => {
    expect(applyRemovals('Now reply.', ['Now reply.'])).toBe('');
  });

  it('is a no-op when there are no fragments', () => {
    const draft = 'Untouched answer.';
    expect(applyRemovals(draft, [])).toBe(draft);
  });
});

describe('parseRemovals — tolerant JSON extraction', () => {
  it('parses a bare JSON object', () => {
    expect(parseRemovals('{"remove":["Now start p1.","Now reply."]}')).toEqual([
      'Now start p1.',
      'Now reply.',
    ]);
  });

  it('parses JSON wrapped in a fenced code block', () => {
    expect(parseRemovals('```json\n{"remove": ["Now reply."]}\n```')).toEqual(['Now reply.']);
  });

  it('returns [] for an empty remove list', () => {
    expect(parseRemovals('{"remove": []}')).toEqual([]);
  });

  it('returns [] on malformed / non-JSON output (fails safe)', () => {
    expect(parseRemovals('sorry, here are the fragments: a, b')).toEqual([]);
    expect(parseRemovals('{ not valid json ]')).toEqual([]);
  });

  it('drops non-string, blank, and too-short fragments (audit #16 safety)', () => {
    // '.', 'the', 'I', 'ok' are below the min length and must not be acted on
    // (they would strip real answer text). Full phrases pass.
    expect(
      parseRemovals('{"remove":["Now reply.", ".", "the", "I", "ok", 3, null, "Mark p1 done."]}'),
    ).toEqual(['Now reply.', 'Mark p1 done.']);
  });
});
