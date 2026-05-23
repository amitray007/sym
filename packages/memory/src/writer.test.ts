/**
 * Writer tests — DB-gated integration tests.
 *
 * Skip cleanly when DATABASE_URL is not set.
 * Creates a throwaway workspace and deletes it in afterAll.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyDecision } from './writer.js';

import type { ClassifyResult } from './classifier.js';
import type { MemoryEntry, WorkspaceId } from '@sym/contracts';
import type { Database } from '@sym/db';

const databaseUrl = process.env['DATABASE_URL'];
const suite = databaseUrl != null ? describe : describe.skip;

suite('@sym/memory writer integration', () => {
  let db: Database;
  let closeDb: () => Promise<void>;
  let workspaceId: WorkspaceId;
  const teamId = `T_WRITER_TEST_${Date.now()}`;

  beforeAll(async () => {
    const { createDb, workspaces } = await import('@sym/db');
    const handle = createDb(databaseUrl ?? '', { max: 1 });
    db = handle.db;
    closeDb = handle.close;

    const [ws] = await db
      .insert(workspaces)
      .values({ slackTeamId: teamId, name: 'Writer Integration Test' })
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

  it('add: inserts a new memory entry', async () => {
    const result = await applyDecision(
      db,
      {
        workspaceId,
        scope: 'workspace',
        actorId: 'U_alice' as MemoryEntry['actorId'],
        content: 'org prefers ESM modules',
        subjectConsentStatus: 'not_applicable',
      },
      { decision: 'add', reason: 'new fact' } satisfies ClassifyResult,
    );

    expect(result.kind).toBe('inserted');
    if (result.kind === 'inserted') {
      expect(result.entry.content).toBe('org prefers ESM modules');
      expect(result.entry.status).toBe('active');
      expect(result.entry.scope).toBe('workspace');
    }
  });

  it('update: updates content of an existing entry', async () => {
    // First insert.
    const inserted = await applyDecision(
      db,
      {
        workspaceId,
        scope: 'dm',
        scopeKey: 'U_alice',
        actorId: 'U_alice' as MemoryEntry['actorId'],
        content: 'Alice prefers tabs',
        subjectConsentStatus: 'not_applicable',
      },
      { decision: 'add', reason: 'initial' } satisfies ClassifyResult,
    );
    if (inserted.kind !== 'inserted') throw new Error('expected inserted');
    const oldId = inserted.entry.id;

    // Now update it.
    const updated = await applyDecision(
      db,
      {
        workspaceId,
        scope: 'dm',
        scopeKey: 'U_alice',
        actorId: 'U_alice' as MemoryEntry['actorId'],
        content: 'Alice prefers 2-space tabs',
        subjectConsentStatus: 'not_applicable',
      },
      {
        decision: 'update',
        reason: 'sharpened',
        existingId: oldId,
      } satisfies ClassifyResult,
    );

    expect(updated.kind).toBe('updated');
    if (updated.kind === 'updated') {
      expect(updated.entry.id).toBe(oldId);
      expect(updated.entry.content).toBe('Alice prefers 2-space tabs');
    }
  });

  it('supersede: marks old row superseded and inserts new', async () => {
    // Insert original.
    const original = await applyDecision(
      db,
      {
        workspaceId,
        scope: 'workspace',
        actorId: 'U_alice' as MemoryEntry['actorId'],
        content: 'Company HQ is in London',
        subjectConsentStatus: 'not_applicable',
      },
      { decision: 'add', reason: 'original' } satisfies ClassifyResult,
    );
    if (original.kind !== 'inserted') throw new Error('expected inserted');
    const oldId = original.entry.id;

    // Supersede.
    const superseded = await applyDecision(
      db,
      {
        workspaceId,
        scope: 'workspace',
        actorId: 'U_alice' as MemoryEntry['actorId'],
        content: 'Company HQ is in Berlin',
        subjectConsentStatus: 'not_applicable',
      },
      {
        decision: 'supersede',
        reason: 'company moved',
        existingId: oldId,
      } satisfies ClassifyResult,
    );

    expect(superseded.kind).toBe('superseded');
    if (superseded.kind === 'superseded') {
      expect(superseded.oldId).toBe(oldId);
      expect(superseded.entry.content).toBe('Company HQ is in Berlin');
      expect(superseded.entry.supersedesId).toBe(oldId);
      expect(superseded.entry.status).toBe('active');
    }

    // Verify old row is marked superseded in DB.
    const { memoryEntries } = await import('@sym/db');
    const { eq } = await import('drizzle-orm');
    const [oldRow] = await db
      .select()
      .from(memoryEntries)
      .where(eq(memoryEntries.id, oldId as string));
    expect(oldRow?.status).toBe('superseded');
  });

  it('ignore: returns { kind: ignored } and writes nothing', async () => {
    const result = await applyDecision(
      db,
      {
        workspaceId,
        scope: 'workspace',
        actorId: 'U_alice' as MemoryEntry['actorId'],
        content: 'casual comment',
        subjectConsentStatus: 'not_applicable',
      },
      { decision: 'ignore', reason: 'casual' } satisfies ClassifyResult,
    );
    expect(result.kind).toBe('ignored');
  });

  it('update without existingId throws', async () => {
    await expect(
      applyDecision(
        db,
        {
          workspaceId,
          scope: 'workspace',
          actorId: 'U_alice' as MemoryEntry['actorId'],
          content: 'something',
          subjectConsentStatus: 'not_applicable',
        },
        { decision: 'update', reason: 'bad call' } satisfies ClassifyResult,
      ),
    ).rejects.toThrow('existingId');
  });

  it('supersede without existingId throws', async () => {
    await expect(
      applyDecision(
        db,
        {
          workspaceId,
          scope: 'workspace',
          actorId: 'U_alice' as MemoryEntry['actorId'],
          content: 'something',
          subjectConsentStatus: 'not_applicable',
        },
        { decision: 'supersede', reason: 'bad call' } satisfies ClassifyResult,
      ),
    ).rejects.toThrow('existingId');
  });
});
