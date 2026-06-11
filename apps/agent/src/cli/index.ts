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
 * This module is the entry point: it owns the `--json` flag, the help text, and
 * the command dispatch. Each command lives in `./commands/`.
 */

import { argv } from 'node:process';
import { fileURLToPath } from 'node:url';

import { configPath } from '@sym/mcp-runtime';

import { applyReload } from './admin-client.js';
import { connectorCommand } from './commands/connector.js';
import { personaCommand } from './commands/persona.js';
import { printReload } from './commands/render.js';
import { secretCommand } from './commands/secret.js';
import { statusCommand } from './commands/status.js';
import { toolsCommand } from './commands/tools.js';

// Re-exported for tests (tests/cli.index.test.ts builds connectors from flags).
export { connectorFromAddFlags } from './commands/connector.js';

const HELP = `sym — connector control plane

A "connector" is anything Sym reaches the outside world with: an MCP connector
(structured tools, used via find_tools → call_tool) OR a CLI (used via run_cli).
One surface manages both.

  sym  /  sym menu                              interactive menu

Inspect (add --json for machine/agent-parseable output):
  sym status                                   agent health + every connector + tool counts
  sym connector ls                             all connectors (MCP + CLI): health, tools, descriptions
  sym connector show <name>                    one connector in full
  sym tools [name]                             every tool — MCP tools (call_tool) + CLIs (run_cli)
  sym persona [ls]                             the voices Sym speaks in + the deployment's home voice
  sym persona show [name]                      one persona (defaults to the home voice)

Manage:
  sym connector add --name N --command C       add an MCP connector (stdio; repeat --arg per token)
  sym connector add --name N --url U [--trust]  add an MCP connector (http)
  sym connector add --spec '<ConnectorConfig>' add an MCP connector (full generic shape)
  sym connector add --cli <bin> --desc "…"     add a CLI connector (allow + describe it)
  sym connector rm <name>                      remove a connector (MCP or CLI)
  sym connector reconnect <name>               re-connect one MCP connector against the live pool
  sym connector trust <name> | --all           trust a connector (skip the confirm gate); --all = every one
  sym connector untrust <name> | --all         require confirmation again for it (or all)
  sym apply                                    reconcile the running agent to the config file
  sym secret set|ls|rm                         manage encrypted secrets (never printed)

Connectors live in SYM_CONFIG_PATH (default .sym/config.json); secrets in the
encrypted store (SYM_ENCRYPTION_KEY).`;

/** Pull a global `--json` flag out of the args, anywhere it appears. */
function takeJsonFlag(args: string[]): { json: boolean; rest: string[] } {
  const rest = args.filter((a) => a !== '--json');
  return { json: rest.length !== args.length, rest };
}

export async function main(rawArgs: string[]): Promise<number> {
  const { json, rest } = takeJsonFlag(rawArgs);
  const [group, ...args] = rest;

  switch (group) {
    case undefined:
      // Bare `sym` on a terminal opens the interactive menu; piped/non-TTY
      // (CI, `sym | cat`, the agent's run_cli) prints help instead.
      if (process.stdout.isTTY) {
        return (await import('./menu.js')).launchMenu();
      }
      console.log(HELP);
      return 0;

    case 'menu':
    case 'tui':
      // Guard against non-TTY pipes (`sym menu | head`, the agent's run_cli).
      // The interactive prompts need a real terminal; rendering to a pipe
      // produces garbled output and hangs waiting for keystrokes.
      if (!process.stdout.isTTY) {
        console.error(`'sym ${group}' requires an interactive terminal (stdout is not a TTY).`);
        return 1;
      }
      return (await import('./menu.js')).launchMenu();

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

    case 'persona':
    case 'personas':
      return personaCommand(args, json);

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
