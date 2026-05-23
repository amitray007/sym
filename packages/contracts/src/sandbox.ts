import type {
  GrantId,
  LeaseId,
  OAuthTokenId,
  SandboxId,
  SandboxJwtId,
  SlackUserId,
  TurnId,
  WorkspaceId,
} from './ids.js';

/**
 * Claims of the short-lived JWT minted per sandbox spawn (S6). Placed in the
 * sandbox env, never written to disk. The egress proxy verifies it and looks
 * up the matching lease — the sandbox itself never holds a real token.
 */
export interface SandboxIdentity {
  sandboxId: SandboxId;
  jti: SandboxJwtId;
  requester: SlackUserId;
  turnId: TurnId;
  /** Unix seconds. */
  nbf: number;
  exp: number;
}

/** What the tool dispatcher passes into a tool execution. */
export interface SandboxContext {
  workspaceId: WorkspaceId;
  identity: SandboxIdentity;
}

/**
 * A turn-scoped credential lease the egress proxy consumes to inject a token
 * for one `(requester, provider, domain)`. Mirrors the `leases` table.
 */
export interface LeaseRef {
  leaseId: LeaseId;
  sandboxJwtId: SandboxJwtId;
  provider: string;
  domain: string;
  oauthTokenId: OAuthTokenId;
  onBehalfOf?: SlackUserId;
  grantId?: GrantId;
  expiresAt: Date;
}

/** An outbound request the sandbox makes through the egress proxy. */
export interface EgressRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
  url: string;
  headers: Record<string, string>;
  body?: Uint8Array;
}
