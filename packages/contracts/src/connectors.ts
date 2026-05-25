import type { McpConfigId, OAuthTokenId, SlackUserId, WorkspaceId } from './ids.js';

/**
 * Connectors — Sym's tool-source platform. A connector is a configured remote
 * MCP server (now) or a local CLI (later). Persisted in the `mcp_configs` table
 * (kept for back-compat; "Connector" is the product/domain name). Per-user
 * credentials live in `oauth_tokens`, keyed by the connector's `slug` as the
 * `provider`. Token values are NEVER exposed to the model.
 */

/** How a connector authenticates to its server. */
export type ConnectorAuthMode =
  /** No auth (open MCP server). */
  | 'none'
  /** A single workspace-shared token (encrypted at rest). */
  | 'static'
  /** Per-user OAuth (RFC 7591 dynamic client registration + PKCE). */
  | 'oauth';

/** `http` = remote Streamable HTTP MCP server; `stdio` = local CLI (deferred). */
export type ConnectorTransport = 'http' | 'stdio';

/** A configured connector (one row of `mcp_configs`). */
export interface Connector {
  id: McpConfigId;
  workspaceId: WorkspaceId;
  /** Display name shown in the dashboard. */
  name: string;
  /** Stable identifier; also the `provider` key for per-user credentials. */
  slug: string;
  transport: ConnectorTransport;
  /** Remote MCP endpoint URL (http transport). */
  url?: string;
  /** Local command (stdio transport / CLI — deferred). */
  command?: string;
  args: string[];
  authMode: ConnectorAuthMode;
  enabled: boolean;
}

/**
 * A per-user credential for an `oauth`-mode connector — mirrors an `oauth_tokens`
 * row (`provider` = the connector's `slug`). Carries only non-secret metadata;
 * the access/refresh tokens stay encrypted and server-side.
 */
export interface ConnectorCredential {
  id: OAuthTokenId;
  workspaceId: WorkspaceId;
  slackUserId: SlackUserId;
  /** The connector slug this credential authorizes. */
  provider: string;
  expiresAt?: Date;
  scopes: string[];
  /** Human-readable account label (e.g. the connected username), if known. */
  accountHandle?: string;
  status: 'active' | 'revoked';
}
