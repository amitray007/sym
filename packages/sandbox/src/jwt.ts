/**
 * Sandbox JWT — mint and verify short-lived identity tokens.
 *
 * Claims (see SandboxIdentity in @sym/contracts):
 *   sandboxId, jti (SandboxJwtId), requester (SlackUserId), turnId, nbf, exp
 *
 * Algorithm: HS256 (HMAC-SHA256). The signing key is injected at runtime via
 * `SandboxJwtConfig.secret` — this module never reads env directly.
 *
 * Security notes:
 * - TTL is short (configurable, default 15 min) — covers at most one sandbox turn.
 * - `jti` is a random UUIDv7 so each token is unique (no replay across turns).
 * - The proxy must verify `jti` matches the lease's `sandboxJwtId`.
 * - Do not extend TTL beyond the turn duration.
 *
 * New env var required (noted for S8/.env.example):
 *   SANDBOX_JWT_SECRET — raw secret used as HMAC key; min 32 bytes recommended.
 */

import { errors as joseErrors, SignJWT, jwtVerify } from 'jose';
import { uuidv7 } from 'uuidv7';

import type { SandboxId, SandboxIdentity, SandboxJwtId, SlackUserId, TurnId } from '@sym/contracts';

/** TTL in seconds for a sandbox JWT (default: 15 minutes). */
export const SANDBOX_JWT_TTL_SECONDS = 15 * 60;

/** Config injected at runtime — never read env directly here. */
export interface SandboxJwtConfig {
  /** Raw secret bytes (or a string) for HMAC-SHA256 signing. Min 32 chars recommended. */
  secret: string | Uint8Array;
  /** Override TTL in seconds. Defaults to SANDBOX_JWT_TTL_SECONDS. */
  ttlSeconds?: number;
}

export class SandboxJwtError extends Error {
  constructor(
    message: string,
    public readonly code: 'invalid' | 'expired' | 'wrong_key',
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'SandboxJwtError';
  }
}

function toKeyMaterial(secret: string | Uint8Array): Uint8Array {
  if (typeof secret === 'string') {
    return new TextEncoder().encode(secret);
  }
  return secret;
}

/**
 * Mint a short-lived sandbox JWT embedding SandboxIdentity claims.
 * Returns the signed compact JWT string.
 */
export async function mintSandboxJwt(
  params: {
    sandboxId: SandboxId;
    requester: SlackUserId;
    turnId: TurnId;
  },
  config: SandboxJwtConfig,
): Promise<{ token: string; identity: SandboxIdentity }> {
  const keyMaterial = toKeyMaterial(config.secret);
  const ttl = config.ttlSeconds ?? SANDBOX_JWT_TTL_SECONDS;
  const now = Math.floor(Date.now() / 1000);
  const jti = uuidv7() as SandboxJwtId;

  const identity: SandboxIdentity = {
    sandboxId: params.sandboxId,
    jti,
    requester: params.requester,
    turnId: params.turnId,
    nbf: now,
    exp: now + ttl,
  };

  const token = await new SignJWT({
    sandboxId: identity.sandboxId,
    requester: identity.requester,
    turnId: identity.turnId,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setJti(identity.jti)
    .setNotBefore(identity.nbf)
    .setIssuedAt(now)
    .setExpirationTime(identity.exp)
    .sign(keyMaterial);

  return { token, identity };
}

/**
 * Verify a sandbox JWT and extract the SandboxIdentity claims.
 * Throws SandboxJwtError on any failure (invalid, expired, wrong key).
 */
export async function verifySandboxJwt(
  token: string,
  config: SandboxJwtConfig,
): Promise<SandboxIdentity> {
  const keyMaterial = toKeyMaterial(config.secret);

  let payload: {
    jti?: string;
    sandboxId?: string;
    requester?: string;
    turnId?: string;
    nbf?: number;
    exp?: number;
  };

  try {
    const result = await jwtVerify(token, keyMaterial, {
      algorithms: ['HS256'],
    });
    payload = result.payload as typeof payload;
  } catch (cause) {
    if (cause instanceof joseErrors.JWTExpired) {
      throw new SandboxJwtError('sandbox JWT has expired', 'expired', { cause });
    }
    if (cause instanceof joseErrors.JWSSignatureVerificationFailed) {
      throw new SandboxJwtError(
        'sandbox JWT signature is invalid (wrong key or tampered)',
        'wrong_key',
        { cause },
      );
    }
    throw new SandboxJwtError('sandbox JWT is invalid', 'invalid', { cause });
  }

  if (
    typeof payload.jti !== 'string' ||
    typeof payload.sandboxId !== 'string' ||
    typeof payload.requester !== 'string' ||
    typeof payload.turnId !== 'string' ||
    typeof payload.nbf !== 'number' ||
    typeof payload.exp !== 'number'
  ) {
    throw new SandboxJwtError('sandbox JWT is missing required claims', 'invalid');
  }

  return {
    jti: payload.jti as SandboxJwtId,
    sandboxId: payload.sandboxId as SandboxId,
    requester: payload.requester as SlackUserId,
    turnId: payload.turnId as TurnId,
    nbf: payload.nbf,
    exp: payload.exp,
  };
}
