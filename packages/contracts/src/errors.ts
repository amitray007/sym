/**
 * Cross-stream error model. Every recoverable cross-boundary failure is a
 * tagged value, not a thrown exception, so callers handle it explicitly.
 * Domain-internal throws are fine; what crosses a package boundary is typed.
 */
export type SymErrorDomain =
  | 'provider'
  | 'tool'
  | 'memory'
  | 'soul'
  | 'slack'
  | 'acl'
  | 'config'
  | 'audit';

export interface SymErrorBase<D extends SymErrorDomain, C extends string> {
  domain: D;
  code: C;
  message: string;
  retryable?: boolean;
  cause?: unknown;
}

export type ProviderError = SymErrorBase<
  'provider',
  'rate_limited' | 'timeout' | 'upstream' | 'invalid_response' | 'unauthorized'
>;

export type MemoryError = SymErrorBase<'memory', 'not_found' | 'consent_required' | 'scope_denied'>;

export type SlackActionError = SymErrorBase<
  'slack',
  'rate_limited' | 'invalid_input' | 'not_authed' | 'channel_not_found' | 'api_error'
>;

export type AclError = SymErrorBase<'acl', 'forbidden' | 'not_allowlisted' | 'blocked'>;

export type ConfigError = SymErrorBase<'config', 'missing' | 'invalid' | 'disabled'>;

/** The cross-stream error union. `tool` failures travel as `ToolError` (see tools.ts). */
export type SymError = ProviderError | MemoryError | SlackActionError | AclError | ConfigError;

/** Explicit success/failure envelope for cross-boundary calls. */
export type Result<T, E = SymError> = { ok: true; value: T } | { ok: false; error: E };
