import { describe, expect, it } from 'vitest';

import {
  SlackOAuthError,
  buildAuthorizeUrl,
  exchangeCode,
  isOAuthConfigured,
  signState,
  verifyState,
} from './slack-oauth.js';

import type { AgentConfig } from './config.js';

const SECRET = 'test-signing-secret';

const config: AgentConfig = {
  port: 0,
  databaseUrl: 'postgres://unused',
  slackSigningSecret: SECRET,
  slackClientId: 'client-123',
  slackClientSecret: 'secret-abc',
  oauthRedirectUri: 'https://agent.example.com/slack/oauth/callback',
  dashboardUrl: 'https://dash.example.com',
};

function okResponse(): Response {
  return {
    json: async () => ({
      ok: true,
      access_token: 'xoxb-real-token',
      bot_user_id: 'UBOT',
      app_id: 'A123',
      scope: 'chat:write,app_mentions:read',
      team: { id: 'T999', name: 'Acme' },
      authed_user: { id: 'UADMIN' },
    }),
  } as unknown as Response;
}

describe('slack-oauth CSRF state', () => {
  it('round-trips a signed state', () => {
    const state = signState(SECRET);
    expect(verifyState(SECRET, state)).toBe(true);
  });

  it('rejects a tampered state', () => {
    const state = signState(SECRET);
    const tampered = state.slice(0, -1) + (state.endsWith('0') ? '1' : '0');
    expect(verifyState(SECRET, tampered)).toBe(false);
  });

  it('rejects a wrong-secret state', () => {
    const state = signState(SECRET);
    expect(verifyState('other-secret', state)).toBe(false);
  });

  it('rejects an expired state', () => {
    const old = signState(SECRET, Date.now() - 11 * 60 * 1000); // 11 min ago (TTL 10)
    expect(verifyState(SECRET, old)).toBe(false);
  });

  it('rejects a malformed state', () => {
    expect(verifyState(SECRET, 'garbage')).toBe(false);
  });
});

describe('slack-oauth authorize URL', () => {
  it('includes client_id, scope, redirect_uri, state', () => {
    const url = new URL(buildAuthorizeUrl(config, 'STATE'));
    expect(url.searchParams.get('client_id')).toBe('client-123');
    expect(url.searchParams.get('redirect_uri')).toBe(config.oauthRedirectUri);
    expect(url.searchParams.get('state')).toBe('STATE');
    expect(url.searchParams.get('scope')).toContain('chat:write');
  });

  it('throws when not configured', () => {
    expect(() => buildAuthorizeUrl({ ...config, slackClientId: undefined }, 'S')).toThrow(
      SlackOAuthError,
    );
  });
});

describe('slack-oauth exchangeCode', () => {
  it('parses a successful oauth.v2.access response', async () => {
    const result = await exchangeCode(config, 'the-code', async () => okResponse());
    expect(result.accessToken).toBe('xoxb-real-token');
    expect(result.teamId).toBe('T999');
    expect(result.teamName).toBe('Acme');
    expect(result.botUserId).toBe('UBOT');
    expect(result.installerUserId).toBe('UADMIN');
  });

  it('throws on an error response', async () => {
    const errFetch = (async () =>
      ({
        json: async () => ({ ok: false, error: 'invalid_code' }),
      }) as unknown as Response) as typeof fetch;
    await expect(exchangeCode(config, 'bad', errFetch)).rejects.toThrow(SlackOAuthError);
  });
});

describe('isOAuthConfigured', () => {
  it('is true with full config, false when a field is missing', () => {
    expect(isOAuthConfigured(config)).toBe(true);
    expect(isOAuthConfigured({ ...config, slackClientSecret: undefined })).toBe(false);
  });
});
