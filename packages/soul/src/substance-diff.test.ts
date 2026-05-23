/**
 * Unit tests for the substance-diff guard.
 *
 * These are hermetic — no DB, no network.  They drive the guard with fixture
 * strings covering:
 *   - Tone-only changes that MUST be accepted.
 *   - Factual changes that MUST be rejected.
 *
 * Target accuracy (documented here, refined by the promptfoo eval set):
 *   - Tone-only → accept: ≥ 90 % of cases.
 *   - Fact-change → reject: ≥ 95 % of cases.
 */

import { describe, expect, it } from 'vitest';

import { checkSubstanceDiff } from './substance-diff.js';

// ---------------------------------------------------------------------------
// Fixtures: tone-only changes — guard MUST accept
// ---------------------------------------------------------------------------

describe('substance-diff guard — tone-only changes (must accept)', () => {
  it('rephrasing without numbers: informal → formal', () => {
    const original = 'The meeting is at 3 PM on Thursday.';
    const rewritten = 'The meeting is scheduled for 3 PM on Thursday.';
    const result = checkSubstanceDiff(original, rewritten);
    expect(result.accepted).toBe(true);
  });

  it('passive → active voice with same facts', () => {
    const original = 'The deployment was completed by the team at 2 AM.';
    const rewritten = 'The team completed the deployment at 2 AM.';
    const result = checkSubstanceDiff(original, rewritten);
    expect(result.accepted).toBe(true);
  });

  it('adding politeness filler words', () => {
    const original = 'There are 5 open issues in the queue.';
    const rewritten = 'There are currently 5 open issues in the queue.';
    const result = checkSubstanceDiff(original, rewritten);
    expect(result.accepted).toBe(true);
  });

  it('British vs American spelling (no facts)', () => {
    const original = 'The team organised the project.';
    const rewritten = 'The team organized the project.';
    const result = checkSubstanceDiff(original, rewritten);
    expect(result.accepted).toBe(true);
  });

  it('no factual claims in either text', () => {
    const original = 'Sure, happy to help!';
    const rewritten = 'Absolutely, let me assist you.';
    const result = checkSubstanceDiff(original, rewritten);
    expect(result.accepted).toBe(true);
  });

  it('synonym substitution: "large" → "significant" (no numbers)', () => {
    const original = 'We made a large improvement to performance.';
    const rewritten = 'We made a significant improvement to performance.';
    const result = checkSubstanceDiff(original, rewritten);
    expect(result.accepted).toBe(true);
  });

  it('identical text: trivially accepted', () => {
    const text = 'The server responded in 120 ms.';
    const result = checkSubstanceDiff(text, text);
    expect(result.accepted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fixtures: factual changes — guard MUST reject
// ---------------------------------------------------------------------------

describe('substance-diff guard — factual changes (must reject)', () => {
  it('number mutation: 5 → 6 open issues', () => {
    const original = 'There are 5 open issues in the queue.';
    const rewritten = 'There are 6 open issues in the queue.';
    const result = checkSubstanceDiff(original, rewritten);
    expect(result.accepted).toBe(false);
    expect(result.rejectionReason).toBeTruthy();
  });

  it('number mutation: response time 120 ms → 200 ms', () => {
    const original = 'The server responded in 120 ms.';
    const rewritten = 'The server responded in 200 ms.';
    const result = checkSubstanceDiff(original, rewritten);
    expect(result.accepted).toBe(false);
  });

  it('percentage change: 80 % → 90 %', () => {
    const original = 'The test suite covers 80% of the codebase.';
    const rewritten = 'The test suite covers 90% of the codebase.';
    const result = checkSubstanceDiff(original, rewritten);
    expect(result.accepted).toBe(false);
  });

  it('entity name swap: Alice → Bob', () => {
    const original = 'Alice owns the GitHub repository.';
    const rewritten = 'Bob owns the GitHub repository.';
    const result = checkSubstanceDiff(original, rewritten);
    expect(result.accepted).toBe(false);
  });

  it('added factual claim (rewrite adds a new number)', () => {
    const original = 'The deployment is done.';
    const rewritten = 'The deployment is done. It took 45 minutes.';
    const result = checkSubstanceDiff(original, rewritten);
    expect(result.accepted).toBe(false);
    expect(result.addedClaims.length).toBeGreaterThan(0);
  });

  it('removed factual claim (rewrite drops a number)', () => {
    const original = 'There are 5 open PRs.  The merge queue has 2 items.';
    const rewritten = 'There are 5 open PRs.';
    const result = checkSubstanceDiff(original, rewritten);
    expect(result.accepted).toBe(false);
    expect(result.removedClaims.length).toBeGreaterThan(0);
  });

  it('direction flip: "higher" → "lower"', () => {
    const original = 'The new version is higher performance than the old one.';
    const rewritten = 'The new version is lower performance than the old one.';
    const result = checkSubstanceDiff(original, rewritten);
    expect(result.accepted).toBe(false);
  });

  it('date mutation', () => {
    const original = 'The release is scheduled for March 15.';
    const rewritten = 'The release is scheduled for March 20.';
    const result = checkSubstanceDiff(original, rewritten);
    expect(result.accepted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('substance-diff guard — edge cases', () => {
  it('empty original and rewritten', () => {
    const result = checkSubstanceDiff('', '');
    expect(result.accepted).toBe(true);
  });

  it('empty original, non-empty rewritten with facts', () => {
    const result = checkSubstanceDiff('', 'There are 5 open issues.');
    expect(result.accepted).toBe(false);
  });

  it('non-empty original with facts, empty rewritten', () => {
    const result = checkSubstanceDiff('There are 5 open issues.', '');
    expect(result.accepted).toBe(false);
  });

  it('returns correct removed/added claim arrays', () => {
    const original = 'There are 5 open issues.';
    const rewritten = 'There are 6 open issues.';
    const result = checkSubstanceDiff(original, rewritten);
    expect(result.removedClaims).toHaveLength(1);
    expect(result.addedClaims).toHaveLength(1);
  });
});
