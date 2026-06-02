/**
 * Lightweight per-turn log helpers.
 *
 * `logCtx` returns a short prefix string for log lines so concurrent turns
 * are distinguishable in server output without any structured-logging
 * framework. Thread the prefix onto existing console.info/warn/error calls
 * inside the turn path wherever `turnId` is in scope.
 *
 * Intentionally minimal — this is NOT a logging framework. It is just a
 * string builder used to prefix existing log calls.
 */

/**
 * Return a short log prefix for the given turn id, e.g. `[turn 1a2b3c4d]`.
 * The prefix is derived from the first 8 hex characters of the turn id so
 * logs from parallel turns are visually distinct without being verbose.
 */
export function logCtx(turnId: string): string {
  return `[turn ${turnId.slice(0, 8)}]`;
}
