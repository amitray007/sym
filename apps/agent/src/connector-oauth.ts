/**
 * connector-oauth.ts — PKCE + token-exchange helpers for per-connector OAuth.
 *
 * Mirrors slack-oauth.ts in structure but is provider-agnostic:
 *  - The authorize URL, tokenUrl, clientId, and scopes come from
 *    `mcp_configs.oauth_config_json` (ConnectorOAuthConfig).
 *  - The client secret is decrypted from `mcp_configs.env_json` at call-time
 *    and is NEVER stored or logged here.
 *  - All network I/O is injected via `fetchImpl` so unit tests need no server.
 *
 * SECURITY NOTES:
 *  - codeVerifier is generated with 32 bytes of crypto-random data (256 bits
 *    of entropy) — well above the RFC 7636 §4.1 minimum of 43 characters.
 *  - The codeChallenge is SHA-256 (S256 method) over the verifier.
 *  - state is a random 32-byte hex string, opaque to the provider.
 *    (CSRF correlation is done via McpAuthStore look-up, not HMAC here,
 *    because the HMAC approach requires a shared secret that connectors
 *    don't have; the McpAuthStore provides the one-time-use guarantee.)
 */

import { createHash, randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// PKCE helpers
// ---------------------------------------------------------------------------

/** URL-safe base64 without padding (RFC 7636 §4.1). */
function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

export interface PkceChallenge {
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
}

/**
 * Generate a PKCE pair.  `codeVerifier` is 32 crypto-random bytes (base64url),
 * `codeChallenge` is SHA-256 of the verifier (base64url, S256 method).
 */
export function generatePkce(): PkceChallenge {
  const raw = randomBytes(32);
  const codeVerifier = base64url(raw);
  const codeChallenge = base64url(Buffer.from(createHash('sha256').update(codeVerifier).digest()));
  return { codeVerifier, codeChallenge, codeChallengeMethod: 'S256' };
}

/** Generate a random opaque state value (32 bytes → 64 hex chars). */
export function generateState(): string {
  return randomBytes(32).toString('hex');
}

// ---------------------------------------------------------------------------
// Authorize URL
// ---------------------------------------------------------------------------

export interface BuildConnectorAuthorizeUrlParams {
  authorizeUrl: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
}

/**
 * Build the OAuth authorization URL for a connector.
 * The browser is redirected here to start the flow.
 */
export function buildConnectorAuthorizeUrl(p: BuildConnectorAuthorizeUrlParams): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    scope: p.scopes.join(' '),
    state: p.state,
    code_challenge: p.codeChallenge,
    code_challenge_method: p.codeChallengeMethod,
  });
  return `${p.authorizeUrl}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Token exchange / refresh
// ---------------------------------------------------------------------------

/** Shape of a successful OAuth token response. */
export interface ConnectorTokenResponse {
  accessToken: string;
  refreshToken?: string;
  /** Seconds until expiry, as returned by the provider (may be absent). */
  expiresIn?: number;
  /** Space-separated scopes as returned by the provider (may be absent). */
  scope?: string;
}

/** Raw shape of the token endpoint JSON response (provider-facing). */
interface RawTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

export class ConnectorOAuthError extends Error {
  constructor(
    message: string,
    public readonly code: 'exchange_failed' | 'refresh_failed' | 'bad_response',
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ConnectorOAuthError';
  }
}

/**
 * Exchange an authorization code for tokens.
 *
 * Posts to `tokenUrl` with `grant_type=authorization_code` (PKCE variant).
 * The client secret is passed as a form field (not Basic auth) because many
 * providers that also support public clients expect it in the body.
 * If `clientSecret` is empty, it is omitted from the request.
 */
export async function exchangeConnectorCode(
  params: {
    tokenUrl: string;
    clientId: string;
    /** Decrypted client secret — never log or return this. */
    clientSecret: string;
    code: string;
    redirectUri: string;
    codeVerifier: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<ConnectorTokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: params.clientId,
    code: params.code,
    redirect_uri: params.redirectUri,
    code_verifier: params.codeVerifier,
  });
  if (params.clientSecret) {
    body.set('client_secret', params.clientSecret);
  }

  let json: RawTokenResponse;
  try {
    const res = await fetchImpl(params.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    json = (await res.json()) as RawTokenResponse;
  } catch (cause) {
    throw new ConnectorOAuthError('Token exchange request failed', 'exchange_failed', { cause });
  }

  if (json.error || !json.access_token) {
    throw new ConnectorOAuthError(
      `Token exchange error: ${json.error ?? 'missing access_token'} — ${json.error_description ?? ''}`,
      'bad_response',
    );
  }

  const result: ConnectorTokenResponse = { accessToken: json.access_token };
  if (json.refresh_token) result.refreshToken = json.refresh_token;
  if (typeof json.expires_in === 'number') result.expiresIn = json.expires_in;
  if (json.scope) result.scope = json.scope;
  return result;
}

/**
 * Refresh an existing access token.
 *
 * Posts to `tokenUrl` with `grant_type=refresh_token`.
 */
export async function refreshConnectorToken(
  params: {
    tokenUrl: string;
    clientId: string;
    /** Decrypted client secret — never log or return this. */
    clientSecret: string;
    refreshToken: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<ConnectorTokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: params.clientId,
    refresh_token: params.refreshToken,
  });
  if (params.clientSecret) {
    body.set('client_secret', params.clientSecret);
  }

  let json: RawTokenResponse;
  try {
    const res = await fetchImpl(params.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    json = (await res.json()) as RawTokenResponse;
  } catch (cause) {
    throw new ConnectorOAuthError('Token refresh request failed', 'refresh_failed', { cause });
  }

  if (json.error || !json.access_token) {
    throw new ConnectorOAuthError(
      `Token refresh error: ${json.error ?? 'missing access_token'} — ${json.error_description ?? ''}`,
      'bad_response',
    );
  }

  const result: ConnectorTokenResponse = { accessToken: json.access_token };
  if (json.refresh_token) result.refreshToken = json.refresh_token;
  if (typeof json.expires_in === 'number') result.expiresIn = json.expires_in;
  if (json.scope) result.scope = json.scope;
  return result;
}
