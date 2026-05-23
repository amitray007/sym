/**
 * Lease issuer — called before sandbox spawn to write a `leases` row.
 *
 * Each call creates ONE lease for (requester, provider, domain), referencing
 * the chosen `oauth_tokens.id`. The proxy resolves the real token from that id.
 *
 * Security invariant: the real token is NEVER passed through here. Only the
 * `oauthTokenId` (a FK to the encrypted `oauth_tokens.access_token` column) is
 * stored. The proxy reads the decrypted token directly from @sym/db on demand.
 *
 * When acting on behalf of another user (`onBehalfOf`), a `grantId` must be
 * supplied — the issuer does NOT enforce grant validity (that is the
 * caller's responsibility before invoking issue()); it only records the ref.
 *
 * The issued LeaseRef is also placed in the hot LeaseStore so the proxy can
 * serve it without a DB round-trip during the turn.
 */

import { leases } from '@sym/db';
import { eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';

import type { LeaseStore } from './lease-store.js';
import type {
  GrantId,
  LeaseId,
  LeaseRef,
  OAuthTokenId,
  SandboxError,
  SandboxJwtId,
  SlackUserId,
  WorkspaceId,
} from '@sym/contracts';
import type { Database } from '@sym/db';

export interface IssueLeaseParams {
  workspaceId: WorkspaceId;
  turnId: string;
  sandboxJwtId: SandboxJwtId;
  requester: SlackUserId;
  provider: string;
  domain: string;
  oauthTokenId: OAuthTokenId;
  /** Set when acting on behalf of another user. */
  onBehalfOf?: SlackUserId;
  /** Required when onBehalfOf is set. */
  grantId?: GrantId;
  /** How long the lease is valid (ms). Defaults to 15 minutes. */
  ttlMs?: number;
}

export type IssueLeaseResult = { ok: true; lease: LeaseRef } | { ok: false; error: SandboxError };

const DEFAULT_TTL_MS = 15 * 60 * 1000;

export class LeaseIssuer {
  constructor(
    private readonly db: Database,
    private readonly store: LeaseStore,
  ) {}

  /**
   * Issue a new turn-scoped lease. Writes a `leases` row in Postgres and
   * stores the ref in the hot LeaseStore. Returns the LeaseRef on success.
   */
  async issue(params: IssueLeaseParams): Promise<IssueLeaseResult> {
    const expiresAt = new Date(Date.now() + (params.ttlMs ?? DEFAULT_TTL_MS));
    const id = uuidv7() as LeaseId;

    try {
      await this.db.insert(leases).values({
        id,
        workspaceId: params.workspaceId,
        turnId: params.turnId,
        sandboxJwtId: params.sandboxJwtId,
        requesterSlackUserId: params.requester,
        provider: params.provider,
        domain: params.domain,
        oauthTokenId: params.oauthTokenId,
        onBehalfOfSlackUserId: params.onBehalfOf ?? null,
        grantId: params.grantId ?? null,
        expiresAt,
      });
    } catch (cause) {
      return {
        ok: false,
        error: {
          domain: 'sandbox',
          code: 'spawn_failed',
          message: `Failed to write lease to Postgres: ${String(cause)}`,
          cause,
        },
      };
    }

    const lease: LeaseRef = {
      leaseId: id,
      sandboxJwtId: params.sandboxJwtId,
      provider: params.provider,
      domain: params.domain,
      oauthTokenId: params.oauthTokenId,
      expiresAt,
      ...(params.onBehalfOf !== undefined ? { onBehalfOf: params.onBehalfOf } : {}),
      ...(params.grantId !== undefined ? { grantId: params.grantId } : {}),
    };

    this.store.put(lease);
    return { ok: true, lease };
  }

  /**
   * Load an existing lease from Postgres into the hot store (e.g. after a
   * process restart or cross-process lookup).
   */
  async load(sandboxJwtId: SandboxJwtId): Promise<LeaseRef | undefined> {
    const rows = await this.db
      .select()
      .from(leases)
      .where(eq(leases.sandboxJwtId, sandboxJwtId as string))
      .limit(1);

    const row = rows[0];
    if (!row) return undefined;

    const lease: LeaseRef = {
      leaseId: row.id as LeaseId,
      sandboxJwtId: row.sandboxJwtId as SandboxJwtId,
      provider: row.provider,
      domain: row.domain,
      oauthTokenId: row.oauthTokenId as OAuthTokenId,
      expiresAt: row.expiresAt,
      ...(row.onBehalfOfSlackUserId != null
        ? { onBehalfOf: row.onBehalfOfSlackUserId as SlackUserId }
        : {}),
      ...(row.grantId != null ? { grantId: row.grantId as GrantId } : {}),
    };

    this.store.put(lease);
    return lease;
  }
}
