// Pure rules for the in-app worker sign-in (decision 036). No I/O and no Node built-ins, so the
// `worker_sign_in` workflow body and the tests can use them.
import { callbackFor } from "../jobs/callback.ts";

// Eve's Slack channel gives a person this authenticator, and the Slack user ID in
// `attributes.user_id` (defaultSlackAuth).
const SLACK_AUTHENTICATOR = "slack-webhook";
const WORKER_PRINCIPAL = "sym-worker";

export interface SignInCaller {
  principalId?: string;
  principalType?: string;
  authenticator?: string;
  attributes?: Record<string, unknown>;
}

export type CallerCheck = { ok: true; owner: string } | { ok: false; reason: string };

// Only the owner can sign Sym in: the pack owner, else SYM_OWNER_SLACK_USER. A worker thread,
// a schedule, another person, and a deployment without an owner are all refused.
export function checkSignInCaller(
  caller: SignInCaller | null | undefined,
  owner: string | undefined,
): CallerCheck {
  if (caller?.principalId === WORKER_PRINCIPAL) {
    return { ok: false, reason: "Worker threads cannot call this tool." };
  }
  if (!owner) {
    return {
      ok: false,
      reason:
        "The deployment names no owner. Set the pack owner or SYM_OWNER_SLACK_USER, then ask again.",
    };
  }
  const userId = caller?.attributes?.user_id;
  if (
    caller?.authenticator !== SLACK_AUTHENTICATOR ||
    caller.principalType !== "user" ||
    userId !== owner
  ) {
    return { ok: false, reason: "Only the owner can sign Sym in to a worker." };
  }
  return { ok: true, owner };
}

export type RedirectCheck = { ok: true; url: string } | { ok: false; reason: string };

// The redirect target is Eve's webhook, rebased on an address the owner's browser can reach:
// SYM_SIGNIN_URL, else SYM_CALLBACK_URL. T3 accepts https, or http on a loopback host.
export function signInRedirect(
  webhookUrl: string,
  env: Record<string, string | undefined>,
): RedirectCheck {
  const base = env.SYM_SIGNIN_URL?.trim() || env.SYM_CALLBACK_URL?.trim() || undefined;
  let url: URL;
  try {
    url = new URL(callbackFor(webhookUrl, base));
  } catch {
    return { ok: false, reason: "SYM_SIGNIN_URL is not a valid URL." };
  }
  if (url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url.hostname))) {
    return { ok: true, url: url.toString() };
  }
  return {
    ok: false,
    reason:
      "T3 needs an https sign-in address. Set SYM_SIGNIN_URL to an https base the owner's " +
      "browser can reach, such as Sym's Tailscale HTTPS name (docs/self-hosting.md).",
  };
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "[::1]" ||
    hostname === "::1" ||
    /^127(\.\d{1,3}){3}$/.test(hostname)
  );
}

// The plain page the owner's browser shows after T3 redirects to Sym. The exchange runs after
// the page answers, so the page sends the owner back to Slack for the result.
export const SIGNED_IN_PAGE = [
  "<!doctype html>",
  '<html lang="en"><head><meta charset="utf-8"><title>Sym</title></head>',
  "<body><p>Sym received your approval. You can close this tab.</p>",
  "<p>Sym confirms the sign-in in Slack.</p></body></html>",
].join("");
