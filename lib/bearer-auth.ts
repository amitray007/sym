import { timingSafeEqual } from "node:crypto";
import { type AuthFn, extractBearerToken, withAuthChallenges } from "eve/channels/auth";

// Compare in constant time. Padding gives both sides the same length.
function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  const length = Math.max(a.length, b.length, 1);
  const pad = (buffer: Buffer) => Buffer.concat([buffer, Buffer.alloc(length - buffer.length)]);
  return timingSafeEqual(pad(a), pad(b)) && a.length === b.length;
}

// Static bearer token from an environment variable, for a service caller. Fails closed: with the
// variable unset, it accepts nothing. The token is read per request.
export function bearerToken(options: {
  variable: string;
  authenticator: string;
  principalId: string;
}): AuthFn<Request> {
  return withAuthChallenges(
    (request) => {
      const expected = process.env[options.variable];
      if (!expected) return null;
      const given = extractBearerToken(request.headers.get("authorization"));
      if (!given || !sameToken(given, expected)) return null;
      return {
        attributes: {},
        authenticator: options.authenticator,
        principalId: options.principalId,
        principalType: "service",
      };
    },
    [{ scheme: "Bearer" }],
  );
}
