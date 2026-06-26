/**
 * `CloudRunStore` — the control-tier run-tracking store. UNENCRYPTED `node:sqlite`
 * (routing data only — channel/thread/runId/status — never conversation content,
 * so I-1 holds), mirroring `@sym/mcp-runtime`'s `channel-persona-store` idioms:
 * `:memory:` in tests, `SYM_CLOUD_DB_PATH` env (default `<cwd>/.sym/cloud.db`),
 * `mkdirSync` 0o700, file 0o600, `busy_timeout`, no WAL.
 *
 * The lifecycle (KTD7): an intent row is written BEFORE dispatch (`dispatching`,
 * no runId), patched with the runId once Cursor confirms (`running`), driven to
 * a terminal status by the reconciler, and finally marked delivered once the
 * result reaches Slack. `deliveredAt` guards the Slack side effect, not just the
 * row — so a crash between post and mark re-delivers rather than dropping.
 *
 * `statusText` stores only the short Slack status line (e.g. "opened PR"), never
 * the agent's full natural-language summary (that lives in the GitHub PR body).
 */

import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { CLOUD_RUN_TERMINAL_STATUSES, type CloudRunRecord, type CloudRunStatus } from './types.js';

const DEFAULT_DIR = `${process.cwd()}/.sym`;
const DEFAULT_FILE = 'cloud.db';

interface Row {
  dispatch_id: string;
  run_id: string | null;
  agent_id: string | null;
  channel: string;
  thread_ts: string;
  status: string;
  status_text: string | null;
  pr_url: string | null;
  delivered_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface CloudRunStoreOptions {
  /** SQLite file path or `:memory:` (tests). Defaults to `SYM_CLOUD_DB_PATH`, then `.sym/cloud.db`. */
  dbPath?: string;
  /** Clock seam (ms). Defaults to `Date.now`; tests inject a fake for deterministic timestamps. */
  now?: () => number;
}

/** A fresh intent row, written before dispatch. */
export interface CloudRunIntent {
  dispatchId: string;
  channel: string;
  threadTs: string;
}

/** Terminal-status patch fields. */
export interface CloudRunStatusPatch {
  statusText?: string;
  prUrl?: string;
}

export class CloudRunStore {
  readonly #db: DatabaseSync;
  readonly #now: () => number;

  constructor(options: CloudRunStoreOptions = {}) {
    const resolvedPath =
      options.dbPath ?? process.env['SYM_CLOUD_DB_PATH'] ?? `${DEFAULT_DIR}/${DEFAULT_FILE}`;
    this.#now = options.now ?? (() => Date.now());

    if (resolvedPath !== ':memory:') {
      try {
        mkdirSync(dirname(resolvedPath), { recursive: true, mode: 0o700 });
      } catch {
        // Ignore — will fail on open if truly unwritable.
      }
    }

    this.#db = new DatabaseSync(resolvedPath);

    if (resolvedPath !== ':memory:') {
      try {
        // Separate processes (agent + operator CLI) may share this file; a short
        // busy_timeout waits out a concurrent write rather than erroring. No WAL —
        // low write volume isn't worth the persistent -wal/-shm sidecars.
        this.#db.exec('PRAGMA busy_timeout = 2000');
      } catch {
        // Non-fatal.
      }
      try {
        chmodSync(resolvedPath, 0o600);
      } catch {
        // Non-fatal.
      }
    }

    this.#migrate();
  }

  #migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS cloud_runs (
        dispatch_id  TEXT PRIMARY KEY,
        run_id       TEXT,
        agent_id     TEXT,
        channel      TEXT NOT NULL,
        thread_ts    TEXT NOT NULL,
        status       TEXT NOT NULL,
        status_text  TEXT,
        pr_url       TEXT,
        delivered_at INTEGER,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
      )
    `);
  }

  /** Write the pre-dispatch intent row (`dispatching`). Throws on a duplicate dispatchId. */
  insertIntent(intent: CloudRunIntent): void {
    const ts = this.#now();
    this.#db
      .prepare(
        `INSERT INTO cloud_runs (dispatch_id, channel, thread_ts, status, created_at, updated_at)
         VALUES (?, ?, ?, 'dispatching', ?, ?)`,
      )
      .run(intent.dispatchId, intent.channel, intent.threadTs, ts, ts);
  }

  /** Patch in the Cursor identifiers once dispatch is confirmed; flips to `running`. */
  patchDispatched(dispatchId: string, ids: { runId: string; agentId: string }): void {
    this.#db
      .prepare(
        `UPDATE cloud_runs
         SET run_id = ?, agent_id = ?, status = 'running', updated_at = ?
         WHERE dispatch_id = ?`,
      )
      .run(ids.runId, ids.agentId, this.#now(), dispatchId);
  }

  /** Update the run's status (+ optional short status text / PR url). */
  markStatus(dispatchId: string, status: CloudRunStatus, patch: CloudRunStatusPatch = {}): void {
    this.#db
      .prepare(
        `UPDATE cloud_runs
         SET status = ?,
             status_text = COALESCE(?, status_text),
             pr_url = COALESCE(?, pr_url),
             updated_at = ?
         WHERE dispatch_id = ?`,
      )
      .run(status, patch.statusText ?? null, patch.prUrl ?? null, this.#now(), dispatchId);
  }

  /** Mark the terminal result delivered to Slack (idempotency guard for the post). */
  markDelivered(dispatchId: string): void {
    const ts = this.#now();
    this.#db
      .prepare('UPDATE cloud_runs SET delivered_at = ?, updated_at = ? WHERE dispatch_id = ?')
      .run(ts, ts, dispatchId);
  }

  get(dispatchId: string): CloudRunRecord | undefined {
    const row = this.#db
      .prepare('SELECT * FROM cloud_runs WHERE dispatch_id = ?')
      .get(dispatchId) as Row | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  getByRunId(runId: string): CloudRunRecord | undefined {
    const row = this.#db.prepare('SELECT * FROM cloud_runs WHERE run_id = ?').get(runId) as
      | Row
      | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  /**
   * Rows the reconciler must act on: everything not yet terminally delivered.
   * `delivered_at IS NULL` covers `dispatching`, `running`, and any terminal row
   * still awaiting Slack delivery; terminal+delivered rows are excluded.
   */
  listActive(): CloudRunRecord[] {
    const rows = this.#db
      .prepare('SELECT * FROM cloud_runs WHERE delivered_at IS NULL ORDER BY created_at ASC')
      .all() as unknown as Row[];
    return rows.map(rowToRecord);
  }

  close(): void {
    this.#db.close();
  }
}

function rowToRecord(row: Row): CloudRunRecord {
  const status = row.status as CloudRunStatus;
  return {
    dispatchId: row.dispatch_id,
    ...(row.run_id !== null ? { runId: row.run_id } : {}),
    ...(row.agent_id !== null ? { agentId: row.agent_id } : {}),
    channel: row.channel,
    threadTs: row.thread_ts,
    status,
    ...(row.status_text !== null ? { statusText: row.status_text } : {}),
    ...(row.pr_url !== null ? { prUrl: row.pr_url } : {}),
    ...(row.delivered_at !== null ? { deliveredAt: row.delivered_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** True when a status is terminal (no further polling). */
export function isTerminalStatus(status: CloudRunStatus): boolean {
  return (CLOUD_RUN_TERMINAL_STATUSES as readonly string[]).includes(status);
}
