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
  behavior: {
    taskCardThreshold: 1,
    taskCardAfter: 'delete',
    ownerPostMarker: true,
  },
};

function sign(ts: string, body: string): string {
  return `v0=${createHmac('sha256', SIGNING_SECRET).update(`v0:${ts}:${body}`).digest('hex')}`;
}

interface PostOpts {
  path?: string;
  contentType?: string;
  body: string;
  ts?: string;
  badSignature?: boolean;
}

async function post(opts: PostOpts): Promise<Response> {
  const path = opts.path ?? '/slack/events';
  const ts = opts.ts ?? String(Math.floor(Date.now() / 1000));
  const sig = opts.badSignature ? 'v0=deadbeef' : sign(ts, opts.body);
  const app = createServer({ config });
  return app.request(path, {
    method: 'POST',
    headers: {
      'content-type': opts.contentType ?? 'application/json',
      'x-slack-request-timestamp': ts,
      'x-slack-signature': sig,
    },
    body: opts.body,
  });
}

describe('agent server — Slack auth middleware (centralised gate)', () => {
  describe('signature verification', () => {
    it('rejects a bad signature with 401', async () => {
      const res = await post({
        body: JSON.stringify({ type: 'event_callback' }),
        badSignature: true,
      });
      expect(res.status).toBe(401);
    });

    it('rejects a stale timestamp with 401', async () => {
      const staleTs = String(Math.floor(Date.now() / 1000) - 60 * 60);
      const res = await post({
        body: JSON.stringify({ type: 'url_verification', challenge: 'x' }),
        ts: staleTs,
      });
      expect(res.status).toBe(401);
    });
  });

  describe('url_verification handshake', () => {
    it('echoes the challenge', async () => {
      const res = await post({
        body: JSON.stringify({ type: 'url_verification', challenge: 'chal-xyz' }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ challenge: 'chal-xyz' });
    });
  });

  describe('owner gate — events', () => {
    it('silent-ACKs a foreign-team event', async () => {
      const body = JSON.stringify({
        type: 'event_callback',
        team_id: 'T-OTHER',
        event_id: 'Ev1',
        event: { type: 'app_mention', user: 'UOWNER', channel: 'C1', ts: '1.0', text: 'hi' },
      });
      const res = await post({ body });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    });

    it('silent-ACKs an app_mention from a non-owner in our team', async () => {
      const body = JSON.stringify({
        type: 'event_callback',
        team_id: 'T-TEST',
        event_id: 'Ev2',
        event: { type: 'app_mention', user: 'UATTACKER', channel: 'C1', ts: '1.0', text: 'hi' },
      });
      const res = await post({ body });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    });

    it("silent-ACKs the bot's own message echo without triggering a decline (regression: decline-loop)", async () => {
      // Slack delivers every message in a channel back to the app, including
      // the bot's own posts. Without the self-event filter, the middleware
      // would treat each bot post as a non-owner DM, post a decline, see that
      // decline come back as another event, post another decline … ad infinitum.
      const bodyWithBotId = JSON.stringify({
        type: 'event_callback',
        team_id: 'T-TEST',
        event_id: 'EvBot1',
        event: {
          type: 'message',
          channel_type: 'im',
          user: 'UBOT',
          bot_id: 'B12345',
          channel: 'D1',
          ts: '1.0',
          text: 'I am posting',
        },
      });
      const res1 = await post({ body: bodyWithBotId });
      expect(res1.status).toBe(200);

      // Same scenario but signalled via `subtype` (Slack uses this for
      // message_changed / bot_message / message_deleted).
      const bodyWithSubtype = JSON.stringify({
        type: 'event_callback',
        team_id: 'T-TEST',
        event_id: 'EvBot2',
        event: {
          type: 'message',
          channel_type: 'im',
          subtype: 'bot_message',
          user: 'UBOT',
          channel: 'D1',
          ts: '1.0',
          text: 'I am posting',
        },
      });
      const res2 = await post({ body: bodyWithSubtype });
      expect(res2.status).toBe(200);

      // Defensive fallback: user equals our bot id even when bot_id/subtype
      // are missing (can happen on freshly-posted messages).
      const bodyWithBotUser = JSON.stringify({
        type: 'event_callback',
        team_id: 'T-TEST',
        event_id: 'EvBot3',
        event: {
          type: 'message',
          channel_type: 'im',
          user: 'UBOT',
          channel: 'D1',
          ts: '1.0',
          text: 'I am posting',
        },
      });
      const res3 = await post({ body: bodyWithBotUser });
      expect(res3.status).toBe(200);
    });

    it('silent-ACKs a DM message from a non-owner (decline post is fire-and-forget)', async () => {
      const body = JSON.stringify({
        type: 'event_callback',
        team_id: 'T-TEST',
        event_id: 'Ev3',
        event: {
          type: 'message',
          channel_type: 'im',
          user: 'UATTACKER',
          channel: 'D1',
          ts: '1.0',
          text: 'hi',
        },
      });
      const res = await post({ body });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    });
  });

  describe('owner gate — interactivity', () => {
    function form(payloadObj: unknown): string {
      const params = new URLSearchParams();
      params.set('payload', JSON.stringify(payloadObj));
      return params.toString();
    }

    it('silent-ACKs a button click from a non-owner', async () => {
      const body = form({
        type: 'block_actions',
        user: { id: 'UATTACKER' },
        team: { id: 'T-TEST' },
        actions: [{ action_id: 'sym_confirm:abc:approve' }],
      });
      const res = await post({
        path: '/slack/interactivity',
        contentType: 'application/x-www-form-urlencoded',
        body,
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    });

    it('silent-ACKs a click from a foreign team even if the user id matches', async () => {
      const body = form({
        type: 'block_actions',
        user: { id: 'UOWNER' },
        team: { id: 'T-OTHER' },
        actions: [{ action_id: 'sym_confirm:abc:approve' }],
      });
      const res = await post({
        path: '/slack/interactivity',
        contentType: 'application/x-www-form-urlencoded',
        body,
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    });

    it('accepts a click from the owner in our team (200 ACK, no further side effects asserted here)', async () => {
      const body = form({
        type: 'block_actions',
        user: { id: 'UOWNER' },
        team: { id: 'T-TEST' },
        actions: [{ action_id: 'sym_confirm:unknown-id:approve' }],
        response_url: undefined,
      });
      const res = await post({
        path: '/slack/interactivity',
        contentType: 'application/x-www-form-urlencoded',
        body,
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    });
  });

  describe('owner gate — slash commands', () => {
    function slashForm(fields: Record<string, string>): string {
      const params = new URLSearchParams(fields);
      return params.toString();
    }

    it('silent-ACKs a slash command from a non-owner', async () => {
      const body = slashForm({
        command: '/sym',
        team_id: 'T-TEST',
        user_id: 'UATTACKER',
        channel_id: 'C1',
        text: 'hello',
      });
      const res = await post({
        path: '/slack/commands',
        contentType: 'application/x-www-form-urlencoded',
        body,
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    });

    it('accepts a slash command from the owner', async () => {
      const body = slashForm({
        command: '/sym',
        team_id: 'T-TEST',
        user_id: 'UOWNER',
        channel_id: 'C1',
        text: 'hello',
      });
      const res = await post({
        path: '/slack/commands',
        contentType: 'application/x-www-form-urlencoded',
        body,
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    });
  });
});
