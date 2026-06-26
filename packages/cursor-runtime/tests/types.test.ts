import { describe, expect, it } from 'vitest';

import {
  cloudDispatchInputSchema,
  cloudRunStatusSchema,
  repoAllowlistSchema,
} from '../src/types.js';

describe('cloudDispatchInputSchema', () => {
  it('parses valid input', () => {
    expect(cloudDispatchInputSchema.parse({ repoQuery: 'r', task: 'do x' })).toEqual({
      repoQuery: 'r',
      task: 'do x',
    });
  });

  it('keeps startingRef when provided', () => {
    const parsed = cloudDispatchInputSchema.parse({
      repoQuery: 'r',
      task: 't',
      startingRef: 'dev',
    });
    expect(parsed.startingRef).toBe('dev');
  });

  it('rejects an empty task', () => {
    expect(() => cloudDispatchInputSchema.parse({ repoQuery: 'r', task: '' })).toThrow();
  });

  it('rejects a whitespace-only task', () => {
    expect(() => cloudDispatchInputSchema.parse({ repoQuery: 'r', task: '   ' })).toThrow();
  });

  it('rejects missing repoQuery', () => {
    expect(() => cloudDispatchInputSchema.parse({ task: 't' })).toThrow();
  });
});

describe('cloudRunStatusSchema', () => {
  it('accepts every lifecycle state including dispatching and cancelled', () => {
    for (const status of ['dispatching', 'running', 'finished', 'error', 'cancelled'] as const) {
      expect(cloudRunStatusSchema.parse(status)).toBe(status);
    }
  });

  it('rejects an unknown status', () => {
    expect(() => cloudRunStatusSchema.parse('paused')).toThrow();
  });
});

describe('repoAllowlistSchema', () => {
  it('parses valid entries', () => {
    expect(repoAllowlistSchema.parse([{ name: 'r', url: 'https://github.com/o/r' }])).toHaveLength(
      1,
    );
  });

  it('rejects an invalid url', () => {
    expect(() => repoAllowlistSchema.parse([{ name: 'r', url: 'not-a-url' }])).toThrow();
  });
});
