// The Slack Web API seam (docs/slack.md). Sym's own posts (the outbox, job cards, DMs) go through
// it. Tests pass a fake, or point the real one at a local fake Slack server.

export interface SlackApi {
  // Calls a Web API method. Resolves with the response body when Slack answers `ok: true`.
  // Throws SlackApiError when Slack answers `ok: false`.
  call(method: string, body: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export class SlackApiError extends Error {
  override name = "SlackApiError";
  readonly method: string;
  readonly code: string;

  constructor(method: string, code: string) {
    super(`Slack ${method} failed: ${code}`);
    this.method = method;
    this.code = code;
  }
}
