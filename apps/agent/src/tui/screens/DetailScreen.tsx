/**
 * DetailScreen — inspect a single connector: config block, live tools table,
 * and in-place actions (test, edit, remove). Gracefully degrades when the
 * agent is unreachable (config still loads from disk; tools show a note).
 */

import { Box, Text, useInput } from 'ink';
import { useEffect, useState } from 'react';

import { configPath } from '@sym/mcp-runtime';

import {
  applyReload,
  fetchConnectors,
  fetchConnectorTools,
  testConnector,
} from '../../cli/admin-client.js';
import { loadConfigFile, removeConnector, writeConfigFile } from '../../cli/config-store.js';
import { Footer, Frame, Header, Table } from '../ui/components.js';
import { COLORS, healthGlyph } from '../ui/theme.js';

import type { ConnectorDetail, ToolInfo } from '../../cli/admin-client.js';
import type { DetailProps } from '../types.js';
import type { Cell } from '../ui/components.js';
import type { ConnectorConfig } from '@sym/mcp-runtime';

const TOOL_COLUMNS = [
  { header: 'NAME', width: 24 },
  { header: 'DESCRIPTION', width: 52 },
];

export function DetailScreen({ onBack, connector, onEdit }: DetailProps): React.ReactElement {
  const [detail, setDetail] = useState<ConnectorDetail | undefined>(undefined);
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [config, setConfig] = useState<ConnectorConfig | undefined>(undefined);
  const [reachable, setReachable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | undefined>(undefined);

  const loadData = (): void => {
    // (a) connector detail (health/transport/auth/trust) from agent
    fetchConnectors()
      .then((list) => {
        setReachable(true);
        const found = list.find((d) => d.name === connector);
        setDetail(found);
      })
      .catch(() => {
        setReachable(false);
        setDetail(undefined);
      });

    // (b) live tools
    fetchConnectorTools(connector)
      .then((list) => {
        setTools(list);
      })
      .catch(() => {
        setTools([]);
      });

    // (c) config object from disk
    try {
      const cfg = loadConfigFile(configPath());
      const found = cfg.mcpServers.find((s) => s.name === connector);
      setConfig(found);
    } catch {
      setConfig(undefined);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  useInput((input, key) => {
    if (busy) return;

    if (input === 't') {
      setBusy(true);
      setNote(`testing ${connector}…`);
      testConnector(connector)
        .then((res) => {
          setNote(`reconnected (${res.status.tools} tools)`);
          setTools(res.tools);
          setReachable(true);
        })
        .catch((err: unknown) => {
          setNote(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          setBusy(false);
        });
    } else if (input === 'e') {
      onEdit(connector);
    } else if (input === 'x') {
      setBusy(true);
      setNote(`removing ${connector}…`);
      Promise.resolve()
        .then(() => {
          const path = configPath();
          const cfg = loadConfigFile(path);
          const { next } = removeConnector(cfg, connector);
          writeConfigFile(path, next);
        })
        .then(() => applyReload().catch(() => undefined))
        .then(() => {
          onBack();
        })
        .catch((err: unknown) => {
          setNote(err instanceof Error ? err.message : String(err));
          setBusy(false);
        });
    } else if (input === 'b' || key.escape) {
      onBack();
    }
  });

  // Build the detail row from agent data or offline fallback
  const h = detail !== undefined ? healthGlyph(detail) : { glyph: '○', color: COLORS.dim };
  const transport = detail?.transport ?? config?.transport.kind ?? '—';
  const auth = detail?.auth ?? config?.auth?.kind ?? 'none';
  const trust = detail?.trust ?? config?.trust ?? false;
  const totalTools = tools.length;

  const toolRows: Cell[][] = tools.map((t) => [
    { text: t.name },
    { text: t.description, dim: true },
  ]);

  const agentDown = !reachable;
  const toolsNote = agentDown ? 'agent not reachable — tool list unavailable' : undefined;

  const configJson =
    config !== undefined ? JSON.stringify(config, null, 2) : '(not found in config file)';

  return (
    <Frame title={`sym · ${connector}`}>
      <Header reachable={reachable} totalTools={totalTools} configPath={configPath()} />

      {/* Config section */}
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color={COLORS.accent}>
          connector
        </Text>
        <Box marginLeft={2} flexDirection="column">
          <Text>
            <Text dimColor>transport </Text>
            <Text>{transport}</Text>
          </Text>
          <Text>
            <Text dimColor>auth </Text>
            <Text>{auth}</Text>
          </Text>
          <Text>
            <Text dimColor>trust </Text>
            <Text {...(trust ? { color: COLORS.ok } : { color: COLORS.dim })}>
              {trust ? 'yes' : 'no'}
            </Text>
          </Text>
          <Text>
            <Text dimColor>health </Text>
            <Text color={h.color}>{h.glyph}</Text>
          </Text>
        </Box>
        <Box marginTop={1} marginLeft={2}>
          <Text dimColor>{configJson}</Text>
        </Box>
      </Box>

      {/* Tools table */}
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color={COLORS.accent}>
          tools
        </Text>
        {toolsNote !== undefined ? (
          <Box marginLeft={2}>
            <Text color={COLORS.warn}>{toolsNote}</Text>
          </Box>
        ) : (
          <Table columns={TOOL_COLUMNS} rows={toolRows} />
        )}
      </Box>

      {/* Note / status line */}
      {note !== undefined && (
        <Box marginTop={1}>
          <Text dimColor>{note}</Text>
        </Box>
      )}

      <Footer
        keys={[
          { key: 't', label: 'test' },
          { key: 'e', label: 'edit' },
          { key: 'x', label: 'remove' },
          { key: 'b/esc', label: 'back' },
        ]}
      />
    </Frame>
  );
}
