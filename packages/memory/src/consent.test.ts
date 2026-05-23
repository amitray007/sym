/**
 * Consent flow tests — DB-gated.
 *
 * Verifies that pending custom_relational rows are invisible until accepted,
 * and that reject makes them permanently invisible.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { acceptConsent, pendingForSubject, rejectConsent, requestConsent } from './consent.js';
import { getMemories } from './gate.js';

import type { MemoryEntry, WorkspaceId } from '@sym/contracts';
import type { Database } from '@sym/db';

const databaseUrl = process.env['DATABASE_URL'];
const suite = databaseUrl != null ? describe : describe.skip;

suite('@sym/memory consent integration', () => {
  let db: Database;
  let closeDb: () => Promise<void>;
  let workspaceId: WorkspaceId;
  const teamId = `T_CONSENT_TEST_${Date.now()}`;

  beforeAll(async () => {
    const { createDb, workspaces } = await import('@sym/db');
    const handle = createDb(databaseUrl ?? '', { max: 1 });
    db = handle.db;
    closeDb = handle.close;

    const [ws] = await db
      .insert(workspaces)
      .values({ slackTeamId: teamId, name: 'Consent Integration Test' })
      .returning({ id: workspaces.id });
    if (!ws) throw new Error('failed to insert test workspace');
    workspaceId = ws.id as WorkspaceId;
  });

  afterAll(async () => {
    const { workspaces, auditEvents, memoryEntries } = await import('@sym/db');
    const { eq } = await import('drizzle-orm');
    // audit_events FK is RESTRICT — clear it (and memory_entries) before the
    // workspace, or the delete fails.
    await db.delete(auditEvents).where(eq(auditEvents.workspaceId, workspaceId));
    await db.delete(memoryEntries).where(eq(memoryEntries.workspaceId, workspaceId));
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await closeDb();
  });

  it('pending row is invisible to all requesters via gate', async () => {
    const entry = await requestConsent(db, {
      workspaceId,
      actorId: 'U_alice' as MemoryEntry['actorId'],
      subjectId: 'U_bob' as MemoryEntry['subjectId'],
      content: 'Bob is the backend lead',
    });
    expect(entry.subjectConsentStatus).toBe('pending');

    // Neither Alice, Bob, nor Charlie can see it via retrieval gate.
    for (const requester of ['U_alice', 'U_bob', 'U_charlie']) {
      const result = await getMemories(db, {
        workspaceId,
        requester: requester as MemoryEntry['actorId'],
        scopes: ['custom_relational'],
      });
      const found = result.find((e) => e.id === entry.id);
      expect(found).toBeUndefined();
    }
  });

  it('pendingForSubject lists pending rows for the subject', async () => {
    const entry = await requestConsent(db, {
      workspaceId,
      actorId: 'U_alice' as MemoryEntry['actorId'],
      subjectId: 'U_dave' as MemoryEntry['subjectId'],
      content: 'Dave prefers async communication',
    });

    const pending = await pendingForSubject(db, workspaceId, 'U_dave' as MemoryEntry['actorId']);
    expect(pending.some((e) => e.id === entry.id)).toBe(true);
    // Charlie's pending list is empty.
    const charliePending = await pendingForSubject(
      db,
      workspaceId,
      'U_charlie' as MemoryEntry['actorId'],
    );
    expect(charliePending.find((e) => e.id === entry.id)).toBeUndefined();
  });

  it('acceptConsent makes the row visible to grantor and subject', async () => {
    const entry = await requestConsent(db, {
      workspaceId,
      actorId: 'U_alice' as MemoryEntry['actorId'],
      subjectId: 'U_eve' as MemoryEntry['subjectId'],
      content: 'Eve is the designer',
    });

    await acceptConsent(db, workspaceId, entry.id, 'U_eve' as MemoryEntry['actorId']);

    // Alice can now see it.
    const aliceResult = await getMemories(db, {
      workspaceId,
      requester: 'U_alice' as MemoryEntry['actorId'],
      scopes: ['custom_relational'],
    });
    expect(aliceResult.some((e) => e.id === entry.id)).toBe(true);

    // Eve can now see it.
    const eveResult = await getMemories(db, {
      workspaceId,
      requester: 'U_eve' as MemoryEntry['actorId'],
      scopes: ['custom_relational'],
    });
    expect(eveResult.some((e) => e.id === entry.id)).toBe(true);

    // Charlie still cannot.
    const charlieResult = await getMemories(db, {
      workspaceId,
      requester: 'U_charlie' as MemoryEntry['actorId'],
      scopes: ['custom_relational'],
    });
    expect(charlieResult.find((e) => e.id === entry.id)).toBeUndefined();
  });

  it('rejectConsent makes the row permanently invisible', async () => {
    const entry = await requestConsent(db, {
      workspaceId,
      actorId: 'U_alice' as MemoryEntry['actorId'],
      subjectId: 'U_frank' as MemoryEntry['subjectId'],
      content: 'Frank hates code reviews',
    });

    await rejectConsent(db, workspaceId, entry.id, 'U_frank' as MemoryEntry['actorId']);

    // No one can see it now.
    for (const requester of ['U_alice', 'U_frank', 'U_charlie']) {
      const result = await getMemories(db, {
        workspaceId,
        requester: requester as MemoryEntry['actorId'],
        scopes: ['custom_relational'],
      });
      expect(result.find((e) => e.id === entry.id)).toBeUndefined();
    }
  });

  it('acceptConsent throws when called with wrong subjectId', async () => {
    const entry = await requestConsent(db, {
      workspaceId,
      actorId: 'U_alice' as MemoryEntry['actorId'],
      subjectId: 'U_grace' as MemoryEntry['subjectId'],
      content: 'Grace is in sales',
    });

    // Charlie tries to accept a consent request they are not the subject of.
    await expect(
      acceptConsent(db, workspaceId, entry.id, 'U_charlie' as MemoryEntry['actorId']),
    ).rejects.toThrow('no pending memory');
  });
});
