/**
 * `sym` interactive menu — a simple, line-based front-end over the same commands
 * the CLI exposes (status / connector / tools / secret). Launched by bare `sym`
 * on a terminal, or `sym menu`. Replaces the old Ink TUI: nothing full-screen,
 * nothing to navigate — just a prompt loop.
 *
 * Every action delegates to the real command functions (so there is ONE source
 * of truth for behaviour); the interactive flows only gather inputs.
 */

import * as p from '@clack/prompts';

import { configPath } from '@sym/mcp-runtime';

import { applyReload, fetchConnectors } from './admin-client.js';
import { connectorCommand } from './commands/connector.js';
import { printReload } from './commands/render.js';
import { statusCommand } from './commands/status.js';
import { toolsCommand } from './commands/tools.js';
import { loadConfigFile, setConnectorTrust, writeConfigFile } from './config-store.js';

/** Run the interactive menu loop until the user quits. Returns 0. */
export async function launchMenu(): Promise<number> {
  p.intro('sym — connector control plane');

  for (;;) {
    const action = await p.select({
      message: 'What would you like to do?',
      options: [
        { value: 'status', label: 'Status', hint: 'agent health + every connector' },
        { value: 'list', label: 'List connectors' },
        { value: 'add', label: 'Add a connector' },
        { value: 'reconnect', label: 'Reconnect a connector' },
        { value: 'trust', label: 'Trust connectors', hint: 'toggle which skip the confirm gate' },
        { value: 'secrets', label: 'Manage secrets' },
        { value: 'tools', label: 'List tools' },
        { value: 'apply', label: 'Apply config (reconcile the running agent)' },
        { value: 'quit', label: 'Quit' },
      ],
    });

    if (p.isCancel(action) || action === 'quit') break;

    try {
      await runAction(action);
    } catch (err) {
      p.log.error(err instanceof Error ? err.message : String(err));
    }
  }

  p.outro('bye');
  return 0;
}

async function runAction(action: string): Promise<void> {
  switch (action) {
    case 'status':
      await statusCommand(false);
      return;
    case 'list':
      await connectorCommand(['ls'], false);
      return;
    case 'tools':
      await toolsCommand(undefined, false);
      return;
    case 'apply':
      printReload(await applyReload(), false);
      return;
    case 'add':
      await addConnectorFlow();
      return;
    case 'reconnect':
      await reconnectFlow();
      return;
    case 'trust':
      await trustFlow();
      return;
    case 'secrets':
      await secretsFlow();
      return;
  }
}

/** Prompt for the fields, then delegate to `connector add` (build + write + apply). */
async function addConnectorFlow(): Promise<void> {
  const name = await p.text({
    message: 'Connector name',
    validate: (v) => ((v ?? '').trim().length > 0 ? undefined : 'required'),
  });
  if (p.isCancel(name)) return;

  const kind = await p.select({
    message: 'Transport',
    options: [
      { value: 'stdio', label: 'stdio', hint: 'spawn a local command' },
      { value: 'http', label: 'http', hint: 'connect to a remote URL' },
    ],
  });
  if (p.isCancel(kind)) return;

  const args = ['add', '--name', name.trim()];

  if (kind === 'stdio') {
    const command = await p.text({
      message: 'Command (binary to spawn)',
      validate: (v) => ((v ?? '').trim().length > 0 ? undefined : 'required'),
    });
    if (p.isCancel(command)) return;
    args.push('--command', command.trim());

    const argStr = await p.text({ message: 'Args (space-separated, optional)', defaultValue: '' });
    if (p.isCancel(argStr)) return;
    for (const a of argStr.trim().split(/\s+/).filter(Boolean)) args.push('--arg', a);
  } else {
    const url = await p.text({
      message: 'URL (https://…)',
      validate: (v) =>
        (v ?? '').trim().startsWith('https://') ? undefined : 'must be an https:// URL',
    });
    if (p.isCancel(url)) return;
    args.push('--url', url.trim());
  }

  const trust = await p.confirm({
    message: 'Trust this connector (skip the confirm-before-destructive gate)?',
    initialValue: false,
  });
  if (p.isCancel(trust)) return;
  if (trust) args.push('--trust');

  await connectorCommand(args, false);
}

/** Pick a connector from the live pool (or the config file if the agent is down), then reconnect it. */
async function reconnectFlow(): Promise<void> {
  let names: string[];
  try {
    names = (await fetchConnectors()).map((c) => c.name);
  } catch {
    names = loadConfigFile(configPath()).mcpServers.map((s) => s.name);
  }
  if (names.length === 0) {
    p.log.warn('no MCP connectors configured');
    return;
  }
  const name = await p.select({
    message: 'Reconnect which connector?',
    options: names.map((n) => ({ value: n, label: n })),
  });
  if (p.isCancel(name)) return;
  await connectorCommand(['reconnect', name], false);
}

/**
 * Toggle which connectors are trusted via a checkbox list — the easy "trust all
 * or none" surface. Checked = trusted (skips the confirm-before-destructive gate).
 * Writes the config + reconciles the running pool.
 */
async function trustFlow(): Promise<void> {
  const path = configPath();
  const cfg = loadConfigFile(path);
  if (cfg.mcpServers.length === 0) {
    p.log.warn('no MCP connectors configured');
    return;
  }
  const selected = await p.multiselect({
    message:
      'Trusted connectors — checked ones skip the confirm-before-destructive gate (space toggles, enter confirms):',
    options: cfg.mcpServers.map((s) => ({ value: s.name, label: s.name })),
    initialValues: cfg.mcpServers.filter((s) => s.trust === true).map((s) => s.name),
    required: false,
  });
  if (p.isCancel(selected)) return;

  const trusted = new Set(selected);
  let next = cfg;
  for (const s of cfg.mcpServers) next = setConnectorTrust(next, s.name, trusted.has(s.name));
  writeConfigFile(path, next);

  try {
    printReload(await applyReload(), false);
  } catch {
    p.log.warn('config written; not applied (agent not running — run `sym apply` once it is up)');
  }
  p.log.success(`trusted: ${[...trusted].join(', ') || '(none)'}`);
}

/** Interactive secret management. The value is read from a hidden prompt (never argv). */
async function secretsFlow(): Promise<void> {
  const { listSecrets, removeSecret, setSecret } = await import('./secrets.js');

  const op = await p.select({
    message: 'Secrets',
    options: [
      { value: 'ls', label: 'List' },
      { value: 'set', label: 'Set' },
      { value: 'rm', label: 'Remove' },
    ],
  });
  if (p.isCancel(op)) return;

  if (op === 'ls') {
    const refs = listSecrets();
    if (refs.length === 0) p.log.info('(no secrets stored)');
    else for (const r of refs) p.log.message(`${r.connector}/${r.field}`);
    return;
  }

  const connector = await p.text({
    message: 'Connector',
    validate: (v) => ((v ?? '').trim().length > 0 ? undefined : 'required'),
  });
  if (p.isCancel(connector)) return;
  const field = await p.text({
    message: 'Field',
    validate: (v) => ((v ?? '').trim().length > 0 ? undefined : 'required'),
  });
  if (p.isCancel(field)) return;

  if (op === 'rm') {
    removeSecret(connector.trim(), field.trim());
    p.log.success(`removed secret ${connector.trim()}/${field.trim()}`);
    return;
  }

  const value = await p.password({
    message: 'Secret value (hidden)',
    validate: (v) => ((v ?? '').length > 0 ? undefined : 'required'),
  });
  if (p.isCancel(value)) return;
  setSecret(connector.trim(), field.trim(), value);
  p.log.success(`stored secret ${connector.trim()}/${field.trim()}`);
}
