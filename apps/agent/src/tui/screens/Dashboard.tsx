/**
 * Dashboard — the TUI home. A live, auto-refreshing table of connectors with
 * health, transport/auth, and tool counts, plus actions: open detail, apply,
 * test, add, secrets. Falls back to the config file (offline view) when the
 * agent isn't reachable.
 */

import { Box, Text, useInput } from 'ink';
import { useEffect, useState } from 'react';

import { configPath } from '@sym/mcp-runtime';

import { applyReload, fetchConnectors, testConnector } from '../../cli/admin-client.js';
import { loadConfigFile } from '../../cli/config-store.js';
import { isCliWildcard, resolveCliConnectors } from '../../run-cli.js';
import { Footer, Frame, Header, Table, type Cell } from '../ui/components.js';
import { COLORS, healthGlyph } from '../ui/theme.js';
import { useInterval } from '../ui/useInterval.js';

import type { ConnectorDetail } from '../../cli/admin-client.js';
import type { DashboardProps } from '../types.js';

const COLUMNS = [
  { header: 'NAME', width: 18 },
  { header: 'TRANSPORT', width: 9 },
  { header: 'AUTH', width: 8 },
  { header: 'HEALTH', width: 12 },
  { header: 'TOOLS', width: 5 },
];

const REFRESH_MS = 3000;

/** Build offline rows from the config file when the agent is unreachable. */
function offlineDetails(): ConnectorDetail[] {
  try {
    return loadConfigFile(configPath()).mcpServers.map((s) => ({
      name: s.name,
      transport: s.transport.kind,
      auth: s.auth?.kind ?? 'none',
      trust: s.trust === true,
      ok: false,
      tools: 0,
    }));
  } catch {
    return [];
  }
}

export function Dashboard({
  onOpen,
  onAdd,
  onSecrets,
  onQuit,
}: DashboardProps): React.ReactElement {
  const [connectors, setConnectors] = useState<ConnectorDetail[]>([]);
  const [reachable, setReachable] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | undefined>(undefined);

  const load = (): void => {
    fetchConnectors()
      .then((list) => {
        setReachable(true);
        setConnectors(list);
      })
      .catch(() => {
        setReachable(false);
        setConnectors(offlineDetails());
      });
  };

  useEffect(load, []);
  useInterval(load, busy ? null : REFRESH_MS);

  const selected = connectors[cursor];
  const totalTools = connectors.reduce((sum, c) => sum + c.tools, 0);

  useInput((input, key) => {
    if (busy) return;
    if (key.upArrow || input === 'k') setCursor((c) => Math.max(0, c - 1));
    else if (key.downArrow || input === 'j')
      setCursor((c) => Math.min(connectors.length - 1, c + 1));
    else if (key.return && selected !== undefined) onOpen(selected.name);
    else if (input === 'n') onAdd();
    else if (input === 's') onSecrets();
    else if (input === 'r') load();
    else if (input === 'q') onQuit();
    else if (input === 'a') {
      setBusy(true);
      setNote('applying…');
      applyReload()
        .then((res) => setNote(`applied — ${res.totalTools} tool(s) live`))
        .catch((err: unknown) => setNote(err instanceof Error ? err.message : String(err)))
        .finally(() => {
          setBusy(false);
          load();
        });
    } else if (input === 't' && selected !== undefined) {
      setBusy(true);
      setNote(`testing ${selected.name}…`);
      testConnector(selected.name)
        .then((res) =>
          setNote(`${selected.name}: ${res.status.status} (${res.status.tools} tools)`),
        )
        .catch((err: unknown) => setNote(err instanceof Error ? err.message : String(err)))
        .finally(() => {
          setBusy(false);
          load();
        });
    }
  });

  const rows: Cell[][] = connectors.map((c) => {
    const h = healthGlyph(c);
    return [
      { text: c.name },
      { text: c.transport, dim: true },
      { text: c.auth, dim: true },
      {
        text: `${h.glyph} ${c.ok ? 'connected' : c.error !== undefined ? 'failed' : 'down'}`,
        color: h.color,
      },
      { text: String(c.tools) },
    ];
  });

  // CLI connectors (config + PATH check) — same canonical source as every surface.
  const cliConnectors = resolveCliConnectors();
  const cliWildcard = isCliWildcard();

  return (
    <Frame title="sym · connectors">
      <Header reachable={reachable} totalTools={totalTools} configPath={configPath()} />
      <Table columns={COLUMNS} rows={rows} selected={cursor} />
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>CLIs (run_cli):</Text>
        {cliConnectors.length === 0 && !cliWildcard && <Text dimColor> (none)</Text>}
        {cliConnectors.map((c) => (
          <Text key={c.bin}>
            {'  '}
            <Text color={c.onPath ? COLORS.ok : COLORS.bad}>{c.onPath ? '●' : '○'}</Text> {c.bin}
            {c.description !== undefined ? <Text dimColor> — {c.description}</Text> : null}
          </Text>
        ))}
        {cliWildcard && <Text dimColor> …plus any installed CLI (*)</Text>}
      </Box>
      {selected?.error !== undefined && (
        <Box marginTop={1}>
          <Text color={COLORS.warn}>
            ⚠ {selected.name}: {selected.error}
          </Text>
        </Box>
      )}
      {note !== undefined && (
        <Box marginTop={1}>
          <Text dimColor>{note}</Text>
        </Box>
      )}
      <Footer
        keys={[
          { key: '↑↓', label: 'move' },
          { key: '↵', label: 'detail' },
          { key: 'a', label: 'apply' },
          { key: 't', label: 'test' },
          { key: 'n', label: 'new' },
          { key: 's', label: 'secrets' },
          { key: 'r', label: 'refresh' },
          { key: 'q', label: 'quit' },
        ]}
      />
    </Frame>
  );
}
