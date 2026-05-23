/** Configuration injected at construction time. No env access. */
export interface FireworksConfig {
  baseUrl: string;
  apiKey: string;
}

/** Retry/backoff parameters. */
export interface RetryConfig {
  /** Maximum number of retry attempts after the initial failure. */
  maxRetries: number;
  /** Base delay in ms for exponential backoff (doubled each attempt). */
  baseDelayMs: number;
  /** Maximum delay in ms regardless of backoff calculation. */
  maxDelayMs: number;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 500,
  maxDelayMs: 16_000,
};
