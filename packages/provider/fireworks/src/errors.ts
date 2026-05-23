import type { ProviderError } from '@sym/contracts';

/**
 * Map an HTTP status code and optional body to a `ProviderError`.
 * Called after all retry attempts are exhausted or when the error is
 * non-retryable.
 */
export function mapHttpError(status: number, message: string): ProviderError {
  if (status === 401 || status === 403) {
    return {
      domain: 'provider',
      code: 'unauthorized',
      message: `Fireworks auth error (HTTP ${status}): ${message}`,
      retryable: false,
    };
  }
  if (status === 429) {
    return {
      domain: 'provider',
      code: 'rate_limited',
      message: `Fireworks rate limited (HTTP 429): ${message}`,
      retryable: true,
    };
  }
  if (status >= 500) {
    return {
      domain: 'provider',
      code: 'upstream',
      message: `Fireworks upstream error (HTTP ${status}): ${message}`,
      retryable: true,
    };
  }
  return {
    domain: 'provider',
    code: 'upstream',
    message: `Fireworks unexpected HTTP ${status}: ${message}`,
    retryable: false,
  };
}

export function makeTimeoutError(message: string): ProviderError {
  return {
    domain: 'provider',
    code: 'timeout',
    message,
    retryable: true,
  };
}

export function makeInvalidResponseError(message: string, cause?: unknown): ProviderError {
  return {
    domain: 'provider',
    code: 'invalid_response',
    message,
    retryable: false,
    cause,
  };
}

/**
 * A thrown error that carries a structured `ProviderError` so the caller can
 * inspect the typed code without parsing message strings.
 */
export class ProviderException extends Error {
  readonly providerError: ProviderError;

  constructor(providerError: ProviderError) {
    super(providerError.message);
    this.name = 'ProviderException';
    this.providerError = providerError;
  }
}
