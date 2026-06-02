import type { SlackActionError } from '@sym/contracts';

// ---------------------------------------------------------------------------
// Slack error types
// ---------------------------------------------------------------------------

/** Error shape thrown when Slack returns a non-ok response. */
export interface SlackApiError extends Error {
  code: string;
  /** Raw Slack API error string (e.g. `too_many_requests`). */
  data?: { error?: string; retry_after?: number };
}

function isSlackApiError(e: unknown): e is SlackApiError {
  return e instanceof Error && 'code' in e;
}

/**
 * A terminal Slack failure as a real `Error` that also carries the structured
 * `SlackActionError` fields. Being an `Error` keeps `instanceof Error` + `.message`
 * working for callers that log it; the fields are there for structured handling.
 */
class SlackError extends Error implements SlackActionError {
  readonly domain = 'slack';
  readonly code: SlackActionError['code'];
  readonly retryable: boolean;
  constructor(
    code: SlackActionError['code'],
    message: string,
    retryable: boolean,
    cause?: unknown,
  ) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'SlackError';
    this.code = code;
    this.retryable = retryable;
  }
}

/**
 * The canonical Slack Web API error — thrown by `WebApiSlackClient` when
 * Slack returns a non-ok response or a 429. Implements `SlackApiError` so the
 * retry layer can read `.code` and `.data.retry_after`.
 */
export class SlackWebApiError extends Error implements SlackApiError {
  readonly code: string;
  readonly data: { error?: string; retry_after?: number };
  constructor(code: string, data: { error?: string; retry_after?: number } = {}) {
    super(code);
    this.name = 'SlackWebApiError';
    this.code = code;
    this.data = data;
  }
}

// ---------------------------------------------------------------------------
// Retry mechanics
// ---------------------------------------------------------------------------

/**
 * Wraps a Slack API call with exponential backoff on 429 rate-limits.
 * Non-rate-limit errors surface immediately as `SlackActionError`.
 *
 * @param fn         The async Slack API call to wrap.
 * @param maxRetries Maximum number of retry attempts (default 3).
 */
export async function withSlackRetries<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  let attempt = 0;
  let delay = 1_000; // ms

  while (attempt <= maxRetries) {
    try {
      return await fn();
    } catch (err: unknown) {
      if (isSlackApiError(err)) {
        const slackError = err.data?.error ?? err.code;

        // Rate limited — respect Retry-After or back off exponentially.
        if (slackError === 'too_many_requests' || slackError === 'ratelimited') {
          if (attempt === maxRetries) {
            throw mapSlackError(err);
          }
          const retryAfterMs = (err.data?.retry_after ?? 0) * 1000 || delay;
          await sleep(Math.max(retryAfterMs, delay));
          delay = Math.min(delay * 2, 30_000);
          attempt++;
          continue;
        }

        // Idempotent success cases.
        if (slackError === 'already_reacted' || slackError === 'no_reaction') {
          return undefined as unknown as T;
        }

        // Any other Slack error is a terminal failure.
        throw mapSlackError(err);
      }

      // Non-Slack errors propagate as-is.
      throw err;
    }
  }

  /* istanbul ignore next — unreachable after exhausting retries */
  throw new SlackError('rate_limited', 'Exceeded retry budget', true);
}

/** Convert a raw Slack API error into a typed `SlackActionError`. */
function mapSlackError(err: SlackApiError): SlackActionError {
  const slackError = err.data?.error ?? err.code;

  const codeMap: Record<string, SlackActionError['code']> = {
    too_many_requests: 'rate_limited',
    ratelimited: 'rate_limited',
    not_authed: 'not_authed',
    invalid_auth: 'not_authed',
    token_revoked: 'not_authed',
    token_expired: 'not_authed',
    channel_not_found: 'channel_not_found',
    invalid_blocks: 'invalid_input',
    no_text: 'invalid_input',
  };

  const code: SlackActionError['code'] = codeMap[slackError] ?? 'api_error';

  // Loud, one-line operator signal when a token has been revoked / expired so
  // it shows up in deploy logs without needing a separate health check. The
  // structured SlackError still surfaces normally so callers can degrade.
  if (code === 'not_authed') {
    console.error(
      `[slack-adapter] AUTH REJECTED (${slackError}) — token is invalid/revoked/expired. ` +
        'Re-run the install to refresh SLACK_BOT_TOKEN or SLACK_OWNER_USER_TOKEN.',
    );
  }

  return new SlackError(code, slackError ?? err.message, code === 'rate_limited', err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
