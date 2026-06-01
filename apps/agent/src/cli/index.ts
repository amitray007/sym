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
 * Verbs:
 *   sym status [--json]                     agent health + every connector's health + tools
 *   sym tools [name] [--json]               full tool catalog (name + description) — live
 *   sym show <name> [--json]                one connector: config + health + tools
 *   sym apply [--json]                      reconcile the running agent to the file
 *   sym mcp ls [--json]                     connectors in the config file + live health
 *   sym mcp add --spec '<ConnectorConfig>'  add/replace a connector (full generic shape)
 *   sym mcp add --name N --command C [--arg A]… [--trust]   stdio shorthand
 *   sym mcp add --name N --url U [--trust]                  http shorthand
 *   sym mcp rm  --name N                     remove a connector
 *   sym secret set <connector> <field> [value]   (value via stdin if omitted)
 *   sym secret ls [--json]                   list stored secret names (no values)
 *   sym secret rm  <connector> <field>       delete a stored secret
 *
 * Mutating `mcp` verbs write the file, then best-effort `apply` so changes go
 * live immediately; if the agent isn't reachable the file is still written and
 * the change lands on next start (or a later `sym apply`).
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
  upsertConnector,
  writeConfigFile,
} from './config-store.js';
import { configPath } from '../mcp/source.js';
import { resolveAllowlist } from '../run-cli.js';

import type { ConnectorConfig, TransportConfig } from '../mcp/config.js';

const HELP = `sym — connector control plane

  sym                                          launch the interactive menu (TUI) on a terminal
  sym menu                                     launch the interactive menu explicitly

Read (add --json for machine/agent-parseable output):
  sym status                                   agent health + each connector's health + tool count
  sym tools [name]                             full live tool catalog (name + description)
  sym show <name>                              one connector: config + health + its tools
  sym mcp ls                                   connectors in the config file (+ live health)
  sym cli ls                                   the run_cli allowlist (CLIs the agent may run)
  sym secret ls                                stored secret names (never values)

Write:
  sym apply                                    reconcile the running agent to the config file
  sym mcp add --spec '<ConnectorConfig JSON>'  add/replace a connector (full generic shape)
  sym mcp add --name N --command C [--arg A]…   stdio shorthand (repeat --arg per token)
  sym mcp add --name N --url U [--trust]        http shorthand
  sym mcp rm --name N                           remove a connector
  sym cli add <bin>…                            allow a CLI for run_cli (additive)
  sym cli set <a,b,c>                           replace the whole allowlist (e.g. restrict from *)
  sym cli rm <bin>…                             disallow a CLI
  sym secret set <connector> <field> [value]   store a secret (value via stdin if omitted)
  sym secret rm <connector> <field>            delete a stored secret

Secrets live in the encrypted store (SYM_ENCRYPTION_KEY); the config file holds
wiring only. The config file is SYM_CONFIG_PATH (default .sym/config.json).`;

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
  const allow = resolveAllowlist();
  const cliList = allow === '*' ? ['*'] : [...allow].sort();

  if (json) {
    console.log(
      JSON.stringify(
        {
          reachable,
          configPath: configPath(),
          totalTools,
          connectorCount: connectors.length,
          connectors,
          cli: { allow: cliList, wildcard: allow === '*' },
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
  console.log(`\nCLIs (run_cli): ${allow === '*' ? '* (any installed CLI)' : cliList.join(', ')}`);
  return 0;
}

/** `sym cli` — view/manage the run_cli allowlist (stored in the config file). */
function cliCommand(args: string[], json: boolean): number {
  const verb = args[0];
  const path = configPath();

  if (verb === undefined || verb === 'ls' || verb === 'list') {
    const allow = resolveAllowlist();
    const list = allow === '*' ? ['*'] : [...allow].sort();
    const source = loadConfigFile(path).cli !== undefined ? 'config file' : 'env/default';
    if (json) {
      console.log(JSON.stringify({ allow: list, wildcard: allow === '*', source }, null, 2));
      return 0;
    }
    console.log(`run_cli allowlist (${source}): ${list.join(', ')}`);
    if (allow === '*') {
      console.log('  * = any installed CLI is runnable. Restrict with `sym cli set <a,b,c>`.');
    }
    return 0;
  }

  if (verb === 'add') {
    const bins = args.slice(1).filter((b) => b.length > 0);
    if (bins.length === 0) throw new Error('cli add requires binary names: sym cli add gh jq');
    const cfg = loadConfigFile(path);
    // Seed a fresh allowlist from the current effective set so add is ADDITIVE,
    // never a surprise narrowing of an env/default allowlist.
    let base = cfg.cli?.allow;
    if (base === undefined) {
      const eff = resolveAllowlist();
      base = eff === '*' ? ['*'] : [...eff];
    }
    const next = setCliAllow(cfg, [...base, ...bins]);
    writeConfigFile(path, next);
    console.log(`allowlist: ${(next.cli?.allow ?? []).join(', ')}`);
    if ((next.cli?.allow ?? []).includes('*')) {
      console.log('  note: still contains * (any CLI). Run `sym cli rm "*"` to enforce the list.');
    }
    return 0;
  }

  if (verb === 'set') {
    const bins = args
      .slice(1)
      .flatMap((s) => s.split(','))
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (bins.length === 0) throw new Error('cli set requires a list: sym cli set sym,gcloud,gh,jq');
    const next = setCliAllow(loadConfigFile(path), bins);
    writeConfigFile(path, next);
    console.log(`allowlist: ${(next.cli?.allow ?? []).join(', ')}`);
    return 0;
  }

  if (verb === 'rm' || verb === 'remove') {
    const bins = args.slice(1).filter((b) => b.length > 0);
    if (bins.length === 0) throw new Error('cli rm requires binary names: sym cli rm gh');
    const { next, removed } = removeCli(loadConfigFile(path), bins);
    writeConfigFile(path, next);
    console.log(
      removed.length > 0
        ? `removed ${removed.join(', ')} → allowlist: ${(next.cli?.allow ?? []).join(', ') || '(empty)'}`
        : 'nothing removed (not in the allowlist)',
    );
    return 0;
  }

  throw new Error(`unknown 'cli' verb '${verb}' — see 'sym help'`);
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

  if (json) {
    console.log(JSON.stringify({ catalog }, null, 2));
    return 0;
  }
  const total = catalog.reduce((sum, c) => sum + c.tools.length, 0);
  console.log(`${total} tool(s) across ${catalog.length} connector(s):`);
  for (const c of catalog) {
    console.log(`\n${c.connector} (${c.tools.length})${c.ok ? '' : ' — not connected'}`);
    for (const t of c.tools) console.log(`  ${t.name} — ${t.description}`);
  }
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

/** Pretty one-line-per-connector reload report. */
function printReload(r: ReloadResponse, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  console.log(`source: ${r.source} (${r.path}) — ${r.totalTools} tool(s) live`);
  for (const c of r.connectors) {
    const err = c.error !== undefined ? ` — ${c.error}` : '';
    console.log(`  ${c.status.padEnd(20)} ${c.name}  ${c.tools} tool(s)${err}`);
  }
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
    throw new Error('mcp add requires --name (or --spec)');
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
    throw new Error('mcp add requires --command (stdio) or --url (http), or use --spec');
  }

  return {
    name: values.name,
    transport,
    ...(values.trust === true ? { trust: true } : {}),
  };
}

async function mcpCommand(args: string[], json: boolean): Promise<number> {
  const verb = args[0];
  const path = configPath();

  if (verb === 'ls' || verb === 'list') {
    const cfg = loadConfigFile(path);
    // Best-effort live health to enrich the wiring view.
    const live = new Map<string, ConnectorDetail>();
    try {
      for (const d of await fetchConnectors()) live.set(d.name, d);
    } catch {
      // agent down — wiring-only view.
    }
    if (json) {
      const rows = cfg.mcpServers.map((s) => ({
        name: s.name,
        transport: s.transport.kind,
        auth: s.auth?.kind ?? 'none',
        trust: s.trust === true,
        live: live.get(s.name) ?? null,
      }));
      console.log(JSON.stringify({ path, connectors: rows }, null, 2));
      return 0;
    }
    if (cfg.mcpServers.length === 0) {
      console.log(`(no connectors in ${path})`);
      return 0;
    }
    console.log(`${cfg.mcpServers.length} connector(s) in ${path}:`);
    for (const s of cfg.mcpServers) {
      const d = live.get(s.name);
      const health = d !== undefined ? `  ${healthWord(d)} · ${d.tools} tool(s)` : '';
      const trust = s.trust === true ? ' [trust]' : '';
      console.log(
        `  ${s.name.padEnd(20)} ${s.transport.kind.padEnd(6)} auth:${(s.auth?.kind ?? 'none').padEnd(7)}${trust}${health}`,
      );
    }
    return 0;
  }

  if (verb === 'add') {
    const { values } = parseArgs({
      args: args.slice(1),
      options: {
        spec: { type: 'string' },
        name: { type: 'string' },
        command: { type: 'string' },
        arg: { type: 'string', multiple: true },
        url: { type: 'string' },
        trust: { type: 'boolean' },
      },
      allowPositionals: false,
    });
    const connector = connectorFromAddFlags({
      ...(values.spec !== undefined ? { json: values.spec } : {}),
      ...(values.name !== undefined ? { name: values.name } : {}),
      ...(values.command !== undefined ? { command: values.command } : {}),
      ...(values.arg !== undefined ? { arg: values.arg } : {}),
      ...(values.url !== undefined ? { url: values.url } : {}),
      ...(values.trust !== undefined ? { trust: values.trust } : {}),
    });
    writeConfigFile(path, upsertConnector(loadConfigFile(path), connector));
    console.log(`wrote ${connector.name} to ${path}`);
    await tryApply(json);
    return 0;
  }

  if (verb === 'rm' || verb === 'remove') {
    const { values } = parseArgs({
      args: args.slice(1),
      options: { name: { type: 'string' } },
      allowPositionals: true,
    });
    const name = values.name;
    if (name === undefined || name.length === 0) {
      throw new Error('mcp rm requires --name N');
    }
    const { next, removed } = removeConnector(loadConfigFile(path), name);
    if (!removed) {
      console.log(`no connector named '${name}' in ${path}`);
      return 0;
    }
    writeConfigFile(path, next);
    console.log(`removed ${name} from ${path}`);
    await tryApply(json);
    return 0;
  }

  throw new Error(`unknown 'mcp' verb '${verb ?? ''}' — see 'sym help'`);
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
      throw new Error('secret set requires <connector> <field> [value]');
    }
    const value = args[3] ?? (await readStdin());
    if (value.length === 0) {
      throw new Error('no secret value provided (pass as the last arg or pipe via stdin)');
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

    case 'tools':
      return toolsCommand(args[0], json);

    case 'show':
      return showCommand(args[0], json);

    case 'apply':
      printReload(await applyReload(), json);
      return 0;

    case 'mcp':
      return mcpCommand(args, json);

    case 'cli':
      return cliCommand(args, json);

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
