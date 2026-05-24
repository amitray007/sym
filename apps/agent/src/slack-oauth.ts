import { createHmac, timingSafeEqual } from 'node:crypto';

import type { AgentConfig } from './config.js';

const AUTHORIZE_URL = 'https://slack.com/oauth/v2/authorize';
const ACCESS_URL = 'https://slack.com/api/oauth.v2.access';

/** Bot scopes requested at install. Keep aligned with what the runtime uses. */
export const BOT_SCOPES = [
  'app_mentions:read',
  'chat:write',
  'im:history',
  'im:read',
  'commands',
  'users:read',
];

/** CSRF state token validity. */
const STATE_TTL_SECONDS = 600;

export class SlackOAuthError extends Error {
  constructor(
    message: string,
    public readonly code: 'not_configured' | 'bad_state' | 'exchange_failed',
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'SlackOAuthError';
  }
}

/** True when the install routes have everything they need. */
export function isOAuthConfigured(config: AgentConfig): boolean {
  return Boolean(config.slackClientId && config.slackClientSecret && config.oauthRedirectUri);
}

// --- CSRF state: stateless, HMAC-signed `<unixSeconds>.<hex hmac>` ---------

export function signState(secret: string, now = Date.now()): string {
  const ts = Math.floor(now / 1000).toString();
  const mac = createHmac('sha256', secret).update(ts).digest('hex');
  return `${ts}.${mac}`;
}

export function verifyState(secret: string, state: string, now = Date.now()): boolean {
  const dot = state.indexOf('.');
  if (dot <= 0) return false;
  const ts = state.slice(0, dot);
  const provided = state.slice(dot + 1);

  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return false;
  if (Math.abs(Math.floor(now / 1000) - tsNum) > STATE_TTL_SECONDS) return false;

  const expected = createHmac('sha256', secret).update(ts).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

// --- Authorize URL ---------------------------------------------------------

export function buildAuthorizeUrl(config: AgentConfig, state: string): string {
  if (!isOAuthConfigured(config)) {
    throw new SlackOAuthError('Slack OAuth is not configured', 'not_configured');
  }
  const params = new URLSearchParams({
    client_id: config.slackClientId!,
    scope: BOT_SCOPES.join(','),
    redirect_uri: config.oauthRedirectUri!,
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

// --- Code exchange ---------------------------------------------------------

export interface SlackOAuthResult {
  accessToken: string;
  botUserId: string;
  appId: string;
  scope: string;
  teamId: string;
  teamName: string;
  installerUserId: string;
  enterpriseId?: string;
}

interface AccessResponse {
  ok: boolean;
  error?: string;
  access_token?: string;
  bot_user_id?: string;
  app_id?: string;
  scope?: string;
  team?: { id?: string; name?: string };
  authed_user?: { id?: string };
  enterprise?: { id?: string } | null;
}

/** Exchange the OAuth `code` for a bot token via oauth.v2.access. */
export async function exchangeCode(
  config: AgentConfig,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SlackOAuthResult> {
  if (!isOAuthConfigured(config)) {
    throw new SlackOAuthError('Slack OAuth is not configured', 'not_configured');
  }

  const body = new URLSearchParams({
    client_id: config.slackClientId!,
    client_secret: config.slackClientSecret!,
    code,
    redirect_uri: config.oauthRedirectUri!,
  });

  let json: AccessResponse;
  try {
    const res = await fetchImpl(ACCESS_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    json = (await res.json()) as AccessResponse;
  } catch (cause) {
    throw new SlackOAuthError('oauth.v2.access request failed', 'exchange_failed', { cause });
  }

  if (!json.ok || !json.access_token || !json.bot_user_id || !json.app_id || !json.team?.id) {
    throw new SlackOAuthError(
      `oauth.v2.access returned an error: ${json.error ?? 'incomplete response'}`,
      'exchange_failed',
    );
  }

  const result: SlackOAuthResult = {
    accessToken: json.access_token,
    botUserId: json.bot_user_id,
    appId: json.app_id,
    scope: json.scope ?? '',
    teamId: json.team.id,
    teamName: json.team.name ?? json.team.id,
    installerUserId: json.authed_user?.id ?? 'unknown',
  };
  if (json.enterprise?.id) result.enterpriseId = json.enterprise.id;
  return result;
}
