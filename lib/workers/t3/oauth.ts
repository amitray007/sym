// The T3 OAuth sign-in (decision 036). `pnpm t3:login` and the `worker_sign_in` tool use it. The
// flow itself lives in lib/oauth.ts, which connection sign-ins share (decision 045). The tool
// calls these functions only inside `"use step"` functions.
//
// T3 facts: the issuer and endpoints derive from the request origin; registration is stateless;
// a redirect URI must be https unless it is loopback; `resource` must equal the MCP URL; a code
// lives 60 seconds; there is no refresh token; a token lasts 30 days. The owner picks the access
// level on T3's consent page (decision 009).

import {
  beginSignIn as begin,
  finishSignIn as finish,
  type RedirectResult,
  readRedirect as read,
  type SignInStart,
  type SignInToken,
} from "../../oauth.ts";
import { workerNoun } from "../../worker-label.ts";

export { newState, type SignInStart } from "../../oauth.ts";

export const T3_SCOPE = "orchestration:read orchestration:operate";

const server = () => `the ${workerNoun()}`;

// Discovers T3's authorization server, registers Sym for this redirect URL, and builds the
// authorization URL with T3's scopes.
export function beginSignIn(input: {
  mcpUrl: string;
  redirectUrl: string;
  state: string;
}): Promise<SignInStart> {
  return begin({ ...input, scope: T3_SCOPE });
}

export function readRedirect(
  params: URLSearchParams,
  expected: Parameters<typeof read>[1],
): RedirectResult {
  return read(params, expected, server());
}

export function finishSignIn(
  start: SignInStart,
  redirect: { code: string; iss: string | undefined },
  now: Date = new Date(),
): Promise<SignInToken> {
  return finish(start, redirect, now, server());
}
