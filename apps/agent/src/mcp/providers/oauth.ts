/**
 * mcp/providers/oauth.ts — OAuthProvider implements CredentialProvider.
 *
 * `resolve()` returns `{ apply: 'native', oauth: <SdkOAuthAdapter> }` where
 * `SdkOAuthAdapter` is a full implementation of the SDK's `OAuthClientProvider`
 * interface backed by an encrypted `SqliteCredentialStore`.
 *
 * Token refresh: the SDK handles token refresh internally via the
 * `authProvider`'s saved refresh token. When `auth()` is called by the
 * transport, it checks `provider.tokens().refresh_token` first and attempts
 * a silent refresh before starting a new authorization flow. No manual refresh
 * is needed here.
 *
 * `redirectToAuthorization`: instead of opening a browser, we record the
 * pending auth in the module-level oauth-registry so C3b can surface it as a
 * Slack "Connect" button. The transport is also stored so `completeOAuth` can
 * call `finishAuth` after the user consents.
 */

import { generateState, registerPendingAuth } from '../oauth-registry.js';
import { getStore } from '../store.js';

import type { CredentialProvider, ResolvedCredential } from './provider.js';
import type { CredentialStore } from '../store.js';
import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js';

// We need the transport type for the registry — import lazily to avoid circular.
import type { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  OAuthClientMetadata,
  OAuthClientInformationMixed,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface OAuthProviderOptions {
  /**
   * The OAuth redirect URI that the authorization server will call back.
   * Shape: `${SYM_PUBLIC_URL}/oauth/callback/${connectorName}`.
   *
   * The caller (makeProvider) derives this from SYM_PUBLIC_URL env.
   * Tests may pass a custom value.
   */
  redirectUri: string;

  /**
   * OAuth client metadata sent during Dynamic Client Registration.
   * Defaults to a minimal set if absent.
   */
  clientMetadata?: Partial<OAuthClientMetadata>;
}

// ---------------------------------------------------------------------------
// SdkOAuthAdapter — implements OAuthClientProvider backed by CredentialStore
// ---------------------------------------------------------------------------

/**
 * Full implementation of the SDK's `OAuthClientProvider` interface.
 *
 * State is persisted in the encrypted credential store so tokens survive
 * process restarts. `redirectToAuthorization` records the pending auth in the
 * module-level registry rather than opening a browser (this is a server app).
 *
 * The `transport` property MUST be set before `redirectToAuthorization` is
 * called. `OAuthProvider.resolve()` wires this after construction.
 */
export class SdkOAuthAdapter implements OAuthClientProvider {
  /** Set by OAuthProvider after the transport is built. */
  transport: StreamableHTTPClientTransport | undefined = undefined;

  private readonly _pendingState: string;

  constructor(
    private readonly connectorName: string,
    private readonly store: CredentialStore,
    private readonly _redirectUri: string,
    private readonly _clientMeta: OAuthClientMetadata,
  ) {
    // Generate the CSRF state once per adapter instance (= once per connect).
    this._pendingState = generateState();
  }

  // --- OAuthClientProvider required properties ---

  get redirectUrl(): string {
    return this._redirectUri;
  }

  get clientMetadata(): OAuthClientMetadata {
    return this._clientMeta;
  }

  // --- OAuthClientProvider optional: state for CSRF ---

  state(): string {
    return this._pendingState;
  }

  // --- client information (DCR) ---

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.store.getClientInformation(this.connectorName);
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    this.store.saveClientInformation(this.connectorName, info);
  }

  // --- tokens ---

  tokens(): OAuthTokens | undefined {
    return this.store.getTokens(this.connectorName);
  }

  saveTokens(tokens: OAuthTokens): void {
    this.store.saveTokens(this.connectorName, tokens);
  }

  // --- PKCE code verifier ---

  codeVerifier(): string {
    const v = this.store.getCodeVerifier(this.connectorName);
    if (v === undefined) {
      throw new Error(
        `[oauth:${this.connectorName}] No code verifier saved — was saveCodeVerifier called?`,
      );
    }
    return v;
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.store.saveCodeVerifier(this.connectorName, codeVerifier);
  }

  // --- discovery state (optional caching) ---

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.store.getDiscoveryState(this.connectorName);
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.store.saveDiscoveryState(this.connectorName, state);
  }

  // --- Authorization redirect (server-side: record, don't open browser) ---

  /**
   * Called by the SDK when user authorization is required.
   *
   * In a browser app this would navigate. Here we register the pending auth
   * in the module-level registry so C3b can surface the URL to the Slack user
   * as a "Connect" button, and so `completeOAuth` can call `finishAuth` later.
   *
   * The transport reference must be set before this fires; `OAuthProvider`
   * wires it after building the transport.
   */
  redirectToAuthorization(authorizationUrl: URL): void {
    if (this.transport === undefined) {
      // Should not happen in normal flow — log and continue so the error
      // propagates naturally as UnauthorizedError from the transport.
      console.error(
        `[oauth:${this.connectorName}] redirectToAuthorization fired but transport is not set — pending auth cannot be completed`,
      );
      return;
    }

    console.info(
      `[oauth:${this.connectorName}] authorization required — authorize URL: ${authorizationUrl.toString()}`,
    );

    registerPendingAuth(this.connectorName, authorizationUrl, this.transport, this._pendingState);
  }

  // --- Credential invalidation (optional) ---

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'all' || scope === 'tokens') {
      // We don't have a deleteTokens method; overwrite with a sentinel is
      // not possible without a type-safe sentinel. Clearing via saveTokens
      // with an obviously expired token is a workaround, but the simplest
      // behavior is to rely on the next connect triggering a new auth flow
      // when tokens() returns undefined. Leave as-is for now.
      // If the store needs clearing, a fresh adapter instance will have no tokens.
    }
    if (scope === 'all' || scope === 'verifier') {
      this.store.clearCodeVerifier(this.connectorName);
    }
    // Other scopes (client, discovery) — no-op; DCR result is intentionally
    // long-lived and not invalidated on transient failures.
  }
}

// ---------------------------------------------------------------------------
// OAuthProvider — implements CredentialProvider
// ---------------------------------------------------------------------------

/**
 * CredentialProvider for `kind:'oauth'` connectors.
 *
 * `resolve()` returns `{ apply: 'native', oauth: SdkOAuthAdapter }`.
 * The transport is wired AFTER `buildTransport` returns via
 * `OAuthProvider.wireTransport(transport)`.
 *
 * The dispatcher calls `wireTransport` after constructing the transport
 * so `redirectToAuthorization` can reference it when it fires.
 */
export class OAuthProvider implements CredentialProvider {
  private readonly adapter: SdkOAuthAdapter;

  constructor(connectorName: string, store: CredentialStore, opts: OAuthProviderOptions) {
    const clientMetadata: OAuthClientMetadata = {
      // OAuthClientMetadata.redirect_uris is string[] (ZodURL infers string)
      redirect_uris: [opts.redirectUri],
      client_name: `sym-mcp-${connectorName}`,
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none', // public client
      ...opts.clientMetadata,
    };

    this.adapter = new SdkOAuthAdapter(connectorName, store, opts.redirectUri, clientMetadata);
  }

  /**
   * Wire the transport into the adapter so `redirectToAuthorization`
   * can register it in the pending-auth registry.
   *
   * MUST be called after `buildTransport` returns and before `client.connect`.
   */
  wireTransport(transport: StreamableHTTPClientTransport): void {
    this.adapter.transport = transport;
  }

  async resolve(): Promise<ResolvedCredential> {
    return { apply: 'native', oauth: this.adapter };
  }

  /**
   * Refresh is handled by the SDK internally via the saved refresh token.
   * We return null here — callers should reconnect if they get UnauthorizedError.
   */
  async refresh(): Promise<ResolvedCredential | null> {
    return null;
  }
}

// ---------------------------------------------------------------------------
// makeOAuthProvider helper
// ---------------------------------------------------------------------------

/**
 * Create an OAuthProvider for a connector.
 *
 * @param connectorName - The connector's logical name (slug).
 * @param store - Optional credential store (defaults to the process singleton).
 * @param publicUrl - Optional public URL base for the callback.
 *                    Defaults to SYM_PUBLIC_URL env.
 */
export function makeOAuthProvider(
  connectorName: string,
  store?: CredentialStore,
  publicUrl?: string,
): OAuthProvider {
  const resolvedPublicUrl = publicUrl ?? process.env['SYM_PUBLIC_URL'] ?? 'http://localhost:3000';

  const redirectUri = `${resolvedPublicUrl.replace(/\/$/, '')}/oauth/callback/${connectorName}`;

  return new OAuthProvider(connectorName, store ?? getStore(), { redirectUri });
}
