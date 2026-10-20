import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkSignInCaller, signInRedirect } from "../lib/workers/sign-in.ts";
import { t3Adapter } from "../lib/workers/t3/adapter.ts";
import { connectT3 } from "../lib/workers/t3/client.ts";
import { beginSignIn, finishSignIn, newState, readRedirect } from "../lib/workers/t3/oauth.ts";
import { type FakeT3, startFakeT3 } from "./fakes/t3-server.ts";

// The in-app worker sign-in (decision 036): the pure rules, then the OAuth flow on the real
// wire against the fake T3 server.

const OWNER = "UOWNER";
const slackUser = (userId: string) => ({
  authenticator: "slack-webhook",
  principalType: "user",
  principalId: `slack:T1:${userId}`,
  attributes: { user_id: userId },
});

describe("checkSignInCaller", () => {
  it("lets the owner sign in", () => {
    expect(checkSignInCaller(slackUser(OWNER), OWNER)).toEqual({ ok: true, owner: OWNER });
  });

  it("refuses worker threads, other people, schedules, and anonymous callers", () => {
    const refusals = [
      checkSignInCaller({ principalId: "sym-worker", attributes: {} }, OWNER),
      checkSignInCaller(slackUser("UOTHER"), OWNER),
      checkSignInCaller(
        { authenticator: "app", principalId: "eve:app", principalType: "runtime" },
        OWNER,
      ),
      checkSignInCaller(null, OWNER),
      // A bot in Slack is a service, even with the owner's user ID in its attributes.
      checkSignInCaller({ ...slackUser(OWNER), principalType: "service" }, OWNER),
    ];
    for (const result of refusals) expect(result.ok).toBe(false);
    expect(refusals[0]).toEqual({ ok: false, reason: "Worker threads cannot call this tool." });
  });

  it("refuses everyone when the deployment names no owner", () => {
    const result = checkSignInCaller(slackUser(OWNER), undefined);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/SYM_OWNER_SLACK_USER/);
  });
});

describe("signInRedirect", () => {
  const hook = "http://localhost:3000/.well-known/workflow/v1/webhook/tok123";

  it("rebases the webhook on SYM_SIGNIN_URL, then SYM_CALLBACK_URL", () => {
    expect(
      signInRedirect(hook, {
        SYM_SIGNIN_URL: "https://sym.example.ts.net/",
        SYM_CALLBACK_URL: "http://100.64.0.1:3000",
      }),
    ).toEqual({
      ok: true,
      url: "https://sym.example.ts.net/.well-known/workflow/v1/webhook/tok123",
    });
    expect(signInRedirect(hook, { SYM_CALLBACK_URL: "https://sym.example.net" })).toEqual({
      ok: true,
      url: "https://sym.example.net/.well-known/workflow/v1/webhook/tok123",
    });
  });

  it("accepts http only on a loopback host", () => {
    expect(signInRedirect(hook, {}).ok).toBe(true);
    expect(signInRedirect(hook, { SYM_SIGNIN_URL: "http://127.0.0.1:3000" }).ok).toBe(true);
    const plain = signInRedirect(hook, { SYM_CALLBACK_URL: "http://100.64.0.1:3000" });
    expect(plain.ok).toBe(false);
    expect(!plain.ok && plain.reason).toMatch(/SYM_SIGNIN_URL/);
  });
});

describe("readRedirect", () => {
  const expected = {
    state: "s1",
    metadata: {
      issuer: "https://worker.example",
      authorization_endpoint: "https://worker.example/oauth/authorize",
      token_endpoint: "https://worker.example/oauth/token",
      response_types_supported: ["code"],
      authorization_response_iss_parameter_supported: true,
    },
  };
  const read = (query: string) => readRedirect(new URLSearchParams(query), expected);

  it("returns the code for the right state and issuer", () => {
    expect(read("state=s1&code=c1&iss=https%3A%2F%2Fworker.example")).toEqual({
      kind: "code",
      code: "c1",
      iss: "https://worker.example",
    });
  });

  it("ignores a request without this sign-in's state", () => {
    expect(read("code=c1&iss=https%3A%2F%2Fworker.example")).toEqual({ kind: "ignore" });
    expect(read("state=other&code=c1")).toEqual({ kind: "ignore" });
  });

  it("refuses an OAuth error, another issuer, a missing issuer, and a missing code", () => {
    expect(read("state=s1&error=access_denied")).toEqual({
      kind: "refused",
      reason: "The worker refused the sign-in: access_denied.",
    });
    expect(read("state=s1&error=%3Cscript%3E")).toEqual({
      kind: "refused",
      reason: "The worker refused the sign-in: unknown error.",
    });
    expect(read("state=s1&code=c1&iss=https%3A%2F%2Fevil.example").kind).toBe("refused");
    expect(read("state=s1&code=c1").kind).toBe("refused");
    expect(read("state=s1&iss=https%3A%2F%2Fworker.example")).toEqual({
      kind: "refused",
      reason: "The sign-in redirect had no authorization code.",
    });
  });

  it("makes a new random state each time", () => {
    expect(newState()).toMatch(/^[0-9a-f]{32}$/);
    expect(newState()).not.toBe(newState());
  });
});

describe("the OAuth flow against the fake T3", () => {
  let t3: FakeT3;
  const redirectUrl = "http://127.0.0.1:9/.well-known/workflow/v1/webhook/tok";

  beforeAll(async () => {
    t3 = await startFakeT3();
  });
  afterAll(() => t3.close());

  // What the owner's browser does: open the page, approve, and follow the redirect to Sym.
  async function approve(authorizationUrl: string): Promise<URLSearchParams> {
    const response = await fetch(authorizationUrl, { redirect: "manual" });
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(redirectUrl);
    return location.searchParams;
  }

  it("registers, approves, redeems the code, and the token works on the MCP endpoint", async () => {
    const start = await beginSignIn({ mcpUrl: t3.url, redirectUrl, state: newState() });
    const authorization = new URL(start.authorizationUrl);
    expect(authorization.searchParams.get("resource")).toBe(t3.url);
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.get("redirect_uri")).toBe(redirectUrl);

    const redirect = readRedirect(await approve(start.authorizationUrl), start);
    if (redirect.kind !== "code") throw new Error(`no code: ${redirect.kind}`);
    expect(redirect.iss).toBe(t3.oauth.issuer);
    const now = new Date("2026-10-20T00:00:00Z");
    const token = await finishSignIn(start, redirect, now);
    expect(t3.oauth.issued).toEqual([token.accessToken]);
    expect(token.expiresAt).toEqual(new Date("2026-11-19T00:00:00Z"));

    const connection = await connectT3({ url: t3.url, getToken: async () => token.accessToken });
    try {
      expect(await t3Adapter(connection.call).projects()).toHaveLength(1);
    } finally {
      await connection.close();
    }
    expect(t3.oauth.oauthCalls).toBeGreaterThan(0);
  });

  it("does not redeem a code twice, and the error holds no secret", async () => {
    const start = await beginSignIn({ mcpUrl: t3.url, redirectUrl, state: newState() });
    const redirect = readRedirect(await approve(start.authorizationUrl), start);
    if (redirect.kind !== "code") throw new Error("no code");
    await finishSignIn(start, redirect);
    const error = await finishSignIn(start, redirect).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    const text = `${(error as Error).message}\n${(error as Error).stack}`;
    expect(text).not.toContain(redirect.code);
    expect(text).not.toContain(start.codeVerifier);
  });

  it("reports a refused consent and a wrong issuer", async () => {
    t3.oauth.denyNext();
    const denied = await beginSignIn({ mcpUrl: t3.url, redirectUrl, state: newState() });
    expect(readRedirect(await approve(denied.authorizationUrl), denied)).toEqual({
      kind: "refused",
      reason: "The worker refused the sign-in: access_denied.",
    });

    t3.oauth.wrongIssuerNext("http://127.0.0.1:1");
    const wrong = await beginSignIn({ mcpUrl: t3.url, redirectUrl, state: newState() });
    expect(readRedirect(await approve(wrong.authorizationUrl), wrong).kind).toBe("refused");
  });

  it("refuses a plain-http redirect that is not loopback at registration", async () => {
    await expect(
      beginSignIn({ mcpUrl: t3.url, redirectUrl: "http://100.64.0.1/cb", state: newState() }),
    ).rejects.toThrow();
  });
});
