import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { verifySlackSignature } from '../src/verify.js';

// ---- helpers ---------------------------------------------------------------

const SECRET = 'test-signing-secret-32-bytes-min';

function makeTimestamp(offsetSeconds = 0): string {
  return String(Math.floor(Date.now() / 1000) + offsetSeconds);
}

function sign(timestamp: string, rawBody: string): string {
  const baseString = `v0:${timestamp}:${rawBody}`;
  const mac = createHmac('sha256', SECRET).update(baseString).digest('hex');
  return `v0=${mac}`;
}

// ---- tests -----------------------------------------------------------------

describe('verifySlackSignature', () => {
  it('returns ok for a valid signature', () => {
    const ts = makeTimestamp();
    const body = 'payload=hello%20world';
    const result = verifySlackSignature({
      signingSecret: SECRET,
      headers: {
        'x-slack-request-timestamp': ts,
        'x-slack-signature': sign(ts, body),
      },
      rawBody: body,
    });
    expect(result.ok).toBe(true);
  });

  it('returns invalid_signature for a wrong MAC', () => {
    const ts = makeTimestamp();
    const body = 'payload=hello%20world';
    const result = verifySlackSignature({
      signingSecret: SECRET,
      headers: {
        'x-slack-request-timestamp': ts,
        'x-slack-signature': 'v0=badhash',
      },
      rawBody: body,
    });
    expect(result).toEqual({ ok: false, reason: 'invalid_signature' });
  });

  it('returns invalid_signature when body is tampered', () => {
    const ts = makeTimestamp();
    const body = 'payload=hello%20world';
    const tamperedBody = 'payload=TAMPERED';
    const result = verifySlackSignature({
      signingSecret: SECRET,
      headers: {
        'x-slack-request-timestamp': ts,
        'x-slack-signature': sign(ts, body),
      },
      rawBody: tamperedBody,
    });
    expect(result).toEqual({ ok: false, reason: 'invalid_signature' });
  });

  it('returns stale_timestamp for a timestamp older than 5 minutes', () => {
    const ts = makeTimestamp(-301); // 5 minutes and 1 second ago
    const body = 'payload=stale';
    const result = verifySlackSignature({
      signingSecret: SECRET,
      headers: {
        'x-slack-request-timestamp': ts,
        'x-slack-signature': sign(ts, body),
      },
      rawBody: body,
    });
    expect(result).toEqual({ ok: false, reason: 'stale_timestamp' });
  });

  it('returns stale_timestamp for a future timestamp > 5 minutes', () => {
    const ts = makeTimestamp(301); // 5 minutes and 1 second in the future
    const body = 'payload=future';
    const result = verifySlackSignature({
      signingSecret: SECRET,
      headers: {
        'x-slack-request-timestamp': ts,
        'x-slack-signature': sign(ts, body),
      },
      rawBody: body,
    });
    expect(result).toEqual({ ok: false, reason: 'stale_timestamp' });
  });

  it('accepts a timestamp exactly at the 5-minute boundary', () => {
    const ts = makeTimestamp(-300); // exactly 5 minutes ago
    const body = 'payload=boundary';
    const result = verifySlackSignature({
      signingSecret: SECRET,
      headers: {
        'x-slack-request-timestamp': ts,
        'x-slack-signature': sign(ts, body),
      },
      rawBody: body,
    });
    expect(result.ok).toBe(true);
  });
});
