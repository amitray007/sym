/**
 * Channel → persona overrides — a small, UNENCRYPTED SQLite store, separate from
 * the encrypted credential store (which mandates SYM_ENCRYPTION_KEY; a non-secret
 * channel→voice mapping shouldn't require a key).
 *
 * Lets a deployment home specific Slack channels to a non-default voice
 * (e.g. #exec → concierge). The `sym persona set/unset` CLI writes it; the agent
 * reads it per turn to resolve the effective home voice. Persona ids are stored
 * as OPAQUE strings — validation ("is this a real voice?") happens at the read
 * site in the agent, so this layer stays persona-agnostic (no @sym/kernel dep).
 *
 * DB path: SYM_SETTINGS_DB_PATH env, default `<cwd>/.sym/settings.db`. No WAL
 * (written rarely, so the persistent -wal/-shm sidecars aren't worth it); a short
 * busy_timeout lets the agent (reader) and the CLI (writer) — separate processes
 * on the same file — wait out each other's writes instead of erroring.
 */

import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DEFAULT_SETTINGS_DIR = `${process.cwd()}/.sym`;
const DEFAULT_SETTINGS_FILE = 'settings.db';

/** One channel→persona override row. */
export interface ChannelPersona {
  channelId: string;
  /** Stored verbatim; may be a persona id or (if a voice was later removed) stale. */
  persona: string;
  /** unix epoch seconds of the last write. */
  updatedAt: number;
}

export class ChannelPersonaStore {
  private readonly db: DatabaseSync;

  /** @param dbPath SQLite file path or `:memory:` (tests). Defaults to
   *  `SYM_SETTINGS_DB_PATH`, then `<cwd>/.sym/settings.db`. */
  constructor(dbPath?: string) {
    const resolvedPath =
      dbPath ??
      process.env['SYM_SETTINGS_DB_PATH'] ??
      `${DEFAULT_SETTINGS_DIR}/${DEFAULT_SETTINGS_FILE}`;

    if (resolvedPath !== ':memory:') {
      try {
        mkdirSync(dirname(resolvedPath), { recursive: true, mode: 0o700 });
      } catch {
        // Ignore — will fail on open if truly unwritable.
      }
    }

    this.db = new DatabaseSync(resolvedPath);

    if (resolvedPath !== ':memory:') {
      try {
        // The agent (reader) and CLI (writer) are separate processes on this
        // file; busy_timeout lets a read briefly wait out a concurrent write
        // rather than erroring. No WAL — this store is written only occasionally,
        // so it's not worth the persistent -wal/-shm sidecar files.
        this.db.exec('PRAGMA busy_timeout = 2000');
      } catch {
        // Non-fatal.
      }
      try {
        chmodSync(resolvedPath, 0o600);
      } catch {
        // Non-fatal.
      }
    }

    this._migrate();
  }

  private _migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS channel_personas (
        channel_id  TEXT PRIMARY KEY,
        persona     TEXT NOT NULL,
        updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `);
  }

  /** The persona override set for `channelId`, or undefined if none. */
  get(channelId: string): string | undefined {
    const row = this.db
      .prepare('SELECT persona FROM channel_personas WHERE channel_id = ?')
      .get(channelId) as { persona: string } | undefined;
    return row?.persona;
  }

  /** Set (or replace) the override for `channelId`. */
  set(channelId: string, persona: string): void {
    this.db
      .prepare(
        `INSERT INTO channel_personas (channel_id, persona, updated_at)
         VALUES (?, ?, unixepoch())
         ON CONFLICT (channel_id) DO UPDATE SET
           persona    = excluded.persona,
           updated_at = excluded.updated_at`,
      )
      .run(channelId, persona);
  }

  /** Remove the override for `channelId`; true when a row was deleted. */
  remove(channelId: string): boolean {
    const res = this.db.prepare('DELETE FROM channel_personas WHERE channel_id = ?').run(channelId);
    return Number(res.changes) > 0;
  }

  /** All overrides, most-recently-updated first. */
  list(): ChannelPersona[] {
    const rows = this.db
      .prepare(
        'SELECT channel_id, persona, updated_at FROM channel_personas ORDER BY updated_at DESC',
      )
      .all() as { channel_id: string; persona: string; updated_at: number }[];
    return rows.map((r) => ({
      channelId: r.channel_id,
      persona: r.persona,
      updatedAt: r.updated_at,
    }));
  }

  close(): void {
    this.db.close();
  }
}

let _store: ChannelPersonaStore | undefined;

/** Process-wide singleton, opened lazily on first use. */
export function getChannelPersonaStore(): ChannelPersonaStore {
  if (_store === undefined) _store = new ChannelPersonaStore();
  return _store;
}

/** Test-only: close + drop the singleton so the next getter re-opens. */
export function _resetChannelPersonaStoreForTesting(): void {
  if (_store !== undefined) {
    _store.close();
    _store = undefined;
  }
}
