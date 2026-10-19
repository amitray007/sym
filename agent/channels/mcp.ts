import { timingSafeEqual } from "node:crypto";
import { type AuthFn, extractBearerToken, localDev, withAuthChallenges } from "eve/channels/auth";
import { mcpChannel } from "eve/channels/mcp";
import { WORKER_PRINCIPAL } from "../../lib/callers.ts";

// The channel worker threads call back into (docs/eve.md). Keep it on a private network.

// Compare in constant time. Padding gives both sides the same length.
function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  const length = Math.max(a.length, b.length, 1);
  const pad = (buffer: Buffer) => Buffer.concat([buffer, Buffer.alloc(length - buffer.length)]);
  return timingSafeEqual(pad(a), pad(b)) && a.length === b.length;
}

// Fails closed: with no SYM_MCP_TOKEN set, it accepts nothing. The token is read per request.
function symMcpToken(): AuthFn<Request> {
  return withAuthChallenges(
    (request) => {
      const expected = process.env.SYM_MCP_TOKEN;
      if (!expected) return null;
      const given = extractBearerToken(request.headers.get("authorization"));
      if (!given || !sameToken(given, expected)) return null;
      return {
        attributes: {},
        authenticator: "sym-mcp-token",
        principalId: WORKER_PRINCIPAL,
        principalType: "service",
      };
    },
    [{ scheme: "Bearer" }],
  );
}

export default mcpChannel({
  auth: [symMcpToken(), localDev()],
  // Eve has no allow-list: `tools: true` publishes every plain tool. See the note in docs/eve.md.
  tools: true,
  agent: false,
});
