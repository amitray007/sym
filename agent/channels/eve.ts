import { timingSafeEqual } from "node:crypto";
import { type AuthFn, extractBearerToken, localDev, withAuthChallenges } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

// Compare in constant time. Padding gives both sides the same length.
function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  const length = Math.max(a.length, b.length, 1);
  const pad = (buffer: Buffer) => Buffer.concat([buffer, Buffer.alloc(length - buffer.length)]);
  return timingSafeEqual(pad(a), pad(b)) && a.length === b.length;
}

// Static bearer token for scripts, CI, and operators. Fails closed: with no
// SYM_API_TOKEN set, it accepts nothing. The token is read per request.
function symApiToken(): AuthFn<Request> {
  return withAuthChallenges(
    (request) => {
      const expected = process.env.SYM_API_TOKEN;
      if (!expected) return null;
      const given = extractBearerToken(request.headers.get("authorization"));
      if (!given || !sameToken(given, expected)) return null;
      return {
        attributes: {},
        authenticator: "sym-api-token",
        principalId: "sym-operator",
        principalType: "service",
      };
    },
    [{ scheme: "Bearer" }],
  );
}

// Eval sessions replace tools with stubs (evals/, decision 039). Eve allows that only when the
// route auth grants it, so the grant goes on the dev-server caller alone. `localDev` accepts
// nobody in production, so a deployed Sym never allows stubs.
const devAuth = localDev();
const localDevWithStubs: AuthFn<Request> = async (request) => {
  const caller = await devAuth(request);
  return caller ? { ...caller, allowToolStubs: true } : null;
};

export default eveChannel({
  auth: [
    symApiToken(),
    // Open on localhost for `eve dev`, the REPL, and `eve eval`; ignored in production.
    localDevWithStubs,
  ],
});
