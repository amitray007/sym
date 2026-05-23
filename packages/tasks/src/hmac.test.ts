/**
 * Hermetic unit tests for HMAC sign/verify.
 * No database needed.
 */

import { describe, expect, it } from 'vitest';

import {
  HmacSecretMissingError,
  mintResumeToken,
  ResumeTokenExpiredError,
  ResumeTokenInvalidError,
  verifyResumeToken,
} from './hmac.js';

import type { ConversationId, SliceId } from '@sym/contracts';

const SECRET = 'super-secret-test-key-at-least-32-chars!!';
const CONV_ID = 'conv_01234567890abcdef' as ConversationId;
const SLICE_ID = 'slice_0001' as SliceId;

describe('mintResumeToken + verifyResumeToken', () => {
  it('round-trips a valid token', () => {
    const { token } = mintResumeToken({
      conversationId: CONV_ID,
      sliceId: SLICE_ID,
      hmacSecret: SECRET,
    });

    const verified = verifyResumeToken({ token, hmacSecret: SECRET });
    expect(verified.conversationId).toBe(CONV_ID);
    expect(verified.sliceId).toBe(SLICE_ID);
    expect(verified.mintedAt).toBeTruthy();
  });

  it('returns an expiresAt unix epoch in the future', () => {
    const before = Math.floor(Date.now() / 1_000);
    const { expiresAt } = mintResumeToken({
      conversationId: CONV_ID,
      sliceId: SLICE_ID,
      hmacSecret: SECRET,
      ttlSeconds: 60,
    });
    expect(expiresAt).toBeGreaterThanOrEqual(before + 55);
    expect(expiresAt).toBeLessThanOrEqual(before + 65);
  });

  it('rejects a tampered payload', () => {
    const { token } = mintResumeToken({
      conversationId: CONV_ID,
      sliceId: SLICE_ID,
      hmacSecret: SECRET,
    });

    // Flip one char in the payload section
    const [payloadB64, sig] = token.split('.');
    const tampered = `${payloadB64!.slice(0, -2)}xx.${sig}`;

    expect(() => verifyResumeToken({ token: tampered, hmacSecret: SECRET })).toThrowError(
      ResumeTokenInvalidError,
    );
  });

  it('rejects a tampered signature', () => {
    const { token } = mintResumeToken({
      conversationId: CONV_ID,
      sliceId: SLICE_ID,
      hmacSecret: SECRET,
    });

    const [payloadB64, sig] = token.split('.');
    const tamperedSig = sig!.slice(0, -2) + 'xx';
    const tampered = `${payloadB64}.${tamperedSig}`;

    expect(() => verifyResumeToken({ token: tampered, hmacSecret: SECRET })).toThrowError(
      ResumeTokenInvalidError,
    );
  });

  it('rejects a token signed with a different secret', () => {
    const { token } = mintResumeToken({
      conversationId: CONV_ID,
      sliceId: SLICE_ID,
      hmacSecret: 'other-secret-value-at-least-32-chars!!',
    });

    expect(() => verifyResumeToken({ token, hmacSecret: SECRET })).toThrowError(
      ResumeTokenInvalidError,
    );
  });

  it('rejects a malformed token (no dot)', () => {
    expect(() => verifyResumeToken({ token: 'notavalidtoken', hmacSecret: SECRET })).toThrowError(
      ResumeTokenInvalidError,
    );
  });

  it('rejects an expired token', () => {
    const { token } = mintResumeToken({
      conversationId: CONV_ID,
      sliceId: SLICE_ID,
      hmacSecret: SECRET,
      ttlSeconds: 3600, // minted now
    });

    // Verify with a negative TTL — the token is definitively in the past.
    expect(() => verifyResumeToken({ token, hmacSecret: SECRET }, { ttlSeconds: -1 })).toThrowError(
      ResumeTokenExpiredError,
    );
  });

  it('throws HmacSecretMissingError when no secret is available', () => {
    // Temporarily clear the env var (it may not be set in CI — that's fine).
    const saved = process.env['SYM_TASK_HMAC_SECRET'];
    delete process.env['SYM_TASK_HMAC_SECRET'];

    try {
      expect(() => mintResumeToken({ conversationId: CONV_ID, sliceId: SLICE_ID })).toThrowError(
        HmacSecretMissingError,
      );
    } finally {
      if (saved !== undefined) {
        process.env['SYM_TASK_HMAC_SECRET'] = saved;
      }
    }
  });
});
