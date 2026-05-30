/**
 * Materializer — writes secret file-blobs to an ephemeral directory.
 *
 * Prefers /dev/shm (RAM-backed tmpfs on Linux/Dokploy) when available and
 * writable; falls back to os.tmpdir(). Uses fs.mkdtemp for uniqueness.
 *
 * Security:
 *  - Dir mode: 0700 (owner-only).
 *  - File mode: 0600 (owner-only).
 *  - File contents are NEVER logged.
 *
 * Lifecycle:
 *  - Every created dir is tracked in a module-level Set.
 *  - ONE set of process-level signal handlers is registered (process.once +
 *    a single SIGINT/SIGTERM listener) — no per-call listener leak.
 *  - cleanup() can be called manually; the exit handler catches anything left.
 */

import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Materializer class (injectable for tests)
// ---------------------------------------------------------------------------

export interface MaterializeResult {
  /** The temp directory containing the written files. */
  dir: string;
  /** Remove the directory and all files within it. Best-effort on process exit. */
  cleanup(): Promise<void>;
}

export class Materializer {
  /**
   * @param dirRoot - Override the root under which temp dirs are created.
   *   Defaults to /dev/shm if available and writable, else os.tmpdir().
   *   Inject a custom path in tests to avoid touching real /dev/shm.
   */
  constructor(private readonly dirRoot?: string) {}

  /**
   * Determine the root directory to use for temp dirs.
   * Checks /dev/shm first; falls back to os.tmpdir().
   */
  private async resolveRoot(): Promise<string> {
    if (this.dirRoot !== undefined) return this.dirRoot;
    const shm = '/dev/shm';
    try {
      await fs.access(shm, fs.constants.W_OK);
      return shm;
    } catch {
      return os.tmpdir();
    }
  }

  /**
   * Write the given files to a new ephemeral temp directory.
   *
   * @param connectorName - Used as part of the temp dir prefix (for debuggability).
   * @param files - Array of { path: string (relative); content: string } to write.
   * @returns The absolute dir path and a cleanup() function.
   */
  async materialize(
    connectorName: string,
    files: { path: string; content: string }[],
  ): Promise<MaterializeResult> {
    const root = await this.resolveRoot();
    const prefix = `sym-mcp-${connectorName}-`;
    const dir = await fs.mkdtemp(path.join(root, prefix));

    // Ensure dir is 0700 (mkdtemp may use umask-influenced permissions).
    await fs.chmod(dir, 0o700);

    // Track for cleanup on exit.
    _registerDir(dir);

    for (const file of files) {
      // Reject absolute paths and parent-dir traversal. Check path SEGMENTS for
      // a literal '..' (handles both / and \) rather than a naive substring
      // match, so legitimate names like 'key..json' are allowed.
      const segments = file.path.split(/[/\\]/);
      if (path.isAbsolute(file.path) || segments.some((s) => s === '..')) {
        // Clean up the dir we just created before throwing.
        await _removeDir(dir);
        _unregisterDir(dir);
        throw new Error(
          `Materializer: file path must be relative and must not traverse parent dirs — got '${file.path}'`,
        );
      }
      const abs = path.join(dir, file.path);
      // Ensure parent dir exists (file.path may include subdirectories).
      const parentDir = path.dirname(abs);
      if (parentDir !== dir) {
        await fs.mkdir(parentDir, { recursive: true, mode: 0o700 });
      }
      // Write with mode 0600. writeFile accepts mode as a number.
      await fs.writeFile(abs, file.content, { mode: 0o600 });
    }

    const cleanup = async (): Promise<void> => {
      await _removeDir(dir);
      _unregisterDir(dir);
    };

    return { dir, cleanup };
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton + process-exit cleanup
// ---------------------------------------------------------------------------

/** Set of all dirs created by any Materializer instance in this process. */
const _activeDirs = new Set<string>();

function _registerDir(dir: string): void {
  const wasEmpty = _activeDirs.size === 0;
  _activeDirs.add(dir);
  if (wasEmpty) {
    // Register exit handlers exactly once (the first time any dir is created).
    _ensureExitHandlers();
  }
}

function _unregisterDir(dir: string): void {
  _activeDirs.delete(dir);
}

async function _removeDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // Best-effort — don't let cleanup errors propagate.
  }
}

/** Synchronous best-effort removal for the process exit handler. */
function _removeDirSync(dir: string): void {
  try {
    // Node 16+ has rmSync with recursive+force.
    fsSync.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort.
  }
}

let _handlersRegistered = false;

function _ensureExitHandlers(): void {
  if (_handlersRegistered) return;
  _handlersRegistered = true;

  // Synchronous exit handler — runs for normal process exit.
  process.once('exit', () => {
    for (const dir of _activeDirs) {
      _removeDirSync(dir);
    }
  });

  // Async-capable signal handlers — use best-effort async removal then exit.
  const makeSignalHandler = () => () => {
    Promise.all([..._activeDirs].map(_removeDir))
      .catch(() => undefined)
      .finally(() => process.exit(130));
  };

  process.once('SIGINT', makeSignalHandler());
  process.once('SIGTERM', makeSignalHandler());
}

// ---------------------------------------------------------------------------
// Default singleton (used by StaticProvider and the dispatcher)
// ---------------------------------------------------------------------------

/** The default Materializer instance — uses /dev/shm or os.tmpdir(). */
export const defaultMaterializer = new Materializer();

// ---------------------------------------------------------------------------
// Test helpers — exported for tests only, not part of the public API
// ---------------------------------------------------------------------------

/**
 * Returns a reference to the internal active-dirs set.
 * Used in tests to verify cleanup registration without relying on private state.
 */
export function _getActiveDirsForTesting(): Set<string> {
  return _activeDirs;
}

/**
 * Reset the handler-registered flag.
 * Tests that spin up fresh Materializers and want to test handler registration
 * must call this between tests; do NOT call in production code.
 */
export function _resetHandlerFlagForTesting(): void {
  _handlersRegistered = false;
}
