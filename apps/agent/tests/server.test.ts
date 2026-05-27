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
});
