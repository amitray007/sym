import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { serve } from '@hono/node-server';
import { config as loadDotenv } from 'dotenv';

import { loadAgentConfig } from './config.js';
import { configPath, initMcpPool, McpDispatcher } from './mcp/index.js';
import { cliConnectorsSummary } from './run-cli.js';
import { createServer } from './server.js';

async function main(): Promise<void> {
  // Dev convenience: load the repo-root .env, letting it OVERRIDE vars already
  // in the shell — otherwise a stale/empty exported var (e.g. an empty
  // SLACK_BOT_TOKEN left in the shell) silently shadows the file. In production
  // there is no .env here (env is injected directly), so override is a no-op.
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  loadDotenv({ path: resolve(repoRoot, '.env'), override: true });

  const config = loadAgentConfig();
  // Boot visibility: which model is actually loaded. FIREWORKS_MODEL is read here
  // once at boot, so this is the authoritative answer to "what model am I running?"
  // (a stale env or a `.env` override is otherwise invisible).
  console.info(`[agent] model: ${config.fireworksModel} (fireworks @ ${config.fireworksBaseUrl})`);
  // Boot visibility: make it obvious where connector config came from (the config
  // file, the legacy env var, or nothing). An unset source otherwise produces no
  // log at all, which makes "why no MCP tools?" murky.
  const mcpNames = config.mcpServers.map((s) => s.name);
  const sourceLabel =
    config.mcpConfigSource === 'file'
      ? `config file (${configPath()})`
      : config.mcpConfigSource === 'env'
        ? 'SYM_MCP_SERVERS env'
        : 'no source';
  console.info(
    mcpNames.length > 0
      ? `[mcp] ${mcpNames.length} connector(s) from ${sourceLabel}: ${mcpNames.join(', ')}`
      : `[mcp] no MCP servers configured (${sourceLabel})`,
  );
  // CLI connectors are invisible otherwise (they're not "connected", just
  // allowlisted) — log them with a PATH check so a missing binary is obvious.
  console.info(`[cli] ${cliConnectorsSummary()}`);

  // Warm the MCP pool at boot (not lazily on the first turn) so every connector's
  // tools are connected + ready before the first Slack message — no first-turn
  // connect latency or race. Bounded by SYM_MCP_CONNECT_TIMEOUT_MS per connector;
  // a server that fails contributes zero tools (fail-open) and never blocks boot.
  if (config.mcpServers.length > 0) {
    await initMcpPool(config.mcpServers);
    const ready = new McpDispatcher(config.mcpServers).list().length;
    console.info(
      `[mcp] pool warm — ${ready} tool(s) ready across ${config.mcpServers.length} connector(s)`,
    );
  }

  const app = createServer({ config });
  serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.info(`[agent] listening on :${info.port}`);
  });
}

main().catch((err: unknown) => {
  console.error('[agent] fatal startup error:', err);
  process.exit(1);
});
