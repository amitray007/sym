// Defense in depth for webhook secrets (decision 090). Sym never posts a secret in Slack, but a
// person might paste one. Slack text that reaches the brain or a worker through Sym's own reads
// (`slack_read`, the worker's thread) loses anything shaped like a webhook secret. Pure, so any
// bundle can import it.

const SECRET = /whsec_[A-Za-z0-9_-]{20,}/g;

export const REDACTED_SECRET = "whsec_[redacted]";

export function redactSecrets(text: string): string {
  return text.replace(SECRET, REDACTED_SECRET);
}
