import { createHmac, timingSafeEqual } from 'node:crypto';

/** Subset of Slack request headers this module cares about (lowercase keys). */
export interface SlackHeaders {
  'x-slack-request-timestamp': string;
  'x-slack-signature': string;
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'invalid_signature' | 'stale_timestamp' };

const FIVE_MINUTES_S = 5 * 60;

/**
 * Verifies a Slack request signature.
 *
 * Algorithm:
 *   base = `v0:${timestamp}:${rawBody}`
 *   expected = `v0=` + HMAC-SHA256(signingSecret, base).hexDigest()
 *   compare expected to X-Slack-Signature with timingSafeEqual
 *
 * Rejects if |now - timestamp| > 5 minutes (Slack's replay window).
 */
export function verifySlackSignature(opts: {
  signingSecret: string;
  headers: SlackHeaders;
  rawBody: string;
}): VerifyResult {
  const { signingSecret, headers, rawBody } = opts;
  const ts = headers['x-slack-request-timestamp'];
  const provided = headers['x-slack-signature'];

  // Check timestamp skew first (cheap, before crypto work). A non-numeric
  // timestamp makes Number(ts) NaN, and `NaN > window` is false — which would
  // SKIP the replay check. Reject a non-finite timestamp explicitly.
  const tsNum = Number(ts);
  const nowS = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(tsNum) || Math.abs(nowS - tsNum) > FIVE_MINUTES_S) {
    return { ok: false, reason: 'stale_timestamp' };
  }

  // Compute expected HMAC.
  const baseString = `v0:${ts}:${rawBody}`;
  const expected = 'v0=' + createHmac('sha256', signingSecret).update(baseString).digest('hex');

  // Constant-time comparison to prevent timing attacks.
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'invalid_signature' };
  }

  return { ok: true };
}
