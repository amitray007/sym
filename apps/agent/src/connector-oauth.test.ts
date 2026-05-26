import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  buildConnectorAuthorizeUrl,
  ConnectorOAuthError,
  exchangeConnectorCode,
  generatePkce,
  generateState,
  refreshConnectorToken,
} from './connector-oauth.js';

// ---------------------------------------------------------------------------
// PKCE generation
// ---------------------------------------------------------------------------

describe('generatePkce', () => {
  it('returns codeVerifier, codeChallenge, and method=S256', () => {
    const pkce = generatePkce();
    expect(pkce.codeChallengeMethod).toBe('S256');
    expect(typeof pkce.codeVerifier).toBe('string');
    expect(typeof pkce.codeChallenge).toBe('string');
  });

  it('codeVerifier is base64url (no +, /, =)', () => {
    const { codeVerifier } = generatePkce();
    expect(codeVerifier).toMatch(/^[A-Za-z0-9\-_]+$/);
  });

  it('codeChallenge is base64url', () => {
    const { codeChallenge } = generatePkce();
    expect(codeChallenge).toMatch(/^[A-Za-z0-9\-_]+$/);
  });

  it('codeChallenge is SHA-256 of codeVerifier (S256 spec)', () => {
    const { codeVerifier, codeChallenge } = generatePkce();
    const expected = Buffer.from(createHash('sha256').update(codeVerifier).digest())
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
    expect(codeChallenge).toBe(expected);
  });

  it('produces different values each call (random)', () => {
    const a = generatePkce();
    const b = generatePkce();
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
    expect(a.codeChallenge).not.toBe(b.codeChallenge);
  });
});

describe('generateState', () => {
  it('returns a 64-char hex string', () => {
    expect(generateState()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is random each call', () => {
    expect(generateState()).not.toBe(generateState());
  });
});

// ---------------------------------------------------------------------------
// buildConnectorAuthorizeUrl
// ---------------------------------------------------------------------------

describe('buildConnectorAuthorizeUrl', () => {
  const baseParams = {
    authorizeUrl: 'https://provider.example.com/oauth/authorize',
    clientId: 'client-123',
    redirectUri: 'https://agent.example.com/connectors/oauth/callback',
    scopes: ['read', 'write'],
    state: 'abc123state',
    codeChallenge: 'challenge_xyz',
    codeChallengeMethod: 'S256' as const,
  };

  it('builds a URL with all required parameters', () => {
    const url = new URL(buildConnectorAuthorizeUrl(baseParams));
    expect(url.origin + url.pathname).toBe('https://provider.example.com/oauth/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('client-123');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://agent.example.com/connectors/oauth/callback',
    );
    expect(url.searchParams.get('scope')).toBe('read write');
    expect(url.searchParams.get('state')).toBe('abc123state');
    expect(url.searchParams.get('code_challenge')).toBe('challenge_xyz');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('joins multiple scopes with a space', () => {
    const url = new URL(
      buildConnectorAuthorizeUrl({ ...baseParams, scopes: ['read', 'write', 'admin'] }),
    );
    expect(url.searchParams.get('scope')).toBe('read write admin');
  });

  it('handles a single scope', () => {
    const url = new URL(buildConnectorAuthorizeUrl({ ...baseParams, scopes: ['read'] }));
    expect(url.searchParams.get('scope')).toBe('read');
  });
});

// ---------------------------------------------------------------------------
// exchangeConnectorCode
// ---------------------------------------------------------------------------

describe('exchangeConnectorCode', () => {
  const baseParams = {
    tokenUrl: 'https://provider.example.com/oauth/token',
    clientId: 'client-123',
    clientSecret: 'secret-abc',
    code: 'auth-code-xyz',
    redirectUri: 'https://agent.example.com/connectors/oauth/callback',
    codeVerifier: 'verifier-abc123',
  };

  function makeOkFetch(extra: Record<string, unknown> = {}): typeof fetch {
    return vi.fn().mockResolvedValue({
      json: async () => ({
        access_token: 'access-tok-abc',
        refresh_token: 'refresh-tok-xyz',
        expires_in: 3600,
        scope: 'read write',
        ...extra,
      }),
    }) as unknown as typeof fetch;
  }

  it('posts to tokenUrl with correct form body fields', async () => {
    const mockFetch = makeOkFetch();
    await exchangeConnectorCode(baseParams, mockFetch);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://provider.example.com/oauth/token');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['content-type']).toBe(
      'application/x-www-form-urlencoded',
    );

    const body = new URLSearchParams(init.body as string);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('client_id')).toBe('client-123');
    expect(body.get('client_secret')).toBe('secret-abc');
    expect(body.get('code')).toBe('auth-code-xyz');
    expect(body.get('redirect_uri')).toBe('https://agent.example.com/connectors/oauth/callback');
    expect(body.get('code_verifier')).toBe('verifier-abc123');
  });

  it('parses a full successful response', async () => {
    const result = await exchangeConnectorCode(baseParams, makeOkFetch());
    expect(result.accessToken).toBe('access-tok-abc');
    expect(result.refreshToken).toBe('refresh-tok-xyz');
    expect(result.expiresIn).toBe(3600);
    expect(result.scope).toBe('read write');
  });

  it('parses a response without optional fields', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      json: async () => ({ access_token: 'tok-only' }),
    }) as unknown as typeof fetch;
    const result = await exchangeConnectorCode(baseParams, mockFetch);
    expect(result.accessToken).toBe('tok-only');
    expect(result.refreshToken).toBeUndefined();
    expect(result.expiresIn).toBeUndefined();
    expect(result.scope).toBeUndefined();
  });

  it('omits client_secret from body when empty string', async () => {
    const mockFetch = makeOkFetch();
    await exchangeConnectorCode({ ...baseParams, clientSecret: '' }, mockFetch);
    const body = new URLSearchParams(
      ((mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit])[1]
        .body as string,
    );
    expect(body.has('client_secret')).toBe(false);
  });

  it('throws ConnectorOAuthError on network failure', async () => {
    const mockFetch = vi
      .fn()
      .mockRejectedValue(new Error('network down')) as unknown as typeof fetch;
    await expect(exchangeConnectorCode(baseParams, mockFetch)).rejects.toThrow(ConnectorOAuthError);
    await expect(exchangeConnectorCode(baseParams, mockFetch)).rejects.toMatchObject({
      code: 'exchange_failed',
    });
  });

  it('throws ConnectorOAuthError on error response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      json: async () => ({ error: 'invalid_grant', error_description: 'Code expired' }),
    }) as unknown as typeof fetch;
    await expect(exchangeConnectorCode(baseParams, mockFetch)).rejects.toThrow(ConnectorOAuthError);
    await expect(exchangeConnectorCode(baseParams, mockFetch)).rejects.toMatchObject({
      code: 'bad_response',
    });
  });

  it('computes expiresAt correctly (now + expires_in seconds)', async () => {
    const before = Date.now();
    const result = await exchangeConnectorCode(baseParams, makeOkFetch({ expires_in: 3600 }));
    const after = Date.now();
    expect(result.expiresIn).toBe(3600);
    // Callers compute: new Date(Date.now() + expiresIn * 1000). Verify the math.
    const computedExpiry = new Date(before + result.expiresIn! * 1000);
    const upperBound = new Date(after + result.expiresIn! * 1000);
    expect(computedExpiry.getTime()).toBeGreaterThanOrEqual(before + 3600 * 1000 - 50);
    expect(upperBound.getTime()).toBeLessThanOrEqual(after + 3600 * 1000 + 50);
  });
});

// ---------------------------------------------------------------------------
// refreshConnectorToken
// ---------------------------------------------------------------------------

describe('refreshConnectorToken', () => {
  const baseParams = {
    tokenUrl: 'https://provider.example.com/oauth/token',
    clientId: 'client-123',
    clientSecret: 'secret-abc',
    refreshToken: 'refresh-tok-xyz',
  };

  function makeOkFetch(extra: Record<string, unknown> = {}): typeof fetch {
    return vi.fn().mockResolvedValue({
      json: async () => ({
        access_token: 'new-access-tok',
        refresh_token: 'new-refresh-tok',
        expires_in: 3600,
        ...extra,
      }),
    }) as unknown as typeof fetch;
  }

  it('posts with grant_type=refresh_token and refresh_token in body', async () => {
    const mockFetch = makeOkFetch();
    await refreshConnectorToken(baseParams, mockFetch);

    const [url, init] = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://provider.example.com/oauth/token');
    expect(init.method).toBe('POST');

    const body = new URLSearchParams(init.body as string);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('client_id')).toBe('client-123');
    expect(body.get('client_secret')).toBe('secret-abc');
    expect(body.get('refresh_token')).toBe('refresh-tok-xyz');
    // code and code_verifier must NOT be present
    expect(body.has('code')).toBe(false);
    expect(body.has('code_verifier')).toBe(false);
  });

  it('parses the refreshed tokens', async () => {
    const result = await refreshConnectorToken(baseParams, makeOkFetch());
    expect(result.accessToken).toBe('new-access-tok');
    expect(result.refreshToken).toBe('new-refresh-tok');
    expect(result.expiresIn).toBe(3600);
  });

  it('handles a rotating refresh token (new refreshToken in response)', async () => {
    const result = await refreshConnectorToken(
      baseParams,
      makeOkFetch({ refresh_token: 'rotated-refresh' }),
    );
    expect(result.refreshToken).toBe('rotated-refresh');
  });

  it('handles absent refresh_token in response (non-rotating providers)', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      json: async () => ({ access_token: 'new-tok' }),
    }) as unknown as typeof fetch;
    const result = await refreshConnectorToken(baseParams, mockFetch);
    expect(result.accessToken).toBe('new-tok');
    expect(result.refreshToken).toBeUndefined();
  });

  it('throws ConnectorOAuthError on network failure', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('net down')) as unknown as typeof fetch;
    await expect(refreshConnectorToken(baseParams, mockFetch)).rejects.toThrow(ConnectorOAuthError);
    await expect(refreshConnectorToken(baseParams, mockFetch)).rejects.toMatchObject({
      code: 'refresh_failed',
    });
  });

  it('throws ConnectorOAuthError on error response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      json: async () => ({ error: 'token_expired' }),
    }) as unknown as typeof fetch;
    await expect(refreshConnectorToken(baseParams, mockFetch)).rejects.toMatchObject({
      code: 'bad_response',
    });
  });

  it('omits client_secret from body when empty', async () => {
    const mockFetch = makeOkFetch();
    await refreshConnectorToken({ ...baseParams, clientSecret: '' }, mockFetch);
    const body = new URLSearchParams(
      ((mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit])[1]
        .body as string,
    );
    expect(body.has('client_secret')).toBe(false);
  });
});
