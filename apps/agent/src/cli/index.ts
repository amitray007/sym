#!/usr/bin/env node
/**
 * `sym` — the connector control-plane CLI.
 *
 * A tool-agnostic front-end over the connector config file + the running
 * agent's loopback admin routes. It knows NOTHING about any specific service:
 * it edits generic `ConnectorConfig` rows (transport × auth × injection), stores
 * generic secrets, and reconciles the live pool via POST /admin/reload.
 *
 * DUAL AUDIENCE: the operator runs `sym` interactively, AND the agent can run it
 * via `run_cli` to introspect its own connectors — so the READ commands emit
 * dense, complete data (and support `--json` for exact parsing). The output of
 * `sym status` / `sym tools` / `sym show` is meant to be readable as context.
 *
 * One surface — `sym connector` — manages BOTH kinds of capability:
 *   - MCP connectors (transport × auth × injection; used via call_tool)
 *   - CLI connectors (a binary + description; used via run_cli)
 *
 * Verbs:
 *   sym status [--json]                          agent health + every connector + tool counts
 *   sym connector ls [--json]                    all connectors (MCP + CLI)
 *   sym connector show <name> [--json]           one connector in full
 *   sym connector add --name N --command/--url/--spec   add an MCP connector
 *   sym connector add --cli <bin> [--desc "…"]   add a CLI connector
 *   sym connector rm <name>                      remove a connector (MCP or CLI)
 *   sym tools [name] [--json]                    every tool (MCP tools + CLIs)
 *   sym apply [--json]                           reconcile the running agent to the file
 *   sym secret set|ls|rm                         manage encrypted secrets
 *
 * Adding/removing an MCP connector best-effort `apply`s so it goes live without a
 * restart; if the agent isn't reachable the file is still written. (`sym mcp` /
 * `sym cli` were merged into `sym connector`.)
 */

import { argv } from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import {
  applyReload,
  fetchConnectors,
  fetchConnectorTools,
  type ConnectorDetail,
  type ReloadResponse,
  type ToolInfo,
} from './admin-client.js';
import {
  loadConfigFile,
  removeConnector,
  removeCli,
  setCliAllow,
  setCliDesc,
  upsertConnector,
  writeConfigFile,
} from './config-store.js';
import { loadCliDescribe } from '../mcp/cli-config.js';
import { configPath } from '../mcp/source.js';
import {
  isCliWildcard,
  resolveAllowlist,
  resolveCliCapabilities,
  resolveCliConnectors,
} from '../run-cli.js';

import type { ConnectorConfig, TransportConfig } from '../mcp/config.js';

const HELP = `sym — connector control plane

A "connector" is anything Sym reaches the outside world with: an MCP connector
(structured tools, used via find_tools → call_tool) OR a CLI (used via run_cli).
One surface manages both.

  sym  /  sym menu                              interactive menu (TUI)

Inspect (add --json for machine/agent-parseable output):
  sym status                                   agent health + every connector + tool counts
  sym connector ls                             all connectors (MCP + CLI): health, tools, descriptions
  sym connector show <name>                    one connector in full
  sym tools [name]                             every tool — MCP tools (call_tool) + CLIs (run_cli)

Manage:
  sym connector add --name N --command C       add an MCP connector (stdio; repeat --arg per token)
  sym connector add --name N --url U [--trust]  add an MCP connector (http)
  sym connector add --spec '<ConnectorConfig>' add an MCP connector (full generic shape)
  sym connector add --cli <bin> --desc "…"     add a CLI connector (allow + describe it)
  sym connector rm <name>                      remove a connector (MCP or CLI)
  sym apply                                    reconcile the running agent to the config file
  sym secret set|ls|rm                         manage encrypted secrets (never printed)

Connectors live in SYM_CONFIG_PATH (default .sym/config.json); secrets in the
encrypted store (SYM_ENCRYPTION_KEY).`;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Pull a global `--json` flag out of the args, anywhere it appears. */
function takeJsonFlag(args: string[]): { json: boolean; rest: string[] } {
  const rest = args.filter((a) => a !== '--json');
  return { json: rest.length !== args.length, rest };
}

/** Read all of stdin as a trimmed string (for piping secret values). */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').trim();
}

/** A connector's health word (matches the dashboard glyph semantics in text). */
function healthWord(d: { ok: boolean; error?: string }): string {
  if (d.ok) return 'connected';
  if (d.error !== undefined) return 'failed';
  return 'down';
}

/** Connector details from the config file, as an offline view (no live health). */
function offlineDetails(): ConnectorDetail[] {
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
function cliConnectorLines(): string[] {
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
function renderConnectorTable(connectors: ConnectorDetail[]): string {
  if (connectors.length === 0) return '  (no connectors)';
  const head = `  ${'NAME'.padEnd(20)} ${'TRANSPORT'.padEnd(9)} ${'AUTH'.padEnd(8)} ${'TRUST'.padEnd(5)} ${'HEALTH'.padEnd(10)} TOOLS`;
  const lines = connectors.map((c) => {
    const row = `  ${c.name.padEnd(20)} ${c.transport.padEnd(9)} ${c.auth.padEnd(8)} ${(c.trust ? 'yes' : 'no').padEnd(5)} ${healthWord(c).padEnd(10)} ${c.tools}`;
    const err = c.error !== undefined ? `\n      ⚠ ${c.error}` : '';
    return row + err;
  });
  return [head, ...lines].join('\n');
}

// ---------------------------------------------------------------------------
// Read commands (rich output — also consumed as agent context)
// ---------------------------------------------------------------------------

/** `sym status` — agent reachability + every connector's health + tool counts. */
async function statusCommand(json: boolean): Promise<number> {
  let connectors: ConnectorDetail[];
  let reachable: boolean;
  try {
    connectors = await fetchConnectors();
    reachable = true;
  } catch {
    reachable = false;
    connectors = offlineDetails();
  }
  const totalTools = connectors.reduce((sum, c) => sum + c.tools, 0);

  if (json) {
    console.log(
      JSON.stringify(
        {
          reachable,
          configPath: configPath(),
          totalTools,
          connectorCount: connectors.length,
          connectors,
          cli: { connectors: resolveCliConnectors(), wildcard: isCliWildcard() },
        },
        null,
        2,
      ),
    );
    return 0;
  }

  console.log(
    `agent: ${reachable ? 'up' : 'down'}   config: ${configPath()}   ` +
      `${totalTools} tool(s) live across ${connectors.length} connector(s)` +
      (reachable ? '' : '   (offline view — start Sym for live health/tools)'),
  );
  console.log(renderConnectorTable(connectors));
  console.log('\nCLIs (run_cli):');
  for (const line of cliConnectorLines()) console.log(line);
  return 0;
}

/**
 * `sym connector` — the ONE surface for capabilities, MCP and CLI alike.
 *   ls            list every connector (MCP + CLI) with health/tools/description
 *   show <name>   one connector in full
 *   add …         add an MCP connector (--name/--command/--url/--spec) or a CLI
 *                 connector (--cli <bin> [--desc "…"])
 *   rm <name>     remove a connector (MCP or CLI, whichever owns the name)
 */
async function connectorCommand(args: string[], json: boolean): Promise<number> {
  const verb = args[0];
  const path = configPath();

  if (verb === undefined || verb === 'ls' || verb === 'list') {
    const cfg = loadConfigFile(path);
    const live = new Map<string, ConnectorDetail>();
    try {
      for (const d of await fetchConnectors()) live.set(d.name, d);
    } catch {
      // agent down — wiring-only view.
    }
    const mcp = cfg.mcpServers.map((s) => {
      const d = live.get(s.name);
      const health = d === undefined ? 'unknown' : healthWord(d);
      return {
        name: s.name,
        kind: 'mcp' as const,
        transport: s.transport.kind,
        health,
        tools: d?.tools ?? 0,
        ...(d?.error !== undefined ? { error: d.error } : {}),
      };
    });
    const cli = resolveCliConnectors().map((c) => ({
      name: c.bin,
      kind: 'cli' as const,
      onPath: c.onPath,
      ...(c.description !== undefined ? { description: c.description } : {}),
    }));

    if (json) {
      console.log(
        JSON.stringify({ connectors: [...mcp, ...cli], cliWildcard: isCliWildcard() }, null, 2),
      );
      return 0;
    }
    console.log(`connectors (${path}):`);
    if (mcp.length === 0 && cli.length === 0 && !isCliWildcard()) console.log('  (none)');
    for (const m of mcp) {
      console.log(
        `  ${m.name.padEnd(20)} mcp   ${m.health.padEnd(10)} ${m.tools} tool(s)   via find_tools → call_tool`,
      );
      if (m.error !== undefined) console.log(`      ⚠ ${m.error}`);
    }
    for (const c of cli) {
      console.log(
        `  ${c.name.padEnd(20)} cli   ${c.onPath ? '✓'.padEnd(10) : '✗'.padEnd(10)} ${c.description ?? 'run via run_cli'}`,
      );
    }
    if (isCliWildcard()) {
      console.log('  …plus ANY other installed CLI (allowlist is *) — run via run_cli');
    }
    return 0;
  }

  if (verb === 'show') {
    const name = args[1];
    if (name === undefined)
      throw new Error('connector show requires a name: sym connector show <name>');
    const cfg = loadConfigFile(path);
    if (cfg.mcpServers.some((s) => s.name === name)) {
      return showCommand(name, json); // MCP detail: config + health + tools
    }
    const allow = resolveAllowlist();
    const known =
      allow === '*' ? resolveCliCapabilities().some((c) => c.bin === name) : allow.has(name);
    if (known || allow === '*') {
      const desc = loadCliDescribe()[name];
      if (json) {
        console.log(
          JSON.stringify(
            { name, kind: 'cli', description: desc ?? null, use: `run_cli ["${name}", …]` },
            null,
            2,
          ),
        );
        return 0;
      }
      console.log(`connector: ${name} (cli)`);
      console.log(`  ${desc ?? '(no description)'}`);
      console.log(`  use: run_cli ["${name}", …]   (run ["${name}","--help"] to learn it)`);
      return 0;
    }
    console.log(`no connector named '${name}'`);
    return 1;
  }

  if (verb === 'add') {
    const { values, positionals } = parseArgs({
      args: args.slice(1),
      options: {
        cli: { type: 'boolean' },
        desc: { type: 'string' },
        spec: { type: 'string' },
        name: { type: 'string' },
        command: { type: 'string' },
        arg: { type: 'string', multiple: true },
        url: { type: 'string' },
        trust: { type: 'boolean' },
      },
      allowPositionals: true,
    });

    if (values.cli === true) {
      const bin = positionals[0];
      if (bin === undefined || bin.length === 0) {
        throw new Error('cli connector needs a binary: sym connector add --cli <bin> [--desc "…"]');
      }
      const cfg = loadConfigFile(path);
      // CLI connectors ARE the run_cli allowlist — build it explicitly (no `*`).
      const base = (cfg.cli?.allow ?? []).filter((b) => b !== '*');
      let next = setCliAllow(cfg, [...base, bin]);
      if (values.desc !== undefined) next = setCliDesc(next, bin, values.desc);
      writeConfigFile(path, next);
      console.log(
        `added cli connector: ${bin}${values.desc !== undefined ? ` — ${values.desc}` : ''}`,
      );
      console.log(`run_cli allowlist: ${(next.cli?.allow ?? []).join(', ')}`);
      return 0;
    }

    const connector = connectorFromAddFlags({
      ...(values.spec !== undefined ? { json: values.spec } : {}),
      ...(values.name !== undefined ? { name: values.name } : {}),
      ...(values.command !== undefined ? { command: values.command } : {}),
      ...(values.arg !== undefined ? { arg: values.arg } : {}),
      ...(values.url !== undefined ? { url: values.url } : {}),
      ...(values.trust !== undefined ? { trust: values.trust } : {}),
    });
    writeConfigFile(path, upsertConnector(loadConfigFile(path), connector));
    console.log(`added mcp connector: ${connector.name}`);
    await tryApply(json);
    return 0;
  }

  if (verb === 'rm' || verb === 'remove') {
    const name = args[1];
    if (name === undefined || name.length === 0) {
      throw new Error('connector rm requires a name: sym connector rm <name>');
    }
    const cfg = loadConfigFile(path);
    if (cfg.mcpServers.some((s) => s.name === name)) {
      writeConfigFile(path, removeConnector(cfg, name).next);
      console.log(`removed mcp connector: ${name}`);
      await tryApply(json);
      return 0;
    }
    const { next, removed } = removeCli(cfg, [name]);
    if (removed.length > 0) {
      writeConfigFile(path, next);
      console.log(`removed cli connector: ${name}`);
      return 0;
    }
    console.log(`no connector named '${name}'`);
    return 1;
  }

  throw new Error(`unknown 'connector' verb '${verb ?? ''}' — see 'sym help'`);
}

/** `sym tools [name]` — the live tool catalog (name + description). */
async function toolsCommand(name: string | undefined, json: boolean): Promise<number> {
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
async function showCommand(name: string | undefined, json: boolean): Promise<number> {
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

/** Reload report: MCP reconcile result + the CLI connectors (same on every surface). */
function printReload(r: ReloadResponse, json: boolean): void {
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

// ---------------------------------------------------------------------------
// mcp verbs
// ---------------------------------------------------------------------------

/** Build a ConnectorConfig from `mcp add` shorthand/spec flags. Exported for tests. */
export function connectorFromAddFlags(values: {
  json?: string;
  name?: string;
  command?: string;
  arg?: string[];
  url?: string;
  trust?: boolean;
}): ConnectorConfig {
  if (values.json !== undefined) {
    const parsed = JSON.parse(values.json) as ConnectorConfig;
    if (typeof parsed.name !== 'string' || parsed.name.length === 0) {
      throw new Error('--spec connector must have a non-empty "name"');
    }
    return parsed;
  }

  if (values.name === undefined || values.name.length === 0) {
    throw new Error('connector add requires --name (or --spec, or --cli for a CLI connector)');
  }

  let transport: TransportConfig;
  if (values.url !== undefined) {
    transport = { kind: 'http', url: values.url };
  } else if (values.command !== undefined) {
    transport = {
      kind: 'stdio',
      command: values.command,
      ...(values.arg !== undefined && values.arg.length > 0 ? { args: values.arg } : {}),
    };
  } else {
    throw new Error('connector add requires --command (stdio) or --url (http), or --spec');
  }

  return {
    name: values.name,
    transport,
    ...(values.trust === true ? { trust: true } : {}),
  };
}

/** Best-effort reconcile after a file edit; a down agent is a soft note, not an error. */
async function tryApply(json: boolean): Promise<void> {
  try {
    printReload(await applyReload(), json);
  } catch (err) {
    console.log(
      `(config written; not applied — ${err instanceof Error ? err.message : String(err)}. ` +
        `It will take effect on agent start, or run 'sym apply' once it's up.)`,
    );
  }
}

// ---------------------------------------------------------------------------
// secret verbs
// ---------------------------------------------------------------------------

async function secretCommand(args: string[], json: boolean): Promise<number> {
  const verb = args[0];
  // Lazy import: only `sym secret` needs the SQLite-backed store, so non-secret
  // verbs don't load node:sqlite (avoids its experimental warning + the open).
  const { listSecrets, removeSecret, setSecret } = await import('./secrets.js');

  if (verb === 'set') {
    const connector = args[1];
    const field = args[2];
    if (connector === undefined || field === undefined) {
      throw new Error('secret set requires <connector> <field> (value is read from stdin)');
    }
    // SECURITY (Z09-14): never accept the secret as a positional arg — it would be
    // visible in the process table (`ps`, /proc/<pid>/cmdline) to any local user.
    // The value is read from stdin only.
    if (args[3] !== undefined) {
      throw new Error(
        'secret set does not accept the value as an argument (it leaks via the process ' +
          `table). Pipe it via stdin: \`printf %s "$TOKEN" | sym secret set ${connector} ${field}\``,
      );
    }
    const value = await readStdin();
    if (value.length === 0) {
      throw new Error(
        'no secret value provided — pipe it via stdin: ' +
          `\`printf %s "$TOKEN" | sym secret set ${connector} ${field}\``,
      );
    }
    setSecret(connector, field, value);
    console.log(`stored secret ${connector}/${field}`);
    return 0;
  }

  if (verb === 'ls' || verb === 'list') {
    const refs = listSecrets();
    if (json) {
      console.log(JSON.stringify({ secrets: refs }, null, 2));
      return 0;
    }
    if (refs.length === 0) {
      console.log('(no secrets stored)');
      return 0;
    }
    for (const r of refs) console.log(`  ${r.connector}/${r.field}`);
    return 0;
  }

  if (verb === 'rm' || verb === 'remove') {
    const connector = args[1];
    const field = args[2];
    if (connector === undefined || field === undefined) {
      throw new Error('secret rm requires <connector> <field>');
    }
    removeSecret(connector, field);
    console.log(`removed secret ${connector}/${field}`);
    return 0;
  }

  throw new Error(`unknown 'secret' verb '${verb ?? ''}' — see 'sym help'`);
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export async function main(rawArgs: string[]): Promise<number> {
  const { json, rest } = takeJsonFlag(rawArgs);
  const [group, ...args] = rest;

  switch (group) {
    case undefined:
      // Bare `sym` on a terminal launches the interactive TUI; piped/non-TTY
      // (CI, `sym | cat`, the agent's run_cli) prints help instead of a UI.
      if (process.stdout.isTTY) {
        await (await import('../tui/index.js')).launchTui();
        return 0;
      }
      console.log(HELP);
      return 0;

    case 'menu':
    case 'tui':
      await (await import('../tui/index.js')).launchTui();
      return 0;

    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return 0;

    case 'status':
      return statusCommand(json);

    case 'connector':
    case 'connectors':
    case 'conn':
      return connectorCommand(args, json);

    case 'tools':
      return toolsCommand(args[0], json);

    case 'show':
      // `sym show <name>` is shorthand for `sym connector show <name>`.
      return connectorCommand(['show', ...args], json);

    case 'apply':
      printReload(await applyReload(), json);
      return 0;

    case 'mcp':
    case 'cli':
      console.error(
        `'sym ${group}' was merged into 'sym connector'. Use: sym connector ls | show <name> | ` +
          `add (--name/--command/--url/--spec for MCP, or --cli <bin> --desc "…" for a CLI) | rm <name>.`,
      );
      return 1;

    case 'secret':
      return secretCommand(args, json);

    default:
      console.error(`unknown command '${group}' — see 'sym help'`);
      return 1;
  }
}

// Only run when invoked directly (`sym …` / `tsx src/cli/index.ts`), not when
// imported by a test — otherwise importing the module would execute the CLI.
if (argv[1] !== undefined && fileURLToPath(import.meta.url) === argv[1]) {
  main(argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`sym: ${msg}`);
      // A cwd-relative config path fails when `sym` is run from a non-writable
      // dir (e.g. `/`). Point at the fix rather than leaving a bare EACCES.
      if (/EACCES|permission denied|mkdir/i.test(msg)) {
        console.error(
          `hint: set SYM_CONFIG_PATH to a writable path, e.g. ` +
            `export SYM_CONFIG_PATH=/data/sym/config.json   (current: ${configPath()})`,
        );
      }
      process.exit(1);
    });
}
