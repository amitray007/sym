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

export default eveChannel({
  auth: [
    symApiToken(),
    // Open on localhost for `eve dev` and the REPL; ignored in production.
    localDev(),
  ],
});
