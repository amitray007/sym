import { localDev } from "eve/channels/auth";
import { mcpChannel } from "eve/channels/mcp";
import { bearerToken } from "../../lib/bearer-auth.ts";
import { WORKER_PRINCIPAL } from "../../lib/callers.ts";

// The channel worker threads call back into (docs/eve.md). Keep it on a private network.
// SYM_MCP_TOKEN is the worker threads' bearer token.
const symMcpToken = bearerToken({
  variable: "SYM_MCP_TOKEN",
  authenticator: "sym-mcp-token",
  principalId: WORKER_PRINCIPAL,
});

export default mcpChannel({
  auth: [symMcpToken, localDev()],
  // Eve has no allow-list: `tools: true` publishes every plain tool. See the note in docs/eve.md.
  tools: true,
  agent: false,
});
