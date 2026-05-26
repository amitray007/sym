/**
 * Cross-boundary error types and result envelope used by the adapter and agent.
 */

interface SymErrorBase<D extends string, C extends string> {
  domain: D;
  code: C;
  message: string;
  retryable?: boolean;
  cause?: unknown;
}

export type SlackActionError = SymErrorBase<
  'slack',
  'rate_limited' | 'invalid_input' | 'not_authed' | 'channel_not_found' | 'api_error'
>;

/** The cross-boundary error union. Kept for the type test invariant. */
export type SymError = SlackActionError;

/** Explicit success/failure envelope for cross-boundary calls. */
export type Result<T, E = SymError> = { ok: true; value: T } | { ok: false; error: E };
