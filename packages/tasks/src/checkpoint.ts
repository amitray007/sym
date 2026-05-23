/**
 * Slice/checkpoint serializer.
 *
 * Kernel state ↔ bytea blob, version-tagged (D-DB-6, starts at 1).
 *
 * Wire format (bytea):
 *   4 bytes  — big-endian uint32 version number
 *   N bytes  — UTF-8 JSON of the payload
 *
 * save() upserts by (conversation_id, slice_id) — UNIQUE index in the DB
 * (checkpoints_conversation_slice). If a row already exists for the same
 * (conversation_id, slice_id) it is replaced (ON CONFLICT DO UPDATE).
 *
 * restore() reads the latest unconsumed checkpoint for (conversationId, sliceId)
 * and marks it consumed (sets consumed_at = now()).
 */

import { checkpoints } from '@sym/db';
import { and, eq, isNull } from 'drizzle-orm';

import type { CheckpointState, RestoreCheckpointResult, SaveCheckpointInput } from './types.js';
import type { ConversationId, SliceId, WorkspaceId } from '@sym/contracts';
import type { Database } from '@sym/db';

export const CURRENT_CHECKPOINT_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

/**
 * Serialize kernel state to a bytea buffer.
 *
 * Layout: [4-byte big-endian version][utf-8 json payload]
 */
export function serializeCheckpoint(state: CheckpointState): Buffer {
  const json = JSON.stringify(state.payload);
  const jsonBuf = Buffer.from(json, 'utf-8');
  const out = Buffer.allocUnsafe(4 + jsonBuf.length);
  out.writeUInt32BE(state.version, 0);
  jsonBuf.copy(out, 4);
  return out;
}

/**
 * Deserialize a bytea buffer back into CheckpointState.
 *
 * Throws `CheckpointVersionError` if the version is unrecognised.
 */
export function deserializeCheckpoint(buf: Buffer): CheckpointState {
  if (buf.length < 4) {
    throw new Error('checkpoint: buffer too short to contain version header');
  }
  const version = buf.readUInt32BE(0);
  if (version !== CURRENT_CHECKPOINT_VERSION) {
    throw new CheckpointVersionError(version, CURRENT_CHECKPOINT_VERSION);
  }
  const json = buf.subarray(4).toString('utf-8');
  const payload = JSON.parse(json) as Record<string, unknown>;
  return { version, payload };
}

export class CheckpointVersionError extends Error {
  constructor(
    public readonly found: number,
    public readonly expected: number,
  ) {
    super(`checkpoint: unsupported version ${found} (expected ${expected})`);
    this.name = 'CheckpointVersionError';
  }
}

// ---------------------------------------------------------------------------
// Persist
// ---------------------------------------------------------------------------

/**
 * Save (upsert) a checkpoint for (conversationId, sliceId).
 *
 * If a row already exists for the same pair, it is overwritten. This supports
 * incremental slice state updates without the caller needing to track whether
 * the row already exists.
 */
export async function saveCheckpoint(
  db: Database,
  input: SaveCheckpointInput,
): Promise<{ checkpointId: string }> {
  const ttlSeconds = input.ttlSeconds ?? 3_600;
  const expiresAt = new Date(Date.now() + ttlSeconds * 1_000);
  const stateBlob = serializeCheckpoint(input.state);

  // Upsert: insert or replace on the unique (conversation_id, slice_id) constraint.
  const [row] = await db
    .insert(checkpoints)
    .values({
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      sliceId: input.sliceId,
      version: input.state.version,
      stateBlob,
      expiresAt,
    })
    .onConflictDoUpdate({
      target: [checkpoints.conversationId, checkpoints.sliceId],
      set: {
        version: input.state.version,
        stateBlob,
        expiresAt,
        consumedAt: null, // Reset consumption on overwrite.
      },
    })
    .returning({ id: checkpoints.id });

  if (!row) {
    throw new Error('checkpoint: upsert returned no row');
  }

  return { checkpointId: row.id };
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

/**
 * Restore (and consume) the checkpoint for (conversationId, sliceId).
 *
 * Returns null if no unconsumed checkpoint exists.
 */
export async function restoreCheckpoint(
  db: Database,
  opts: {
    workspaceId: WorkspaceId;
    conversationId: ConversationId;
    sliceId: SliceId;
  },
): Promise<RestoreCheckpointResult | null> {
  const [row] = await db
    .select({
      id: checkpoints.id,
      stateBlob: checkpoints.stateBlob,
    })
    .from(checkpoints)
    .where(
      and(
        eq(checkpoints.conversationId, opts.conversationId),
        eq(checkpoints.sliceId, opts.sliceId),
        isNull(checkpoints.consumedAt),
      ),
    )
    .limit(1);

  if (!row) return null;

  // Mark consumed.
  await db.update(checkpoints).set({ consumedAt: new Date() }).where(eq(checkpoints.id, row.id));

  const state = deserializeCheckpoint(row.stateBlob as Buffer);
  return { state, checkpointId: row.id };
}
