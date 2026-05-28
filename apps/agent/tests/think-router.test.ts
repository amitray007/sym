/**
 * Unit tests for the per-turn thinking-level router.
 *
 * The router is a pure function — these tests pin the heuristic boundaries so
 * tuning the constants surfaces deliberately, not by accident.
 */

import { describe, expect, it } from 'vitest';

import { pickThinkingLevel } from '../src/pi/think-router.js';

describe('pickThinkingLevel', () => {
  // -------------------------------------------------------------------------
  // Trivial branch — short, single-clause, ≤1 question → 'low' floor.
  // -------------------------------------------------------------------------

  it('routes a short greeting to low', () => {
    expect(pickThinkingLevel({ text: 'hey', threadDepth: 0 })).toBe('low');
  });

  it('routes a short single-question ask to low', () => {
    expect(pickThinkingLevel({ text: 'what time is it?', threadDepth: 0 })).toBe('low');
  });

  it('routes a one-clause statement under the length limit to low', () => {
    expect(pickThinkingLevel({ text: 'remind me at 5pm', threadDepth: 2 })).toBe('low');
  });

  // -------------------------------------------------------------------------
  // Medium branch — explicit deliberation cue.
  // -------------------------------------------------------------------------

  it('promotes to medium when the message uses a deliberation verb', () => {
    expect(
      pickThinkingLevel({
        text: 'help me figure out why the deploy failed',
        threadDepth: 0,
      }),
    ).toBe('medium');
  });

  it('promotes to medium for "investigate"', () => {
    expect(pickThinkingLevel({ text: 'investigate this stack trace', threadDepth: 0 })).toBe(
      'medium',
    );
  });

  it('promotes to medium for "root cause"', () => {
    expect(pickThinkingLevel({ text: 'find the root cause of the leak', threadDepth: 0 })).toBe(
      'medium',
    );
  });

  // -------------------------------------------------------------------------
  // Medium branch — three+ clause connectives (multi-step asks).
  // -------------------------------------------------------------------------

  it('promotes to medium when the message strings 3+ clauses', () => {
    expect(
      pickThinkingLevel({
        text: 'find the incident and summarize what we learned, then ping the team after',
        threadDepth: 0,
      }),
    ).toBe('medium');
  });

  it('stays at low for a 2-clause ask (one connective)', () => {
    expect(pickThinkingLevel({ text: 'send the report and pin it', threadDepth: 0 })).toBe('low');
  });

  // -------------------------------------------------------------------------
  // Medium branch — deep thread context.
  // -------------------------------------------------------------------------

  it('promotes to medium when the thread is deep (>10 prior turns)', () => {
    expect(pickThinkingLevel({ text: 'and now?', threadDepth: 12 })).toBe('medium');
  });

  it('stays at low at the thread-depth boundary (10)', () => {
    expect(pickThinkingLevel({ text: 'and now?', threadDepth: 10 })).toBe('low');
  });

  // -------------------------------------------------------------------------
  // Default branch — moderate complexity, no triggers.
  // -------------------------------------------------------------------------

  it('routes a moderate question without triggers to low', () => {
    expect(
      pickThinkingLevel({
        text: 'what was the takeaway from the last retro meeting we held?',
        threadDepth: 0,
      }),
    ).toBe('low');
  });

  // -------------------------------------------------------------------------
  // Edge cases.
  // -------------------------------------------------------------------------

  it('handles empty text without throwing', () => {
    expect(pickThinkingLevel({ text: '', threadDepth: 0 })).toBe('low');
  });

  it('handles whitespace-only text as trivial', () => {
    expect(pickThinkingLevel({ text: '     ', threadDepth: 0 })).toBe('low');
  });

  it('is case-insensitive on deliberation verbs', () => {
    expect(pickThinkingLevel({ text: 'ANALYZE the dependency graph', threadDepth: 0 })).toBe(
      'medium',
    );
  });

  it('is case-insensitive on clause connectives', () => {
    // Three connectives (AND/THEN/AFTER) crosses MEDIUM_CLAUSE_THRESHOLD;
    // the uppercase form proves the regex `i` flag is honored.
    expect(
      pickThinkingLevel({
        text: 'pull the data AND aggregate it THEN send a digest AFTER lunch',
        threadDepth: 0,
      }),
    ).toBe('medium');
  });
});
