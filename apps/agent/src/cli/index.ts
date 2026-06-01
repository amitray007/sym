#!/usr/bin/env node
/**
 * `sym` — the connector control-plane CLI.
 *
 * A tool-agnostic front-end over the connector config file + the running
 * agent's loopback admin routes. It knows NOTHING about any specific service:
 * it edits generic `ConnectorConfig` rows (transport × auth × injection), stores
 * generic secrets, and reconciles the live pool via POST /admin/reload.
 *
 * Verbs:
 *   sym status                              live connectors + tool count
 *   sym apply                               reconcile the running agent to the file
 *   sym mcp ls                              list connectors in the config file
 *   sym mcp add --json '<ConnectorConfig>'  add/replace a connector (generic)
 *   sym mcp add --name N --command C [--arg A]… [--trust]   stdio shorthand
 *   sym mcp add --name N --url U [--trust]                  http shorthand
 *   sym mcp rm  --name N                     remove a connector
 *   sym secret set <connector> <field> [value]   (value via stdin if omitted)
 *   sym secret ls                            list stored secret names (no values)
 *   sym secret rm  <connector> <field>       delete a stored secret
 *
 * Mutating `mcp` verbs write the file, then best-effort `apply` so changes go
 * live immediately; if the agent isn't reachable the file is still written and
 * the change lands on next start (or a later `sym apply`).
 */

import { argv } from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { applyReload, fetchStatus, type ReloadResponse } from './admin-client.js';
import {
  loadConfigFile,
  removeConnector,
  upsertConnector,
  writeConfigFile,
} from './config-store.js';
import { configPath } from '../mcp/source.js';

import type { ConnectorConfig, TransportConfig } from '../mcp/config.js';

const HELP = `sym — connector control plane

Usage:
  sym status                                   show live connectors + tool count
  sym apply                                    reconcile the running agent to the config file

  sym mcp ls                                   list connectors in the config file
  sym mcp add --json '<ConnectorConfig JSON>'  add/replace a connector (full generic shape)
  sym mcp add --name N --command C [--arg A]…   stdio shorthand (repeat --arg per token)
  sym mcp add --name N --url U                  http shorthand
        [--trust]                              skip the confirm-before-destructive gate
  sym mcp rm --name N                           remove a connector

  sym secret set <connector> <field> [value]   store a secret (value via stdin if omitted)
  sym secret ls                                 list stored secret names (never values)
  sym secret rm <connector> <field>            delete a stored secret

Secrets live in the encrypted store (SYM_ENCRYPTION_KEY); the config file holds
wiring only. The config file is SYM_CONFIG_PATH (default .sym/config.json).`;

/** Read all of stdin as a trimmed string (for piping secret values). */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').trim();
}

/** Pretty one-line-per-connector reload report. */
function printReload(r: ReloadResponse): void {
  console.log(`source: ${r.source} (${r.path}) — ${r.totalTools} tool(s) live`);
  for (const c of r.connectors) {
    const tools = `${c.tools} tool(s)`;
    const err = c.error !== undefined ? ` — ${c.error}` : '';
    console.log(`  ${c.status.padEnd(20)} ${c.name}  ${tools}${err}`);
  }
}

// ---------------------------------------------------------------------------
// mcp verbs
// ---------------------------------------------------------------------------

/** Build a ConnectorConfig from `mcp add` shorthand/JSON flags. Exported for tests. */
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
      throw new Error('--json connector must have a non-empty "name"');
    }
    return parsed;
  }

  if (values.name === undefined || values.name.length === 0) {
    throw new Error('mcp add requires --name (or --json)');
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
    throw new Error('mcp add requires --command (stdio) or --url (http), or use --json');
  }

  return {
    name: values.name,
    transport,
    ...(values.trust === true ? { trust: true } : {}),
  };
}

async function mcpCommand(argv: string[]): Promise<number> {
  const verb = argv[0];
  const path = configPath();

  if (verb === 'ls' || verb === 'list') {
    const cfg = loadConfigFile(path);
    if (cfg.mcpServers.length === 0) {
      console.log(`(no connectors in ${path})`);
      return 0;
    }
    console.log(`${cfg.mcpServers.length} connector(s) in ${path}:`);
    for (const s of cfg.mcpServers) {
      const kind = s.transport.kind;
      const auth = s.auth?.kind ?? 'none';
      const trust = s.trust === true ? ' [trust]' : '';
      console.log(`  ${s.name.padEnd(20)} ${kind}  auth:${auth}${trust}`);
    }
    return 0;
  }

  if (verb === 'add') {
    const { values } = parseArgs({
      args: argv.slice(1),
      options: {
        json: { type: 'string' },
        name: { type: 'string' },
        command: { type: 'string' },
        arg: { type: 'string', multiple: true },
        url: { type: 'string' },
        trust: { type: 'boolean' },
      },
      allowPositionals: false,
    });
    const connector = connectorFromAddFlags(values);
    const next = upsertConnector(loadConfigFile(path), connector);
    writeConfigFile(path, next);
    console.log(`wrote ${connector.name} to ${path}`);
    await tryApply();
    return 0;
  }

  if (verb === 'rm' || verb === 'remove') {
    const { values } = parseArgs({
      args: argv.slice(1),
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
    await tryApply();
    return 0;
  }

  throw new Error(`unknown 'mcp' verb '${verb ?? ''}' — see 'sym help'`);
}

/** Best-effort reconcile after a file edit; a down agent is a soft note, not an error. */
async function tryApply(): Promise<void> {
  try {
    printReload(await applyReload());
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

async function secretCommand(argv: string[]): Promise<number> {
  const verb = argv[0];
  // Lazy import: only `sym secret` needs the SQLite-backed store, so non-secret
  // verbs don't load node:sqlite (avoids its experimental warning + the open).
  const { listSecrets, removeSecret, setSecret } = await import('./secrets.js');

  if (verb === 'set') {
    const connector = argv[1];
    const field = argv[2];
    if (connector === undefined || field === undefined) {
      throw new Error('secret set requires <connector> <field> [value]');
    }
    const value = argv[3] ?? (await readStdin());
    if (value.length === 0) {
      throw new Error('no secret value provided (pass as the last arg or pipe via stdin)');
    }
    setSecret(connector, field, value);
    console.log(`stored secret ${connector}/${field}`);
    return 0;
  }

  if (verb === 'ls' || verb === 'list') {
    const refs = listSecrets();
    if (refs.length === 0) {
      console.log('(no secrets stored)');
      return 0;
    }
    for (const r of refs) console.log(`  ${r.connector}/${r.field}`);
    return 0;
  }

  if (verb === 'rm' || verb === 'remove') {
    const connector = argv[1];
    const field = argv[2];
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

async function main(argv: string[]): Promise<number> {
  const [group, ...rest] = argv;

  switch (group) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return 0;

    case 'status': {
      const s = await fetchStatus();
      console.log(
        s.connectors.length > 0
          ? `${s.connectors.length} connector(s) live (${s.totalTools} tool(s)): ${s.connectors.join(', ')}`
          : 'no connectors live (0 tools)',
      );
      return 0;
    }

    case 'apply':
      printReload(await applyReload());
      return 0;

    case 'mcp':
      return mcpCommand(rest);

    case 'secret':
      return secretCommand(rest);

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
      console.error(`sym: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
}
