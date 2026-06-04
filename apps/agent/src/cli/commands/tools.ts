/**
 * `sym tools [name]` and `sym show <name>` — the live tool catalog and a single
 * connector's config + health + tools. Both render output that doubles as agent
 * context, so they emit dense, complete data.
 */

import { configPath } from '@sym/mcp-runtime';

import { isCliWildcard, resolveCliConnectors } from '../../run-cli.js';
import {
  fetchConnectors,
  fetchConnectorTools,
  type ConnectorDetail,
  type ToolInfo,
} from '../admin-client.js';
import { loadConfigFile } from '../config-store.js';
import { cliConnectorLines, healthWord } from './render.js';

/** `sym tools [name]` — the live tool catalog (name + description). */
export async function toolsCommand(name: string | undefined, json: boolean): Promise<number> {
  if (name !== undefined) {
    let tools: ToolInfo[];
    try {
      tools = await fetchConnectorTools(name);
    } catch (err) {
      console.error(`sym: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
    if (json) {
      console.log(JSON.stringify({ connector: name, tools }, null, 2));
      return 0;
    }
    console.log(`${name}: ${tools.length} tool(s)`);
    for (const t of tools) console.log(`  ${t.name} — ${t.description}`);
    return 0;
  }

  // All connectors → full catalog. Tools are a LIVE concept, so the agent must
  // be reachable; offline we can't enumerate them.
  let connectors: ConnectorDetail[];
  try {
    connectors = await fetchConnectors();
  } catch (err) {
    console.error(
      `sym: ${err instanceof Error ? err.message : String(err)} (tools are live — start Sym or 'sym apply')`,
    );
    return 1;
  }
  const catalog = await Promise.all(
    connectors.map(async (c) => ({
      connector: c.name,
      ok: c.ok,
      tools: c.ok ? await fetchConnectorTools(c.name).catch(() => []) : [],
    })),
  );

  // CLIs are capabilities too — surface them in the catalog so a tool search
  // covers both MCP tools and run_cli CLIs (same renderer as every other surface).
  if (json) {
    console.log(
      JSON.stringify(
        {
          catalog,
          cli: { connectors: resolveCliConnectors(), wildcard: isCliWildcard(), via: 'run_cli' },
        },
        null,
        2,
      ),
    );
    return 0;
  }
  const total = catalog.reduce((sum, c) => sum + c.tools.length, 0);
  console.log(`${total} tool(s) across ${catalog.length} connector(s):`);
  for (const c of catalog) {
    console.log(`\n${c.connector} (${c.tools.length})${c.ok ? '' : ' — not connected'}`);
    for (const t of c.tools) console.log(`  ${t.name} — ${t.description}`);
  }
  console.log(`\nCLIs (via run_cli):`);
  for (const line of cliConnectorLines()) console.log(line);
  return 0;
}

/** `sym show <name>` — one connector's config + live health + its tools. */
export async function showCommand(name: string | undefined, json: boolean): Promise<number> {
  if (name === undefined || name.length === 0) {
    throw new Error('show requires a connector name: sym show <name>');
  }
  const config = loadConfigFile(configPath()).mcpServers.find((s) => s.name === name) ?? null;
  let health: ConnectorDetail | null = null;
  let tools: ToolInfo[] = [];
  try {
    health = (await fetchConnectors()).find((d) => d.name === name) ?? null;
    tools = await fetchConnectorTools(name).catch(() => []);
  } catch {
    // agent down — show config-only.
  }

  if (json) {
    console.log(JSON.stringify({ name, config, health, tools }, null, 2));
    return 0;
  }
  if (config === null && health === null) {
    console.log(`no connector named '${name}' in the config file or live set`);
    return 1;
  }
  console.log(`connector: ${name}`);
  if (health !== null) {
    console.log(
      `  health: ${healthWord(health)} · ${health.tools} tool(s)${health.error ? ` · ${health.error}` : ''}`,
    );
  } else {
    console.log('  health: (agent not reachable)');
  }
  console.log('  config:');
  console.log(
    (config !== null ? JSON.stringify(config, null, 2) : '(not in config file)')
      .split('\n')
      .map((l) => `    ${l}`)
      .join('\n'),
  );
  if (tools.length > 0) {
    console.log(`  tools (${tools.length}):`);
    for (const t of tools) console.log(`    ${t.name} — ${t.description}`);
  }
  return 0;
}
