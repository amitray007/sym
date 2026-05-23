/**
 * JWT minter + verifier tests.
 * All hermetic — no network, no DB, no Docker.
 */

import { describe, expect, it } from 'vitest';

import { SandboxJwtError, mintSandboxJwt, verifySandboxJwt } from './jwt.js';

import type { SandboxId, SlackUserId, TurnId } from '@sym/contracts';

const SECRET_A = 'test-secret-for-sandbox-jwt-must-be-long-enough-32+chars';
const SECRET_B = 'another-secret-different-from-a-and-also-long-enough!!';

const BASE_PARAMS = {
  sandboxId: 's_test' as SandboxId,
  requester: 'U_TESTER' as SlackUserId,
  turnId: 't_turn_1' as TurnId,
};

describe('@sym/sandbox — JWT', () => {
  it('mints a JWT and verifies it successfully (happy path)', async () => {
    const config = { secret: SECRET_A };
    const { token, identity } = await mintSandboxJwt(BASE_PARAMS, config);

    expect(typeof token).toBe('string');
    expect(token.split('.').length).toBe(3); // compact JWT format

    const verified = await verifySandboxJwt(token, config);
    expect(verified.sandboxId).toBe(BASE_PARAMS.sandboxId);
    expect(verified.requester).toBe(BASE_PARAMS.requester);
    expect(verified.turnId).toBe(BASE_PARAMS.turnId);
    expect(verified.jti).toBe(identity.jti);
    expect(verified.exp).toBeGreaterThan(verified.nbf);
  });

  it('embeds all SandboxIdentity fields', async () => {
    const config = { secret: SECRET_A };
    const { identity } = await mintSandboxJwt(BASE_PARAMS, config);

    expect(identity.sandboxId).toBe(BASE_PARAMS.sandboxId);
    expect(identity.requester).toBe(BASE_PARAMS.requester);
    expect(identity.turnId).toBe(BASE_PARAMS.turnId);
    expect(typeof identity.jti).toBe('string');
    expect(typeof identity.nbf).toBe('number');
    expect(typeof identity.exp).toBe('number');
    expect(identity.exp).toBeGreaterThan(identity.nbf);
  });

  it('uses a unique jti on each mint', async () => {
    const config = { secret: SECRET_A };
    const { identity: a } = await mintSandboxJwt(BASE_PARAMS, config);
    const { identity: b } = await mintSandboxJwt(BASE_PARAMS, config);
    expect(a.jti).not.toBe(b.jti);
  });

  it('respects custom TTL', async () => {
    const ttlSeconds = 60;
    const config = { secret: SECRET_A, ttlSeconds };
    const { identity } = await mintSandboxJwt(BASE_PARAMS, config);
    const delta = identity.exp - identity.nbf;
    // Allow ±2s for test timing
    expect(delta).toBeGreaterThanOrEqual(ttlSeconds - 2);
    expect(delta).toBeLessThanOrEqual(ttlSeconds + 2);
  });

  it('rejects an expired token', async () => {
    // Mint a token that expired 1 second ago
    const config = { secret: SECRET_A, ttlSeconds: -1 };
    const { token } = await mintSandboxJwt(BASE_PARAMS, config);
    await expect(verifySandboxJwt(token, { secret: SECRET_A })).rejects.toThrow(SandboxJwtError);
    await expect(verifySandboxJwt(token, { secret: SECRET_A })).rejects.toMatchObject({
      code: 'expired',
    });
  });

  it('rejects a tampered token (modified payload)', async () => {
    const config = { secret: SECRET_A };
    const { token } = await mintSandboxJwt(BASE_PARAMS, config);

    // Tamper the payload section (middle part)
    const parts = token.split('.');
    // Decode, modify, re-encode
    const payloadStr = Buffer.from(parts[1]!, 'base64url').toString('utf8');
    const payload = JSON.parse(payloadStr) as Record<string, unknown>;
    payload['requester'] = 'EVIL_USER';
    parts[1] = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const tampered = parts.join('.');

    await expect(verifySandboxJwt(tampered, config)).rejects.toThrow(SandboxJwtError);
  });

  it('rejects a token signed with a different key', async () => {
    const { token } = await mintSandboxJwt(BASE_PARAMS, { secret: SECRET_A });
    await expect(verifySandboxJwt(token, { secret: SECRET_B })).rejects.toThrow(SandboxJwtError);
    await expect(verifySandboxJwt(token, { secret: SECRET_B })).rejects.toMatchObject({
      code: 'wrong_key',
    });
  });

  it('rejects a completely invalid token string', async () => {
    await expect(verifySandboxJwt('not.a.jwt', { secret: SECRET_A })).rejects.toThrow(
      SandboxJwtError,
    );
  });

  it('rejects an empty token string', async () => {
    await expect(verifySandboxJwt('', { secret: SECRET_A })).rejects.toThrow(SandboxJwtError);
  });
});
