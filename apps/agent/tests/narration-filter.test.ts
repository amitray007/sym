/**
 * Tests for the line-buffered narration filter.
 *
 * Coverage: classification (drop vs keep), partial-delta boundary handling
 * (deltas arrive mid-word), end-of-stream tail emission, sentence-end vs
 * newline boundary preference, and conservative bias (clean text never
 * dropped, ambiguous mid-paragraph text passes through).
 */

import { describe, expect, it } from 'vitest';

import { NarrationFilter, stripNarration } from '../src/narration-filter.js';

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

describe('NarrationFilter — patterns added 2026-05-29 (dogfood gaps)', () => {
  // The model emits self-instruction sentences observed in dogfooding:
  // "Now fetch profile.", "Search again broader.", "Need to include those."
  // These are model-talks-to-itself and should be dropped from the reply.

  it('drops "Now fetch profile." (model self-instruction)', () => {
    expect(feedAll(['Now fetch profile.\n'])).toBe('');
  });

  it('drops "Search again broader." (meta-narration about retrieval)', () => {
    expect(feedAll(['Search again broader.\n'])).toBe('');
  });

  it('drops "Need to include those." (internal reasoning out loud)', () => {
    expect(feedAll(['Need to include those.\n'])).toBe('');
  });

  it('drops "Let me check the docs." (model planning aloud)', () => {
    expect(feedAll(['Let me check the docs.\n'])).toBe('');
  });

  it('keeps "Let me know if you need anything else." (real reply phrasing)', () => {
    // Tight verb gating so "Let me know if…" stays through despite the
    // "Let me…" prefix. This is the false-drop guard.
    expect(feedAll(['Let me know if you need anything else.\n'])).toBe(
      'Let me know if you need anything else.\n',
    );
  });

  it('keeps "Now I have the answer." (not a self-instruction)', () => {
    // The "Now X" pattern only matches imperative verbs (fetch/search/read).
    // Sentences like "Now I…" should pass through.
    expect(feedAll(['Now I have the answer.\n'])).toBe('Now I have the answer.\n');
  });
});

describe('NarrationFilter — glued-sentence boundary (no-space after period)', () => {
  // Some checkpoints emit consecutive sentences without spaces:
  // "broader.We have some pricing mentions". Without a capital-letter
  // lookahead, findSegmentEnd misses the boundary and the whole stretch
  // arrives as one segment that slips past classification.

  it('splits "broader.We" so the narration is dropped and content kept', () => {
    // First sentence is narration (Search again broader.), second is content.
    const f = new NarrationFilter();
    const out = f.push('Search again broader.We have some pricing mentions.\n');
    expect(out).toBe('We have some pricing mentions.\n');
  });

  it('drops a sentence ending without space when the next sentence starts capital', () => {
    expect(feedAll(['Now fetch profile.Amit said hello.\n'])).toBe('Amit said hello.\n');
  });

  it('does not over-split on intra-word periods (e.g., URLs, abbreviations)', () => {
    // "i.e." / "etc." / lowercase-letter follow-ups should not trigger.
    expect(feedAll(['e.g. this is fine.\n'])).toBe('e.g. this is fine.\n');
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

describe('NarrationFilter — preamble patterns (2026-05-30 dogfood)', () => {
  it.each([
    'Now start p1.\n',
    'Start p2.\n',
    'Start p3.\n',
    'Now get profile.\n',
    'Now reply.\n',
    'Now summarize the thread.\n',
    'Search messages in #test-stuff today.\n',
    'Summarize: many duplicate requests.\n',
    "We'll craft the summary.\n",
    "I'll compose the reply.\n",
  ])('drops narration: %j', (line) => {
    expect(feedAll([line])).toBe('');
  });

  it.each([
    "I'll set that reminder for 5pm.\n",
    'Now you can see the full list.\n',
    'Now I have what I need to answer.\n',
    'Read the docs I linked for the full API.\n',
    "Let's keep the launch on Thursday.\n",
  ])('keeps real reply text: %j', (line) => {
    expect(feedAll([line])).toBe(line);
  });
});

describe('stripNarration — full-text plan preamble (2026-05-30 dogfood)', () => {
  const leaked =
    'Now start p1.Start p2.Search messages in #test-stuff today from owner.' +
    'Summarize: many duplicate requests, no other content. So today only these messages. ' +
    "We'll craft summary.\n\nNow get profile.Start p3.Now reply." +
    "Here's the current time (UTC and Asia/Kolkata), a recap of today's activity, and your profile.";

  it('drops the planning preamble and keeps the real answer', () => {
    const out = stripNarration(leaked);
    expect(out).toContain("Here's the current time");
    for (const frag of [
      'Now start p1',
      'Start p2',
      'Search messages in',
      'Summarize:',
      "We'll craft summary",
      'Now get profile',
      'Start p3',
      'Now reply',
    ]) {
      expect(out).not.toContain(frag);
    }
  });

  it('leaves a clean reply untouched', () => {
    const clean =
      "Here's the recap: three people pinged you about the launch. I'll set the reminder for 5pm.";
    expect(stripNarration(clean)).toBe(clean);
  });

  it('returns empty when the whole text is narration (caller falls back)', () => {
    expect(stripNarration('Now start p1.\nStart p2.\nNow reply.\n').trim()).toBe('');
  });
});
