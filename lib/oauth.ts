// The OAuth sign-in Sym runs against an MCP server: discovery, dynamic client registration,
// PKCE, the RFC 9207 issuer check, the token exchange, and refresh. The worker sign-in
// (decision 036, lib/workers/t3/oauth.ts) and connection sign-ins (decision 045) share it. The
// tools call these functions only inside `"use step"` functions.
//
// Nothing here logs. Errors never hold the code, the code verifier, or a token.

import {
  type AuthorizationServerMetadata,
  discoverOAuthServerInfo,
  exchangeAuthorization,
  type OAuthClientInformationMixed,
  refreshAuthorization,
  registerClient,
  startAuthorization,
} from "@modelcontextprotocol/client";

// What the second half of the sign-in needs. It is plain data, so a workflow can journal it.
export interface SignInStart {
  mcpUrl: string;
  redirectUrl: string;
  state: string;
  authorizationUrl: string;
  authorizationServerUrl: string;
  metadata?: AuthorizationServerMetadata;
  clientInformation: OAuthClientInformationMixed;
  codeVerifier: string;
}

export interface SignInToken {
  accessToken: string;
  // Null when the server issued none.
  refreshToken: string | null;
  expiresAt: Date | null;
}

// What a refresh needs besides the refresh token. It holds the client registration, which can
// carry a client secret, so it is stored like a token and never shown.
export interface OAuthClient {
  mcpUrl: string;
  authorizationServerUrl: string;
  metadata?: AuthorizationServerMetadata;
  clientInformation: OAuthClientInformationMixed;
}

// A random state value. Web Crypto, so the module has no Node built-in imports.
export function newState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Discovers the authorization server, registers Sym for this redirect URL, and builds the
// authorization URL. Each sign-in registers again. Without a scope, Sym asks for the scopes the
// server's protected-resource metadata lists. Sym asks for a refresh token only when the
// server says it issues them.
export async function beginSignIn(input: {
  mcpUrl: string;
  redirectUrl: string;
  state: string;
  scope?: string;
}): Promise<SignInStart> {
  const { mcpUrl, redirectUrl, state } = input;
  const {
    authorizationServerUrl,
    authorizationServerMetadata: metadata,
    resourceMetadata,
  } = await discoverOAuthServerInfo(mcpUrl);
  const scope = input.scope ?? resourceMetadata?.scopes_supported?.join(" ");
  const refresh = metadata?.grant_types_supported?.includes("refresh_token") === true;
  const clientInformation = await registerClient(authorizationServerUrl, {
    ...(metadata ? { metadata } : {}),
    clientMetadata: {
      client_name: "Sym",
      redirect_uris: [redirectUrl],
      grant_types: refresh ? ["authorization_code", "refresh_token"] : ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
  });
  const { authorizationUrl, codeVerifier } = await startAuthorization(authorizationServerUrl, {
    ...(metadata ? { metadata } : {}),
    clientInformation,
    redirectUrl,
    ...(scope ? { scope } : {}),
    state,
    resource: mcpUrl,
  });
  return {
    mcpUrl,
    redirectUrl,
    state,
    authorizationUrl: authorizationUrl.toString(),
    authorizationServerUrl,
    ...(metadata ? { metadata } : {}),
    clientInformation,
    codeVerifier,
  };
}

export type RedirectResult =
  | { kind: "code"; code: string; iss: string | undefined }
  // A request that does not carry this sign-in's state, such as a stray visit. Keep waiting.
  | { kind: "ignore" }
  | { kind: "refused"; reason: string };

// Checks the redirect's query against the sign-in: the state first, then an OAuth error, then
// the RFC 9207 issuer. Pure, so tests cover each case. The reason never holds the code. `server`
// names the server in the refusal, for example "the worker".
export function readRedirect(
  params: URLSearchParams,
  expected: { state: string; metadata?: AuthorizationServerMetadata | undefined },
  server = "the server",
): RedirectResult {
  if (params.get("state") !== expected.state) return { kind: "ignore" };
  const error = params.get("error");
  if (error) {
    return {
      kind: "refused",
      reason: `${capital(server)} refused the sign-in: ${safeWord(error)}.`,
    };
  }
  const iss = params.get("iss") ?? undefined;
  const issuer = expected.metadata?.issuer;
  if (issuer !== undefined) {
    if (iss === undefined && expected.metadata?.authorization_response_iss_parameter_supported) {
      return { kind: "refused", reason: "The sign-in redirect had no issuer." };
    }
    if (iss !== undefined && iss !== issuer) {
      return { kind: "refused", reason: "The sign-in redirect came from another issuer." };
    }
  }
  const code = params.get("code");
  if (!code) return { kind: "refused", reason: "The sign-in redirect had no authorization code." };
  return { kind: "code", code, iss };
}

// Redeems the code. The SDK checks the issuer again before it sends the code.
export async function finishSignIn(
  start: SignInStart,
  redirect: { code: string; iss: string | undefined },
  now: Date = new Date(),
  server = "the server",
): Promise<SignInToken> {
  let tokens: Awaited<ReturnType<typeof exchangeAuthorization>>;
  try {
    tokens = await exchangeAuthorization(start.authorizationServerUrl, {
      ...(start.metadata ? { metadata: start.metadata } : {}),
      clientInformation: start.clientInformation,
      authorizationCode: redirect.code,
      ...(redirect.iss ? { iss: redirect.iss } : {}),
      codeVerifier: start.codeVerifier,
      redirectUri: start.redirectUrl,
      resource: start.mcpUrl,
    });
  } catch (error) {
    // The SDK message can echo the request. Keep only the error's name.
    throw new Error(`${capital(server)} did not issue a token (${errorName(error)}).`);
  }
  return toSignInToken(tokens, now, null);
}

// The client facts a later refresh needs, from a finished sign-in.
export function clientOf(start: SignInStart): OAuthClient {
  return {
    mcpUrl: start.mcpUrl,
    authorizationServerUrl: start.authorizationServerUrl,
    ...(start.metadata ? { metadata: start.metadata } : {}),
    clientInformation: start.clientInformation,
  };
}

// Trades the refresh token for a new access token. A server that sends no new refresh token
// keeps the old one valid.
export async function refreshSignIn(
  client: OAuthClient,
  refreshToken: string,
  now: Date = new Date(),
  server = "the server",
): Promise<SignInToken> {
  let tokens: Awaited<ReturnType<typeof refreshAuthorization>>;
  try {
    tokens = await refreshAuthorization(client.authorizationServerUrl, {
      ...(client.metadata ? { metadata: client.metadata } : {}),
      clientInformation: client.clientInformation,
      refreshToken,
      resource: client.mcpUrl,
    });
  } catch (error) {
    throw new Error(`${capital(server)} did not refresh the sign-in (${errorName(error)}).`);
  }
  return toSignInToken(tokens, now, refreshToken);
}

function toSignInToken(
  tokens: {
    access_token: string;
    refresh_token?: string | undefined;
    expires_in?: number | undefined;
  },
  now: Date,
  previousRefresh: string | null,
): SignInToken {
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? previousRefresh,
    expiresAt:
      tokens.expires_in === undefined ? null : new Date(now.getTime() + tokens.expires_in * 1000),
  };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "Error";
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// An OAuth error code is a short ASCII word. Anything else is cut, so a reflected value cannot
// put arbitrary text in a Slack message.
function safeWord(value: string): string {
  return /^[\w.-]{1,64}$/.test(value) ? value : "unknown error";
}
