/**
 * HMAC timeout-resume callback tokens.
 *
 * mint()   — produce a signed token for (conversationId, sliceId).
 * verify() — validate the token and return the payload, or throw.
 *
 * Token wire format:
 *   base64url(JSON payload) + "." + base64url(HMAC-SHA256 signature)
 *
 * The HMAC key is injected via TaskConfig.hmacSecret or falls back to
 * process.env["SYM_TASK_HMAC_SECRET"].
 *
 * New environment variable: SYM_TASK_HMAC_SECRET
 *   A high-entropy random string (≥ 32 chars). Add to .env.example.
 */

import { createHmac } from 'node:crypto';

import type { ResumeToken, ResumeTokenPayload } from './types.js';
import type { ConversationId, SliceId } from '@sym/contracts';

export class HmacSecretMissingError extends Error {
  constructor() {
    super(
      'SYM_TASK_HMAC_SECRET is not configured. ' +
        'Set it in the environment or pass hmacSecret in TaskConfig.',
    );
    this.name = 'HmacSecretMissingError';
  }
}

export class ResumeTokenInvalidError extends Error {
  constructor(reason: string) {
    super(`resume token invalid: ${reason}`);
    this.name = 'ResumeTokenInvalidError';
  }
}

export class ResumeTokenExpiredError extends Error {
  constructor() {
    super('resume token has expired');
    this.name = 'ResumeTokenExpiredError';
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function b64url(data: string): string {
  return Buffer.from(data, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function fromB64url(s: string): string {
  // Re-pad
  const padded = s + '='.repeat((4 - (s.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
}

function sign(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function resolveSecret(provided?: string): string {
  const secret = provided ?? process.env['SYM_TASK_HMAC_SECRET'];
  if (!secret) throw new HmacSecretMissingError();
  return secret;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface MintResumeTokenInput {
  conversationId: ConversationId;
  sliceId: SliceId;
  /** Injected secret — falls back to process.env["SYM_TASK_HMAC_SECRET"]. */
  hmacSecret?: string;
  /** TTL in seconds. @default 3600 */
  ttlSeconds?: number;
}

/**
 * Mint a signed resume token for a (conversationId, sliceId) pair.
 */
export function mintResumeToken(input: MintResumeTokenInput): ResumeToken {
  const secret = resolveSecret(input.hmacSecret);
  const ttlSeconds = input.ttlSeconds ?? 3_600;
  const mintedAt = new Date().toISOString();
  const expiresAt = Math.floor(Date.now() / 1_000) + ttlSeconds;

  const payload: ResumeTokenPayload = {
    conversationId: input.conversationId,
    sliceId: input.sliceId,
    mintedAt,
  };

  const payloadB64 = b64url(JSON.stringify(payload));
  const sig = sign(secret, payloadB64);
  const token = `${payloadB64}.${sig}`;

  return { token, expiresAt };
}

export interface VerifyResumeTokenInput {
  token: string;
  hmacSecret?: string;
}

export interface VerifiedResumeToken {
  conversationId: ConversationId;
  sliceId: SliceId;
  mintedAt: string;
}

/**
 * Verify a signed resume token. Throws on tamper or expiry.
 */
export function verifyResumeToken(
  input: VerifyResumeTokenInput,
  opts: { ttlSeconds?: number } = {},
): VerifiedResumeToken {
  const secret = resolveSecret(input.hmacSecret);
  const ttlSeconds = opts.ttlSeconds ?? 3_600;

  const parts = input.token.split('.');
  if (parts.length !== 2) {
    throw new ResumeTokenInvalidError('malformed token (expected 2 parts)');
  }

  const [payloadB64, providedSig] = parts as [string, string];
  const expectedSig = sign(secret, payloadB64);

  // Constant-time comparison to prevent timing attacks.
  const expectedBuf = Buffer.from(expectedSig, 'utf-8');
  const providedBuf = Buffer.from(providedSig, 'utf-8');

  if (expectedBuf.length !== providedBuf.length || !expectedBuf.equals(providedBuf)) {
    throw new ResumeTokenInvalidError('signature mismatch');
  }

  let payload: ResumeTokenPayload;
  try {
    payload = JSON.parse(fromB64url(payloadB64)) as ResumeTokenPayload;
  } catch {
    throw new ResumeTokenInvalidError('payload is not valid JSON');
  }

  const mintedMs = new Date(payload.mintedAt).getTime();
  if (isNaN(mintedMs)) {
    throw new ResumeTokenInvalidError('mintedAt is not a valid date');
  }

  const ageSeconds = (Date.now() - mintedMs) / 1_000;
  if (ageSeconds > ttlSeconds) {
    throw new ResumeTokenExpiredError();
  }

  return {
    conversationId: payload.conversationId,
    sliceId: payload.sliceId,
    mintedAt: payload.mintedAt,
  };
}
