import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createServer } from './server.js';

import type { AgentConfig } from './config.js';
import type { Database } from '@sym/db';

const SIGNING_SECRET = 'test-signing-secret';

const config: AgentConfig = {
  port: 0,
  databaseUrl: 'postgres://unused',
  slackSigningSecret: SIGNING_SECRET,
};

// The verify + url_verification paths never touch the DB, so a stub is safe.
const stubDb = {} as unknown as Database;

function sign(ts: string, body: string): string {
  return `v0=${createHmac('sha256', SIGNING_SECRET).update(`v0:${ts}:${body}`).digest('hex')}`;
}

function post(body: string, headers: Record<string, string>): Promise<Response> {
  const app = createServer({ db: stubDb, config });
  return app.request('/slack/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
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
