/**
 * Retrieval gate — the ONLY sanctioned read path for `memory_entries`.
 *
 * Visibility rules (enforced in code, not in DB, not in prompt):
 *
 * | Scope             | Visible to                                                |
 * |-------------------|-----------------------------------------------------------|
 * | workspace         | All workspace members (any requester)                     |
 * | channel           | Channel members (requester must match scope_key)          |
 * | thread            | Thread participants (requester must match scope_key)      |
 * | dm                | The DM owner only (scope_key === requester)               |
 * | custom_relational | Grantor (actor_id) + subject (subject_id), AND only when  |
 * |                   | subject_consent_status = 'accepted'                       |
 *
 * Only `status = 'active'` rows are returned.
 * `custom_relational` rows with `subject_consent_status != 'accepted'` are
 * ALWAYS invisible — even to the grantor — until the subject accepts.
 *
 * SECURITY: this function is the hard gating boundary. A caller that passes
 * a requester cannot receive memories that requester is not entitled to see.
 */

import { memoryEntries } from '@sym/db';
import { and, eq, inArray } from 'drizzle-orm';

import { rowToEntry } from './row-to-entry.js';

import type { MemoryEntry, MemoryScope, RetrievalRequest } from '@sym/contracts';
import type { Database } from '@sym/db';

/**
 * Retrieve all memory entries the requester is entitled to see.
 *
 * Implements `RetrievalGate.getMemories` from `@sym/contracts`.
 */
export async function getMemories(db: Database, req: RetrievalRequest): Promise<MemoryEntry[]> {
  const { workspaceId, requester, scopes, channelId, threadTs } = req;

  // Determine which scopes to query (default: all)
  const requestedScopes: MemoryScope[] = scopes ?? [
    'workspace',
    'channel',
    'thread',
    'dm',
    'custom_relational',
  ];

  const rows = await db
    .select()
    .from(memoryEntries)
    .where(
      and(
        eq(memoryEntries.workspaceId, workspaceId),
        eq(memoryEntries.status, 'active'),
        inArray(memoryEntries.scope, requestedScopes),
      ),
    );

  // Apply per-scope visibility filter in application code.
  // This is SECURITY-CRITICAL: no row may be returned unless the requester
  // is provably entitled to it.
  const permitted = rows.filter((row) => {
    // Defense-in-depth: enforce the requested-scope narrowing in code too, not
    // only in the SQL WHERE — the gate stays correct even if the query is
    // bypassed or a row of an unrequested scope reaches here.
    if (!requestedScopes.includes(row.scope)) return false;

    switch (row.scope) {
      case 'workspace':
        // Every workspace member can see workspace-scoped memory.
        return true;

      case 'channel':
        // Only members of the channel may see channel memory.
        // The requester proves membership by supplying the matching channelId.
        // If no channelId was provided in the request, channel memories are
        // not returned (safest default: no channelId → not a member claim).
        return channelId != null && row.scopeKey === channelId;

      case 'thread':
        // Only participants of the thread may see thread memory.
        // The requester proves participation by supplying the matching threadTs.
        return threadTs != null && row.scopeKey === threadTs;

      case 'dm':
        // Strictly one user — the owner of this DM entry.
        // scope_key is the slack_user_id of the DM owner.
        return row.scopeKey === requester;

      case 'custom_relational':
        // Only the grantor (actor_id) and the subject (subject_id) may see
        // custom-relational memory, AND only after the subject has accepted.
        if (row.subjectConsentStatus !== 'accepted') return false;
        return row.actorId === requester || row.subjectId === requester;

      default:
        // Unknown scope — deny by default.
        return false;
    }
  });

  return permitted.map(rowToEntry);
}
