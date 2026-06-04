/**
 * Tests for retry.ts — withSlackRetries + mapSlackError behavior.
 *
 * mapSlackError is NOT exported, so it is tested indirectly through the
 * thrown error's `.code` property (the SlackActionError shape).
 *
 * Pins:
 *   - success on first try (no retries needed)
 *   - retry after too_many_requests (rate limit) and succeed on 2nd attempt
 *   - exhaust retries after maxRetries too_many_requests → throws with code rate_limited
 *   - idempotent-success cases: already_reacted and no_reaction → resolve without throw
 *   - non-rate-limit Slack errors → map to correct SlackActionError code immediately
 *   - non-Slack errors propagate as-is (no wrapping)
 */

import { describe, expect, it, vi } from 'vitest';

import { SlackWebApiError, withSlackRetries } from '../src/retry.js';

import type { SlackActionError } from '@sym/contracts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a SlackWebApiError that simulates a Slack API response error. */
function makeSlackError(errorString: string, opts: { retryAfter?: number } = {}): SlackWebApiError {
  return new SlackWebApiError(errorString, {
    error: errorString,
    ...(opts.retryAfter !== undefined ? { retry_after: opts.retryAfter } : {}),
  });
}

/** Assert the error is a SlackActionError with the given code. */
function assertSlackActionError(err: unknown, expectedCode: SlackActionError['code']): void {
  expect(err).toBeInstanceOf(Error);
  const e = err as SlackActionError;
  expect(e.domain).toBe('slack');
  expect(e.code).toBe(expectedCode);
}

// ---------------------------------------------------------------------------
// Success path
// ---------------------------------------------------------------------------

describe('withSlackRetries — success path', () => {
  it('returns the value immediately when the fn succeeds on the first call', async () => {
    let callCount = 0;
    const result = await withSlackRetries(() => {
      callCount++;
      return Promise.resolve('ok');
    });
    expect(result).toBe('ok');
    expect(callCount).toBe(1);
  });

  it('returns a resolved value (no error thrown)', async () => {
    const value = { data: 'test', ts: '123.456' };
    const result = await withSlackRetries(() => Promise.resolve(value));
    expect(result).toEqual(value);
  });
});

// ---------------------------------------------------------------------------
// Rate-limit retry
// ---------------------------------------------------------------------------

describe('withSlackRetries — too_many_requests retry', () => {
  it('retries after a too_many_requests error and succeeds on the 2nd attempt', async () => {
    let callCount = 0;
    vi.useFakeTimers();
    try {
      const resultPromise = withSlackRetries(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.reject(makeSlackError('too_many_requests', { retryAfter: 0 }));
        }
        return Promise.resolve('success-after-retry');
      }, 3);
      // Advance all timers to skip the sleep
      await vi.runAllTimersAsync();
      const result = await resultPromise;
      expect(result).toBe('success-after-retry');
      expect(callCount).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  }, 5000);

  it('retries after a ratelimited error and succeeds on 2nd attempt', async () => {
    let callCount = 0;
    vi.useFakeTimers();
    try {
      const resultPromise = withSlackRetries(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.reject(makeSlackError('ratelimited', { retryAfter: 0 }));
        }
        return Promise.resolve('retry-worked');
      }, 3);
      await vi.runAllTimersAsync();
      const result = await resultPromise;
      expect(result).toBe('retry-worked');
      expect(callCount).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  }, 5000);

  it('throws a rate_limited error after exhausting all retries', async () => {
    // maxRetries=0 → no retries → throws immediately without sleeping (no fake timers needed)
    let caught: unknown;
    try {
      await withSlackRetries(
        () => Promise.reject(makeSlackError('too_many_requests', { retryAfter: 0 })),
        0, // maxRetries=0: attempt once, if rate-limited → throw immediately
      );
    } catch (err) {
      caught = err;
    }
    const e = caught as SlackActionError;
    expect(e.domain).toBe('slack');
    expect(e.code).toBe('rate_limited');
  });
});

// ---------------------------------------------------------------------------
// Idempotent-success cases
// ---------------------------------------------------------------------------

describe('withSlackRetries — idempotent-success cases', () => {
  it('resolves (returns undefined) when already_reacted is thrown', async () => {
    let called = false;
    const result = await withSlackRetries(() => {
      called = true;
      return Promise.reject(makeSlackError('already_reacted'));
    });
    expect(called).toBe(true);
    // Resolves to undefined (cast back via `undefined as unknown as T`)
    expect(result).toBeUndefined();
  });

  it('resolves (returns undefined) when no_reaction is thrown', async () => {
    let called = false;
    const result = await withSlackRetries(() => {
      called = true;
      return Promise.reject(makeSlackError('no_reaction'));
    });
    expect(called).toBe(true);
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// mapSlackError — tested indirectly through thrown error .code
// ---------------------------------------------------------------------------

describe('withSlackRetries — non-rate-limit Slack errors (mapSlackError via .code)', () => {
  async function expectCode(
    slackErrorString: string,
    expectedCode: SlackActionError['code'],
  ): Promise<void> {
    await expect(
      withSlackRetries(() => Promise.reject(makeSlackError(slackErrorString))),
    ).rejects.toSatisfy((err: unknown) => {
      const e = err as SlackActionError;
      return e.domain === 'slack' && e.code === expectedCode;
    });
  }

  it('maps not_authed → code: not_authed', async () => {
    await expectCode('not_authed', 'not_authed');
  });

  it('maps invalid_auth → code: not_authed', async () => {
    await expectCode('invalid_auth', 'not_authed');
  });

  it('maps token_revoked → code: not_authed', async () => {
    await expectCode('token_revoked', 'not_authed');
  });

  it('maps token_expired → code: not_authed', async () => {
    await expectCode('token_expired', 'not_authed');
  });

  it('maps channel_not_found → code: channel_not_found', async () => {
    await expectCode('channel_not_found', 'channel_not_found');
  });

  it('maps invalid_blocks → code: invalid_input', async () => {
    await expectCode('invalid_blocks', 'invalid_input');
  });

  it('maps no_text → code: invalid_input', async () => {
    await expectCode('no_text', 'invalid_input');
  });

  it('maps unknown error strings → code: api_error', async () => {
    await expectCode('some_unknown_slack_error', 'api_error');
  });

  it('thrown error is a SlackActionError with domain: slack', async () => {
    let caught: unknown;
    try {
      await withSlackRetries(() => Promise.reject(makeSlackError('channel_not_found')));
    } catch (err) {
      caught = err;
    }
    assertSlackActionError(caught, 'channel_not_found');
  });

  it('thrown error is retryable: false for non-rate-limit errors', async () => {
    let caught: unknown;
    try {
      await withSlackRetries(() => Promise.reject(makeSlackError('channel_not_found')));
    } catch (err) {
      caught = err;
    }
    const e = caught as SlackActionError;
    expect(e.retryable).toBe(false);
  });

  it('thrown error has retryable: true for rate_limited', async () => {
    // maxRetries=0 → no retries allowed, throws immediately without sleeping
    let caught: unknown;
    try {
      await withSlackRetries(
        () => Promise.reject(makeSlackError('too_many_requests', { retryAfter: 0 })),
        0,
      );
    } catch (err) {
      caught = err;
    }
    const e = caught as SlackActionError;
    expect(e.domain).toBe('slack');
    expect(e.code).toBe('rate_limited');
    expect(e.retryable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Non-Slack errors propagate as-is
// ---------------------------------------------------------------------------

describe('withSlackRetries — non-Slack errors', () => {
  it('re-throws a plain Error without wrapping it', async () => {
    const originalError = new Error('network timeout');
    await expect(withSlackRetries(() => Promise.reject(originalError))).rejects.toBe(originalError);
  });

  it('re-throws a TypeError without wrapping it', async () => {
    const typeErr = new TypeError('fetch failed');
    await expect(withSlackRetries(() => Promise.reject(typeErr))).rejects.toBe(typeErr);
  });
});
