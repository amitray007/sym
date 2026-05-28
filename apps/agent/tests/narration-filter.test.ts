/**
 * Tests for the line-buffered narration filter.
 *
 * Coverage: classification (drop vs keep), partial-delta boundary handling
 * (deltas arrive mid-word), end-of-stream tail emission, sentence-end vs
 * newline boundary preference, and conservative bias (clean text never
 * dropped, ambiguous mid-paragraph text passes through).
 */

import { describe, expect, it } from 'vitest';

import { NarrationFilter } from '../src/narration-filter.js';

/**
 * Helper — feed a single complete string and capture everything emitted
 * (push output + flush output). Mirrors how `streamReply` consumes the
 * filter when the whole reply arrives in one chunk (rare but tested).
 */
function feedAll(parts: readonly string[]): string {
  const f = new NarrationFilter();
  let out = '';
  for (const p of parts) out += f.push(p);
  out += f.flush();
  return out;
}

describe('NarrationFilter — drops narration', () => {
  it('drops "Marking p1 complete" line', () => {
    expect(feedAll(['Marking p1 complete.\n'])).toBe('');
  });

  it('drops "Now p2: in_progress" line', () => {
    // "Now p2" matches the plan-id leading pattern.
    expect(feedAll(['Now p2: in_progress\n'])).toBe('');
  });

  it('drops a line that names a tool verbatim', () => {
    expect(feedAll(['Calling search_messages for recent activity.\n'])).toBe('');
  });

  it('drops bare gerund + Slack-mechanics object at line start', () => {
    expect(feedAll(['Searching the channel for postgres mentions.\n'])).toBe('');
    expect(feedAll(['Reading the thread now.\n'])).toBe('');
  });

  it('drops "p1 done" forward narration', () => {
    expect(feedAll(['p1 done\n'])).toBe('');
  });

  it('drops bare status word at line start', () => {
    expect(feedAll(['complete.\n'])).toBe('');
    expect(feedAll(['blocked — waiting on input.\n'])).toBe('');
  });
});

describe('NarrationFilter — keeps clean text', () => {
  it('passes through a normal sentence', () => {
    const out = feedAll(['I found three messages from you yesterday.\n']);
    expect(out).toBe('I found three messages from you yesterday.\n');
  });

  it('keeps a multi-paragraph reply intact', () => {
    const input =
      "Here's what I found:\n\n- Alice asked about the migration\n- Bob proposed a rollback\n\nLet me know which direction.";
    const out = feedAll([input]);
    expect(out).toBe(input);
  });

  it('does NOT drop a sentence merely mentioning "complete" mid-paragraph', () => {
    // "I've got a complete picture" — "complete" is mid-sentence, not at line
    // start, so the bare-status-word regex does NOT fire.
    const text = "I've got a complete picture of the discussion now.\n";
    expect(feedAll([text])).toBe(text);
  });

  it('keeps text that mentions Slack the product (capitalized) when not narration-shaped', () => {
    const text = 'Your Slack notifications look healthy — no missed pings.\n';
    expect(feedAll([text])).toBe(text);
  });
});

describe('NarrationFilter — partial-delta boundaries', () => {
  it('reassembles a narration line split across many deltas and drops it', () => {
    // Worst case: each delta is 2–3 chars, sentence-end is in the last.
    const parts = ['Mar', 'kin', 'g p', '1 c', 'omp', 'lete', '.\n'];
    expect(feedAll(parts)).toBe('');
  });

  it('reassembles a clean line split across deltas and keeps it', () => {
    const parts = ['I fo', 'und thr', 'ee mes', 'sages.\n'];
    expect(feedAll(parts)).toBe('I found three messages.\n');
  });

  it('drops a narration line, then keeps following clean text', () => {
    const parts = ['Now p1: in_progress\n', 'Here is what I found: three messages.\n'];
    expect(feedAll(parts)).toBe('Here is what I found: three messages.\n');
  });
});

describe('NarrationFilter — end-of-stream tail', () => {
  it('emits the residual partial line on flush (no trailing newline)', () => {
    const f = new NarrationFilter();
    const a = f.push('Here is the answer'); // no terminator → nothing flushed yet
    const b = f.flush();
    expect(a).toBe('');
    expect(b).toBe('Here is the answer');
  });

  it('emits multi-line content with the last line lacking a terminator', () => {
    const f = new NarrationFilter();
    const a = f.push('Line one.\nLine two has no terminator');
    const b = f.flush();
    expect(a + b).toBe('Line one.\nLine two has no terminator');
  });

  it('flush is idempotent', () => {
    const f = new NarrationFilter();
    f.push('partial');
    expect(f.flush()).toBe('partial');
    expect(f.flush()).toBe('');
  });
});

describe('NarrationFilter — sentence-end boundary', () => {
  it('emits at sentence-end even without a newline', () => {
    // "I found three messages. " — the ". " is the sentence boundary, so
    // the first segment classifies and emits before any newline arrives.
    const f = new NarrationFilter();
    const a = f.push('I found three messages. ');
    expect(a).toBe('I found three messages. ');
  });

  it('classifies a narration sentence ending with "." before any newline', () => {
    // The pattern "marking p1 complete." should drop on sentence boundary.
    const f = new NarrationFilter();
    const a = f.push('Marking p1 complete. ');
    expect(a).toBe('');
  });
});

describe('NarrationFilter — empty / whitespace', () => {
  it('handles empty pushes', () => {
    const f = new NarrationFilter();
    expect(f.push('')).toBe('');
    expect(f.flush()).toBe('');
  });

  it('preserves blank lines (paragraph breaks)', () => {
    const out = feedAll(['First paragraph.\n', '\n', 'Second paragraph.\n']);
    expect(out).toBe('First paragraph.\n\nSecond paragraph.\n');
  });
});
