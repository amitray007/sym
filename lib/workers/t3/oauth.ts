// The T3 OAuth sign-in (decision 036): discovery, dynamic client registration, PKCE, the RFC 9207
// issuer check, and the token exchange. `pnpm t3:login` and the `worker_sign_in` tool share it.
// The tool calls these functions only inside `"use step"` functions.
//
// T3 facts: the issuer and endpoints derive from the request origin; registration is stateless;
// a redirect URI must be https unless it is loopback; `resource` must equal the MCP URL; a code
// lives 60 seconds; there is no refresh token; a token lasts 30 days. The owner picks the access
// level on T3's consent page (decision 009).
//
// Nothing here logs. Errors never hold the code, the code verifier, or the token.
import {
  type AuthorizationServerMetadata,
  discoverOAuthServerInfo,
  exchangeAuthorization,
  type OAuthClientInformationMixed,
  registerClient,
  startAuthorization,
} from "@modelcontextprotocol/client";

export const T3_SCOPE = "orchestration:read orchestration:operate";

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
  expiresAt: Date | null;
}

// A random state value. Web Crypto, so the module has no Node built-in imports.
export function newState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Discovers the authorization server, registers Sym for this redirect URL, and builds the
// authorization URL. Each sign-in registers again: T3 registration is stateless.
export async function beginSignIn(input: {
  mcpUrl: string;
  redirectUrl: string;
  state: string;
}): Promise<SignInStart> {
  const { mcpUrl, redirectUrl, state } = input;
  const { authorizationServerUrl, authorizationServerMetadata: metadata } =
    await discoverOAuthServerInfo(mcpUrl);
  const clientInformation = await registerClient(authorizationServerUrl, {
    ...(metadata ? { metadata } : {}),
    clientMetadata: {
      client_name: "Sym",
      redirect_uris: [redirectUrl],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
  });
  const { authorizationUrl, codeVerifier } = await startAuthorization(authorizationServerUrl, {
    ...(metadata ? { metadata } : {}),
    clientInformation,
    redirectUrl,
    scope: T3_SCOPE,
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
// the RFC 9207 issuer. Pure, so tests cover each case. The reason never holds the code.
export function readRedirect(
  params: URLSearchParams,
  expected: { state: string; metadata?: AuthorizationServerMetadata | undefined },
): RedirectResult {
  if (params.get("state") !== expected.state) return { kind: "ignore" };
  const error = params.get("error");
  if (error) return { kind: "refused", reason: `T3 refused the sign-in: ${safeWord(error)}.` };
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
    // The SDK message names the OAuth error. Keep only its first line, never the request.
    const name = error instanceof Error ? error.name : "Error";
    throw new Error(`T3 did not issue a token (${name}).`);
  }
  return {
    accessToken: tokens.access_token,
    expiresAt:
      tokens.expires_in === undefined ? null : new Date(now.getTime() + tokens.expires_in * 1000),
  };
}

// An OAuth error code is a short ASCII word. Anything else is cut, so a reflected value cannot
// put arbitrary text in a Slack message.
function safeWord(value: string): string {
  return /^[\w.-]{1,64}$/.test(value) ? value : "unknown error";
}
