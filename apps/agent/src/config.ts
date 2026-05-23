/**
 * Agent runtime config, read from injected env (Dokploy in prod; `.env` in dev
 * via the entrypoint's dotenv load). No secrets are logged.
 */
export interface AgentConfig {
  port: number;
  databaseUrl: string;
  /** App-level Slack signing secret (verifies inbound event signatures). */
  slackSigningSecret: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

export function loadAgentConfig(): AgentConfig {
  return {
    port: Number(process.env['AGENT_PORT'] ?? '3001'),
    databaseUrl: required('DATABASE_URL'),
    slackSigningSecret: required('SLACK_SIGNING_SECRET'),
  };
}
