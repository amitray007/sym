/**
 * Agent runtime config, read from injected env (Dokploy in prod; `.env` in dev
 * via the entrypoint's dotenv load). No secrets are logged.
 */
export interface AgentConfig {
  port: number;
  databaseUrl: string;
  /** App-level Slack signing secret (verifies inbound event signatures). */
  slackSigningSecret: string;
  /**
   * Slack OAuth install credentials. Optional — the agent runs for events
   * without them; the /slack/install routes return 503 until they're set.
   */
  slackClientId?: string;
  slackClientSecret?: string;
  /** OAuth callback URL registered with the Slack app, e.g. https://agent.example.com/slack/oauth/callback */
  oauthRedirectUri?: string;
  /** Where to send the browser after a successful install. */
  dashboardUrl?: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function optional(name: string): string | undefined {
  return process.env[name] || undefined;
}

export function loadAgentConfig(): AgentConfig {
  const config: AgentConfig = {
    port: Number(process.env['AGENT_PORT'] ?? '3001'),
    databaseUrl: required('DATABASE_URL'),
    slackSigningSecret: required('SLACK_SIGNING_SECRET'),
  };
  const slackClientId = optional('SLACK_CLIENT_ID');
  const slackClientSecret = optional('SLACK_CLIENT_SECRET');
  const oauthRedirectUri = optional('SLACK_OAUTH_REDIRECT_URI');
  const dashboardUrl = optional('DASHBOARD_URL');
  if (slackClientId) config.slackClientId = slackClientId;
  if (slackClientSecret) config.slackClientSecret = slackClientSecret;
  if (oauthRedirectUri) config.oauthRedirectUri = oauthRedirectUri;
  if (dashboardUrl) config.dashboardUrl = dashboardUrl;
  return config;
}
