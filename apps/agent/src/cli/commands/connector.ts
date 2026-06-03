/**
 * `sym connector` — the ONE surface for capabilities, MCP and CLI alike.
 *
 *   ls            list every connector (MCP + CLI) with health/tools/description
 *   show <name>   one connector in full
 *   add …         add an MCP connector (--name/--command/--url/--spec) or a CLI
 *                 connector (--cli <bin> [--desc "…"])
 *   rm <name>     remove a connector (MCP or CLI, whichever owns the name)
 *
 * Adding/removing best-effort `apply`s so the change goes live without a restart;
 * if the agent isn't reachable the file is still written.
 */

import { parseArgs } from 'node:util';

import { loadCliDescribe, configPath } from '@sym/mcp-runtime';

import {
  isCliWildcard,
  resolveAllowlist,
  resolveCliCapabilities,
  resolveCliConnectors,
} from '../../run-cli.js';
import { applyReload, fetchConnectors, type ConnectorDetail } from '../admin-client.js';
import {
  loadConfigFile,
  removeCli,
  removeConnector,
  setCliAllow,
  setCliDesc,
  upsertConnector,
  writeConfigFile,
} from '../config-store.js';
import { healthWord, printReload } from './render.js';
import { showCommand } from './tools.js';

import type { ConnectorConfig, TransportConfig } from '@sym/mcp-runtime';

export async function connectorCommand(args: string[], json: boolean): Promise<number> {
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

/** Build a ConnectorConfig from `connector add` shorthand/spec flags. Exported for tests. */
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
