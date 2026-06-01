/**
 * StatusScreen — read-only dashboard showing the live connector status
 * from a running Sym agent alongside the connectors defined in the config
 * file. Supports apply (a), refresh (r), and back (b/esc) key bindings.
 */

import { Box, Text, useInput } from 'ink';
import React, { useEffect, useState } from 'react';

import { applyReload, fetchStatus } from '../../cli/admin-client.js';
import { loadConfigFile } from '../../cli/config-store.js';
import { configPath } from '../../mcp/source.js';

import type { ConnectorConfig } from '../../mcp/config.js';
import type { ScreenProps } from '../types.js';

// ---------------------------------------------------------------------------
// Component state types
// ---------------------------------------------------------------------------

interface StatusState {
  loading: boolean;
  // Explicit `| undefined` (not `error?:`) so the reducers can clear it by
  // assigning `undefined` under exactOptionalPropertyTypes.
  error: string | undefined;
  liveConnectors: string[];
  totalTools: number;
  configConnectors: ConnectorConfig[];
  cfgPath: string;
}

// ---------------------------------------------------------------------------
// StatusScreen
// ---------------------------------------------------------------------------

/**
 * A terminal dashboard screen that shows live agent connector status alongside
 * the connector list from the config file. Keyboard shortcuts: [a] apply/reload,
 * [r] refresh status, [b/esc] go back.
 */
export function StatusScreen({ onBack }: ScreenProps): React.ReactElement {
  const [state, setState] = useState<StatusState>({
    loading: true,
    error: undefined,
    liveConnectors: [],
    totalTools: 0,
    configConnectors: [],
    cfgPath: configPath(),
  });
  const [busy, setBusy] = useState(false);

  // Load data: config file (sync) + live status (async)
  const loadData = (): void => {
    setState((prev) => ({ ...prev, loading: true, error: undefined }));

    const path = configPath();

    // Load config file synchronously — never throws (returns empty on missing)
    let configConnectors: ConnectorConfig[] = [];
    try {
      const cfg = loadConfigFile(path);
      configConnectors = cfg.mcpServers;
    } catch {
      // Non-fatal: we still show live status
      configConnectors = [];
    }

    // Load live status asynchronously
    fetchStatus()
      .then((status) => {
        setState({
          loading: false,
          error: undefined,
          liveConnectors: status.connectors,
          totalTools: status.totalTools,
          configConnectors,
          cfgPath: path,
        });
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        setState({
          loading: false,
          error: msg,
          liveConnectors: [],
          totalTools: 0,
          configConnectors,
          cfgPath: path,
        });
      });
  };

  // Initial load on mount — deps intentionally empty (loadData is stable per mount)
  useEffect(() => {
    loadData();
  }, []);

  // Key bindings
  useInput((input, key) => {
    if (input === 'b' || key.escape) {
      onBack();
      return;
    }
    if (input === 'r') {
      if (!busy) {
        loadData();
      }
      return;
    }
    if (input === 'a') {
      if (busy) return;
      setBusy(true);
      applyReload()
        .then(() => {
          setBusy(false);
          loadData();
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          setState((prev) => ({ ...prev, error: msg, loading: false }));
          setBusy(false);
        });
    }
  });

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const { loading, error, liveConnectors, totalTools, configConnectors, cfgPath } = state;

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* Title */}
      <Box marginBottom={1}>
        <Text bold color="cyan">
          Sym · Connector Status
        </Text>
      </Box>

      {/* Config file section */}
      <Box flexDirection="column" marginBottom={1}>
        <Text bold>
          Config file ({cfgPath}): {configConnectors.length} connector(s)
        </Text>
        {configConnectors.length === 0 ? (
          <Text dimColor> (none configured)</Text>
        ) : (
          configConnectors.map((c) => (
            <Text key={c.name}>
              {'  '}
              <Text color="green">{c.name}</Text>
              <Text dimColor> [{c.transport.kind}]</Text>
            </Text>
          ))
        )}
      </Box>

      {/* Live status section */}
      <Box flexDirection="column" marginBottom={1}>
        {loading ? (
          <Text dimColor>Loading live status…</Text>
        ) : error !== undefined ? (
          <Text color="yellow">{error} — start Sym, then press r</Text>
        ) : (
          <Text>
            <Text bold>Live: </Text>
            <Text color="cyan">{totalTools}</Text>
            <Text> tool(s) across </Text>
            <Text color="green">
              {liveConnectors.length === 0 ? '(no connectors)' : liveConnectors.join(', ')}
            </Text>
          </Text>
        )}
      </Box>

      {/* Busy indicator */}
      {busy && (
        <Box marginBottom={1}>
          <Text dimColor>Applying…</Text>
        </Box>
      )}

      {/* Footer */}
      <Box>
        <Text dimColor>[a] apply [r] refresh [b/esc] back</Text>
      </Box>
    </Box>
  );
}
