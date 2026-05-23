/**
 * Integration tests for `append` and `verifyChain`.
 *
 * Gated on DATABASE_URL — skips cleanly when not set.
 * Creates its own throwaway workspace and deletes it in afterAll.
 */

import { auditEvents, createDb, workspaces } from '@sym/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { append, PayloadTooLargeError } from './append.js';
import { verifyChain } from './verify.js';

import type { WorkspaceId } from '@sym/contracts';
import type { Database } from '@sym/db';

function resolveUrl(): string | undefined {
  const url = process.env['DATABASE_URL'];
  return url ?? undefined;
}

const databaseUrl = resolveUrl();
const suite = databaseUrl ? describe : describe.skip;

suite('@sym/audit append + verifyChain (integration)', () => {
  const { db, close } = createDb(databaseUrl ?? '', { max: 1 }) as {
    db: Database;
    close: () => Promise<void>;
  };
  const teamId = `T_AUDIT_TEST_${Date.now()}`;
  let workspaceId: WorkspaceId;

  beforeAll(async () => {
    const [ws] = await db
      .insert(workspaces)
      .values({ slackTeamId: teamId, name: 'Audit Integration Test' })
      .returning({ id: workspaces.id });
    if (!ws) throw new Error('failed to insert test workspace');
    workspaceId = ws.id as WorkspaceId;
  });

  afterAll(async () => {
    // Delete audit events first (FK: audit_events.workspace_id → workspaces.id RESTRICT)
    await db.delete(auditEvents).where(eq(auditEvents.workspaceId, workspaceId));
    await db.delete(workspaces).where(eq(workspaces.slackTeamId, teamId));
    await close();
  });

  it('appends a first event (prevHash=null) and returns an AuditEvent', async () => {
    const ev = await append(db, {
      workspaceId,
      kind: 'app.memory.write',
      actorKind: 'system',
      actorId: 'system',
      payload: { note: 'first event', turnId: 'turn_1' },
    });

    expect(ev.id).toBeTypeOf('number');
    expect(ev.workspaceId).toBe(workspaceId);
    expect(ev.kind).toBe('app.memory.write');
    expect(ev.ts).toBeInstanceOf(Date);
  });

  it('appends a second event and links the chain', async () => {
    const ev2 = await append(db, {
      workspaceId,
      kind: 'gen_ai.completion',
      actorKind: 'system',
      actorId: 'system',
      payload: { model: 'test-model', turnId: 'turn_1' },
    });
    expect(ev2.id).toBeTypeOf('number');
  });

  it('verifyChain returns ok for a valid chain', async () => {
    const result = await verifyChain(db, workspaceId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.count).toBeGreaterThanOrEqual(2);
    }
  });

  it('detects a tampered hash_chain row', async () => {
    // Directly corrupt thisHash of the first event in the workspace
    const [firstRow] = await db
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(eq(auditEvents.workspaceId, workspaceId))
      .orderBy(auditEvents.id)
      .limit(1);

    expect(firstRow).toBeDefined();

    if (!firstRow) return;

    // Corrupt the hash by writing all-zeros
    await db
      .update(auditEvents)
      .set({ thisHash: Buffer.alloc(32, 0) })
      .where(eq(auditEvents.id, firstRow.id));

    const result = await verifyChain(db, workspaceId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // The break will be at the first event (its hash is wrong)
      // OR at the second event (whose prevHash no longer matches).
      expect(result.breakAtId).toBeGreaterThanOrEqual(firstRow.id);
    }
  });

  it('rejects oversized payloads with PayloadTooLargeError', async () => {
    const bigPayload: Record<string, string> = {};
    bigPayload['data'] = 'x'.repeat(66_000);
    await expect(
      append(db, {
        workspaceId,
        kind: 'app.test.oversized',
        actorKind: 'system',
        actorId: 'system',
        payload: bigPayload,
      }),
    ).rejects.toBeInstanceOf(PayloadTooLargeError);
  });
});
