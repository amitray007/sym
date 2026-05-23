/**
 * Integration tests for save/restore checkpoint via DB.
 *
 * Gated on DATABASE_URL — skips cleanly without one.
 */

import { checkpoints, conversations, createDb, workspaces } from '@sym/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CURRENT_CHECKPOINT_VERSION, restoreCheckpoint, saveCheckpoint } from './checkpoint.js';

import type { ConversationId, SliceId, WorkspaceId } from '@sym/contracts';
import type { Database } from '@sym/db';

const databaseUrl = process.env['DATABASE_URL'];
const suite = databaseUrl ? describe : describe.skip;

suite('@sym/tasks checkpoint save/restore (integration)', () => {
  const { db, close } = createDb(databaseUrl ?? '', { max: 3 }) as {
    db: Database;
    close: () => Promise<void>;
  };
  const teamId = `T_TASKS_CP_${Date.now()}`;
  let workspaceId: WorkspaceId;
  let conversationId: ConversationId;

  beforeAll(async () => {
    const [ws] = await db
      .insert(workspaces)
      .values({ slackTeamId: teamId, name: 'Tasks Checkpoint Integration Test' })
      .returning({ id: workspaces.id });
    if (!ws) throw new Error('failed to insert test workspace');
    workspaceId = ws.id as WorkspaceId;

    const [conv] = await db
      .insert(conversations)
      .values({
        workspaceId,
        entrySurface: 'dm',
        initiatorSlackUserId: 'U_TEST_CP',
      })
      .returning({ id: conversations.id });
    if (!conv) throw new Error('failed to insert test conversation');
    conversationId = conv.id as ConversationId;
  });

  afterAll(async () => {
    await db.delete(checkpoints).where(eq(checkpoints.workspaceId, workspaceId));
    await db.delete(conversations).where(eq(conversations.workspaceId, workspaceId));
    await db.delete(workspaces).where(eq(workspaces.slackTeamId, teamId));
    await close();
  });

  it('saves and restores a checkpoint round-trip', async () => {
    const sliceId = `slice_${Date.now()}` as SliceId;
    const state = {
      version: CURRENT_CHECKPOINT_VERSION,
      payload: { messages: ['hello'], turn: 1 },
    };

    const { checkpointId } = await saveCheckpoint(db, {
      workspaceId,
      conversationId,
      sliceId,
      state,
    });
    expect(checkpointId).toBeTruthy();

    const restored = await restoreCheckpoint(db, {
      workspaceId,
      conversationId,
      sliceId,
    });

    expect(restored).not.toBeNull();
    expect(restored?.state.version).toBe(CURRENT_CHECKPOINT_VERSION);
    expect(restored?.state.payload).toEqual(state.payload);
    expect(restored?.checkpointId).toBe(checkpointId);
  });

  it('marks checkpoint consumed after restore (second restore returns null)', async () => {
    const sliceId = `slice_consume_${Date.now()}` as SliceId;

    await saveCheckpoint(db, {
      workspaceId,
      conversationId,
      sliceId,
      state: { version: CURRENT_CHECKPOINT_VERSION, payload: { x: 1 } },
    });

    const first = await restoreCheckpoint(db, { workspaceId, conversationId, sliceId });
    expect(first).not.toBeNull();

    const second = await restoreCheckpoint(db, { workspaceId, conversationId, sliceId });
    expect(second).toBeNull();
  });

  it('upserts when saving the same (conversationId, sliceId) twice', async () => {
    const sliceId = `slice_upsert_${Date.now()}` as SliceId;

    await saveCheckpoint(db, {
      workspaceId,
      conversationId,
      sliceId,
      state: { version: CURRENT_CHECKPOINT_VERSION, payload: { v: 1 } },
    });

    await saveCheckpoint(db, {
      workspaceId,
      conversationId,
      sliceId,
      state: { version: CURRENT_CHECKPOINT_VERSION, payload: { v: 2 } },
    });

    const restored = await restoreCheckpoint(db, { workspaceId, conversationId, sliceId });
    expect(restored?.state.payload['v']).toBe(2);
  });
});
