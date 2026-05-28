import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createServer } from '../src/server.js';

import type { AgentConfig } from '../src/config.js';

const SIGNING_SECRET = 'test-signing-secret';

const config: AgentConfig = {
  port: 0,
  slackSigningSecret: SIGNING_SECRET,
  slackBotToken: 'xoxb-test',
  slackBotUserId: 'UBOT',
  slackTeamId: 'T-TEST',
  ownerSlackUserId: 'UOWNER',
  fireworksApiKey: 'fw-key',
  fireworksModel: 'test-model',
  fireworksBaseUrl: 'http://fake.fireworks',
};

function sign(ts: string, body: string): string {
  return `v0=${createHmac('sha256', SIGNING_SECRET).update(`v0:${ts}:${body}`).digest('hex')}`;
}

function post(body: string, headers: Record<string, string>): Promise<Response> {
  const app = createServer({ config });
  return Promise.resolve(
    app.request('/slack/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    }),
  );
}

/**
 * POST a signed request to an arbitrary path with arbitrary content-type.
 * Used for slash commands (form-encoded) and lifecycle event leak tests.
 */
function postTo(
  path: string,
  body: string,
  contentType: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  const app = createServer({ config });
  return Promise.resolve(
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': contentType, ...headers },
      body,
    }),
  );
}

/** Build the standard headers Slack sends, including a valid signature. */
function signedHeaders(body: string): Record<string, string> {
  const ts = String(Math.floor(Date.now() / 1000));
  return {
    'x-slack-request-timestamp': ts,
    'x-slack-signature': sign(ts, body),
  };
}

describe('agent server /slack/events', () => {
  it('rejects a bad signature with 401', async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({ type: 'event_callback' });
    const res = await post(body, {
      'x-slack-request-timestamp': ts,
      'x-slack-signature': 'v0=deadbeef',
    });
    expect(res.status).toBe(401);
  });

  it('echoes the url_verification challenge with a valid signature', async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({ type: 'url_verification', challenge: 'chal-xyz' });
    const res = await post(body, {
      'x-slack-request-timestamp': ts,
      'x-slack-signature': sign(ts, body),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: 'chal-xyz' });
  });

  it('rejects a stale timestamp with 401', async () => {
    const staleTs = String(Math.floor(Date.now() / 1000) - 60 * 60);
    const body = JSON.stringify({ type: 'url_verification', challenge: 'x' });
    const res = await post(body, {
      'x-slack-request-timestamp': staleTs,
      'x-slack-signature': sign(staleTs, body),
    });
    expect(res.status).toBe(401);
  });

  it('ACKs an assistant_thread_started from a NON-owner without error (leak gate)', async () => {
    // The fix: a non-owner opening their Sym panel must not trigger any panel
    // API call (no setTitle / setSuggestedPrompts / chatPostMessage). Slack-side
    // we cannot observe Slack call attempts from here, but the route must
    // accept the event cleanly without throwing — the gate is the *absence*
    // of side effects, which is verified by the normalizer test ensuring
    // assistantThreadStarted() now carries userId for the gate to read.
    const body = JSON.stringify({
      type: 'event_callback',
      event_id: 'Ev-leak-1',
      team_id: config.slackTeamId,
      event: {
        type: 'assistant_thread_started',
        ts: '1700000020.000001',
        channel: '',
        text: '',
        assistant_thread: {
          user_id: 'U-INTRUDER', // ← not the owner
          channel_id: 'D-INTRUDER-SYM-IM',
          thread_ts: '1700000020.000001',
        },
      },
    });
    const res = await postTo('/slack/events', body, 'application/json', signedHeaders(body));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// Slash commands — owner-gated universal entry point.
// ---------------------------------------------------------------------------
describe('agent server /slack/commands', () => {
  function formBody(fields: Record<string, string>): string {
    return new URLSearchParams(fields).toString();
  }

  it('rejects a bad signature with 401', async () => {
    const body = formBody({ command: '/sym', text: 'hi', user_id: 'UOWNER' });
    const res = await postTo('/slack/commands', body, 'application/x-www-form-urlencoded', {
      'x-slack-request-timestamp': String(Math.floor(Date.now() / 1000)),
      'x-slack-signature': 'v0=deadbeef',
    });
    expect(res.status).toBe(401);
  });

  it('silent-ACKs a slash command from a foreign workspace', async () => {
    const body = formBody({
      team_id: 'T-OTHER', // not config.slackTeamId
      user_id: 'UOWNER',
      channel_id: 'C1',
      command: '/sym',
      text: 'hi',
      trigger_id: 'tr-1',
      response_url: 'http://example.invalid/r/1',
    });
    const res = await postTo(
      '/slack/commands',
      body,
      'application/x-www-form-urlencoded',
      signedHeaders(body),
    );
    expect(res.status).toBe(200);
    // Empty body — no Slack-visible message about being rejected.
    expect(await res.text()).toBe('');
  });

  it('silent-ACKs a slash command from a NON-owner', async () => {
    const body = formBody({
      team_id: config.slackTeamId,
      user_id: 'U-NOT-OWNER',
      channel_id: 'C1',
      command: '/sym',
      text: 'hi',
      trigger_id: 'tr-2',
      response_url: 'http://example.invalid/r/2',
    });
    const res = await postTo(
      '/slack/commands',
      body,
      'application/x-www-form-urlencoded',
      signedHeaders(body),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });

  it('returns a usage hint when the owner sends `/sym` with no text', async () => {
    const body = formBody({
      team_id: config.slackTeamId,
      user_id: config.ownerSlackUserId,
      channel_id: 'C1',
      command: '/sym',
      text: '   ', // whitespace only
      trigger_id: 'tr-3',
      response_url: 'http://example.invalid/r/3',
    });
    const res = await postTo(
      '/slack/commands',
      body,
      'application/x-www-form-urlencoded',
      signedHeaders(body),
    );
    // 200 ACK; the actual usage hint is posted to response_url out-of-band.
    expect(res.status).toBe(200);
  });

  it('ACKs the owner happy path 200 and kicks off the turn in the background', async () => {
    // Background work (chatPostMessage seed + handleTurn) is fire-and-forget;
    // it will fail in tests (no real Slack endpoint), but those errors are
    // caught inside processSlashCommand. The HTTP response is the contract
    // Slack actually sees, and it must be 200 within 3s.
    const body = formBody({
      team_id: config.slackTeamId,
      user_id: config.ownerSlackUserId,
      channel_id: 'C1',
      command: '/sym',
      text: 'what is the status of the auth migration',
      trigger_id: 'tr-4',
      response_url: 'http://example.invalid/r/4',
    });
    const res = await postTo(
      '/slack/commands',
      body,
      'application/x-www-form-urlencoded',
      signedHeaders(body),
    );
    expect(res.status).toBe(200);
  });
});
