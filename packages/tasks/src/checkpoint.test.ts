/**
 * Hermetic unit tests for checkpoint serialize/deserialize round-trip.
 * No database needed.
 */

import { describe, expect, it } from 'vitest';

import {
  CheckpointVersionError,
  CURRENT_CHECKPOINT_VERSION,
  deserializeCheckpoint,
  serializeCheckpoint,
} from './checkpoint.js';

import type { CheckpointState } from './types.js';

describe('serializeCheckpoint / deserializeCheckpoint', () => {
  it('round-trips a simple payload', () => {
    const state: CheckpointState = {
      version: CURRENT_CHECKPOINT_VERSION,
      payload: { turnId: 'turn_abc', sliceCount: 3, data: [1, 2, 3] },
    };

    const buf = serializeCheckpoint(state);
    const restored = deserializeCheckpoint(buf);

    expect(restored.version).toBe(state.version);
    expect(restored.payload).toEqual(state.payload);
  });

  it('produces a buffer with 4-byte version header', () => {
    const state: CheckpointState = {
      version: CURRENT_CHECKPOINT_VERSION,
      payload: { x: 1 },
    };
    const buf = serializeCheckpoint(state);
    const ver = buf.readUInt32BE(0);
    expect(ver).toBe(CURRENT_CHECKPOINT_VERSION);
  });

  it('round-trips an empty payload', () => {
    const state: CheckpointState = { version: CURRENT_CHECKPOINT_VERSION, payload: {} };
    const restored = deserializeCheckpoint(serializeCheckpoint(state));
    expect(restored.payload).toEqual({});
  });

  it('round-trips a nested payload with unicode', () => {
    const state: CheckpointState = {
      version: CURRENT_CHECKPOINT_VERSION,
      payload: { msg: '日本語テスト 🎉', nested: { a: true } },
    };
    const restored = deserializeCheckpoint(serializeCheckpoint(state));
    expect(restored.payload['msg']).toBe('日本語テスト 🎉');
  });

  it('throws CheckpointVersionError for an unknown version', () => {
    const state: CheckpointState = {
      version: CURRENT_CHECKPOINT_VERSION,
      payload: { x: 1 },
    };
    const buf = serializeCheckpoint(state);
    // Overwrite version to an unknown value
    buf.writeUInt32BE(999, 0);

    expect(() => deserializeCheckpoint(buf)).toThrowError(CheckpointVersionError);
    try {
      deserializeCheckpoint(buf);
    } catch (e) {
      expect(e).toBeInstanceOf(CheckpointVersionError);
      if (e instanceof CheckpointVersionError) {
        expect(e.found).toBe(999);
        expect(e.expected).toBe(CURRENT_CHECKPOINT_VERSION);
      }
    }
  });

  it('throws on a buffer too short for a version header', () => {
    const tiny = Buffer.from([0x00, 0x00]);
    expect(() => deserializeCheckpoint(tiny)).toThrowError(
      'checkpoint: buffer too short to contain version header',
    );
  });
});
