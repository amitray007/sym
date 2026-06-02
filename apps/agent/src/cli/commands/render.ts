/**
 * Shared rendering helpers for the `sym` CLI commands.
 *
 * The CLI-connector block, the connector table, and the reload report render
 * IDENTICALLY across `status`, `connector`, `tools`, and `apply` — so they live
 * here, consumed by every command surface.
 */

import { configPath } from '../../mcp/source.js';
import { isCliWildcard, resolveCliConnectors } from '../../run-cli.js';
import { loadConfigFile } from '../config-store.js';

import type { ConnectorDetail, ReloadResponse } from '../admin-client.js';

/** A connector's health word (matches the dashboard glyph semantics in text). */
export function healthWord(d: { ok: boolean; error?: string }): string {
  if (d.ok) return 'connected';
  if (d.error !== undefined) return 'failed';
  return 'down';
}

/** Connector details from the config file, as an offline view (no live health). */
export function offlineDetails(): ConnectorDetail[] {
  return loadConfigFile(configPath()).mcpServers.map((s) => ({
    name: s.name,
    transport: s.transport.kind,
    auth: s.auth?.kind ?? 'none',
    trust: s.trust === true,
    ok: false,
    tools: 0,
  }));
}

/**
 * The CLI-connectors block, rendered IDENTICALLY on every surface (status,
 * connector ls, tools, apply). Each line: `bin ✓/✗ — description`.
 */
export function cliConnectorLines(): string[] {
  const conns = resolveCliConnectors();
  const lines = conns.map(
    (c) =>
      `  ${c.bin} ${c.onPath ? '✓' : '✗ (not on PATH)'}${c.description !== undefined ? ` — ${c.description}` : ''}`,
  );
  if (isCliWildcard()) lines.push('  …plus ANY other installed CLI (allowlist is *)');
  else if (conns.length === 0) lines.push('  (no CLI connectors)');
  return lines;
}

/** A fixed-width text table of connector rows (dense, aligned, agent-readable). */
export function renderConnectorTable(connectors: ConnectorDetail[]): string {
  if (connectors.length === 0) return '  (no connectors)';
  const head = `  ${'NAME'.padEnd(20)} ${'TRANSPORT'.padEnd(9)} ${'AUTH'.padEnd(8)} ${'TRUST'.padEnd(5)} ${'HEALTH'.padEnd(10)} TOOLS`;
  const lines = connectors.map((c) => {
    const row = `  ${c.name.padEnd(20)} ${c.transport.padEnd(9)} ${c.auth.padEnd(8)} ${(c.trust ? 'yes' : 'no').padEnd(5)} ${healthWord(c).padEnd(10)} ${c.tools}`;
    const err = c.error !== undefined ? `\n      ⚠ ${c.error}` : '';
    return row + err;
  });
  return [head, ...lines].join('\n');
}

/** Reload report: MCP reconcile result + the CLI connectors (same on every surface). */
export function printReload(r: ReloadResponse, json: boolean): void {
  if (json) {
    console.log(
      JSON.stringify({ ...r, cli: resolveCliConnectors(), cliWildcard: isCliWildcard() }, null, 2),
    );
    return;
  }
  console.log(`source: ${r.source} (${r.path}) — ${r.totalTools} tool(s) live`);
  console.log('MCP connectors:');
  if (r.connectors.length === 0) console.log('  (none)');
  for (const c of r.connectors) {
    const err = c.error !== undefined ? ` — ${c.error}` : '';
    console.log(`  ${c.status.padEnd(20)} ${c.name}  ${c.tools} tool(s)${err}`);
  }
  console.log('CLIs (run_cli):');
  for (const line of cliConnectorLines()) console.log(line);
}
