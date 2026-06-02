/**
 * SecretsManager — TUI screen for viewing, adding, and deleting stored secrets.
 *
 * LIST mode: renders a Table of stored SecretRefs cross-referenced against the
 * config file so orphan secrets are visually flagged. Keys: ↑↓ move, [a] add,
 * [d] delete selected, [b/esc] back.
 *
 * ADD mode: a 3-step TextInput flow — connector → field → value (masked). On
 * submit calls setSecret and reloads the list. Escape returns to list.
 *
 * TextInput timing note: each step uses a dedicated ref to track the latest
 * value synchronously alongside React state, so onSubmit always reads the
 * current value even if the React commit hasn't landed yet (mirrors AddScreen).
 */

import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useCallback, useEffect, useRef, useState } from 'react';

import { loadConfigFile } from '../../cli/config-store.js';
import { listSecrets, removeSecret, setSecret } from '../../cli/secrets.js';
import { configPath } from '../../mcp/source.js';
import { Footer, Frame, Table, type Cell } from '../ui/components.js';
import { COLORS } from '../ui/theme.js';

import type { SecretRef } from '../../mcp/store.js';
import type { ScreenProps } from '../types.js';

// ---------------------------------------------------------------------------
// Column layout
// ---------------------------------------------------------------------------

const COLUMNS = [
  { header: 'CONNECTOR', width: 20 },
  { header: 'FIELD', width: 28 },
  { header: 'REF', width: 12 },
];

// ---------------------------------------------------------------------------
// ADD-mode step type
// ---------------------------------------------------------------------------

type AddStep = 'connector' | 'field' | 'value';

function stepLabel(step: AddStep): string {
  if (step === 'connector') return 'connector name';
  if (step === 'field') return 'field name';
  return 'secret value';
}

// ---------------------------------------------------------------------------
// AddFlow sub-component — isolated step state avoids shared-reset races
// ---------------------------------------------------------------------------

interface AddFlowProps {
  onDone: (connector: string, field: string, value: string) => void;
  onCancel: () => void;
  error: string | undefined;
}

function AddFlow({ onDone, onCancel, error }: AddFlowProps): React.ReactElement {
  const [step, setStep] = useState<AddStep>('connector');
  const [connectorVal, setConnectorVal] = useState('');
  const [fieldVal, setFieldVal] = useState('');
  const [valueVal, setValueVal] = useState('');

  // Per-field refs so onSubmit reads synchronously even before React commit
  const connectorRef = useRef('');
  const fieldRef = useRef('');
  const valueRef = useRef('');

  useInput((_input, key) => {
    if (key.escape) onCancel();
  });

  if (step === 'connector') {
    return (
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text bold>Add secret</Text>
        </Box>
        <Box>
          <Text>{stepLabel('connector')}: </Text>
          <TextInput
            value={connectorVal}
            onChange={(v) => {
              connectorRef.current = v;
              setConnectorVal(v);
            }}
            onSubmit={() => {
              const val = connectorRef.current.trim();
              if (val.length > 0) {
                setStep('field');
              }
            }}
          />
        </Box>
        <Footer
          keys={[
            { key: '↵', label: 'next' },
            { key: 'esc', label: 'cancel' },
          ]}
        />
      </Box>
    );
  }

  if (step === 'field') {
    return (
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text bold>Add secret</Text>
          <Text dimColor> · connector: {connectorRef.current || connectorVal}</Text>
        </Box>
        <Box>
          <Text>{stepLabel('field')}: </Text>
          <TextInput
            value={fieldVal}
            onChange={(v) => {
              fieldRef.current = v;
              setFieldVal(v);
            }}
            onSubmit={() => {
              const val = fieldRef.current.trim();
              if (val.length > 0) {
                setStep('value');
              }
            }}
          />
        </Box>
        <Footer
          keys={[
            { key: '↵', label: 'next' },
            { key: 'esc', label: 'cancel' },
          ]}
        />
      </Box>
    );
  }

  // value step
  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold>Add secret</Text>
        <Text dimColor>
          {' '}
          · {connectorRef.current || connectorVal} / {fieldRef.current || fieldVal}
        </Text>
      </Box>
      <Box>
        <Text>{stepLabel('value')}: </Text>
        <TextInput
          value={valueVal}
          onChange={(v) => {
            valueRef.current = v;
            setValueVal(v);
          }}
          onSubmit={() => {
            onDone(
              connectorRef.current || connectorVal,
              fieldRef.current || fieldVal,
              valueRef.current || valueVal,
            );
          }}
          mask="*"
        />
      </Box>
      {error !== undefined && (
        <Box marginTop={1}>
          <Text color={COLORS.bad}>{error}</Text>
        </Box>
      )}
      <Footer
        keys={[
          { key: '↵', label: 'save' },
          { key: 'esc', label: 'cancel' },
        ]}
      />
    </Box>
  );
}

// ---------------------------------------------------------------------------
// SecretsManager
// ---------------------------------------------------------------------------

export function SecretsManager({ onBack }: ScreenProps): React.ReactElement {
  const [mode, setMode] = useState<'list' | 'add'>('list');
  const [secrets, setSecrets] = useState<SecretRef[]>([]);
  const [configuredNames, setConfiguredNames] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState(0);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  // -------------------------------------------------------------------------
  // Data loading
  // -------------------------------------------------------------------------

  const loadData = useCallback((): void => {
    try {
      const refs = listSecrets();
      setSecrets(refs);
      setUnavailable(false);
    } catch {
      setSecrets([]);
      setUnavailable(true);
    }

    try {
      const cfg = loadConfigFile(configPath());
      setConfiguredNames(new Set(cfg.mcpServers.map((s) => s.name)));
    } catch {
      setConfiguredNames(new Set());
    }
  }, []);

  useEffect(loadData, [loadData]);

  // -------------------------------------------------------------------------
  // Key handling — LIST mode
  // -------------------------------------------------------------------------

  useInput(
    (input, key) => {
      if (key.upArrow) {
        setCursor((c) => Math.max(0, c - 1));
      } else if (key.downArrow) {
        setCursor((c) => Math.min(Math.max(0, secrets.length - 1), c + 1));
      } else if (input === 'a') {
        setError(undefined);
        setMode('add');
      } else if (input === 'd') {
        const sel = secrets[cursor];
        if (sel !== undefined) {
          try {
            removeSecret(sel.connector, sel.field);
            setError(undefined);
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          }
          loadData();
          setCursor((c) => Math.min(c, Math.max(0, secrets.length - 2)));
        }
      } else if (input === 'b' || key.escape) {
        onBack();
      }
    },
    { isActive: mode === 'list' },
  );

  // -------------------------------------------------------------------------
  // ADD done / cancel handlers
  // -------------------------------------------------------------------------

  const handleAddDone = (connector: string, field: string, value: string): void => {
    try {
      setSecret(connector, field, value);
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    loadData();
    setMode('list');
  };

  const handleAddCancel = (): void => {
    setError(undefined);
    setMode('list');
  };

  // -------------------------------------------------------------------------
  // Derive table rows
  // -------------------------------------------------------------------------

  const rows: Cell[][] = secrets.map((ref) => {
    const referenced = configuredNames.has(ref.connector);
    return [
      { text: ref.connector },
      { text: ref.field, dim: true },
      referenced ? { text: 'referenced', color: COLORS.ok } : { text: 'orphan', dim: true },
    ];
  });

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <Frame title="sym · secrets">
      {unavailable ? (
        <Box marginBottom={1}>
          <Text color={COLORS.warn}>secrets unavailable — set SYM_ENCRYPTION_KEY</Text>
        </Box>
      ) : mode === 'add' ? (
        <AddFlow onDone={handleAddDone} onCancel={handleAddCancel} error={error} />
      ) : (
        <>
          <Table columns={COLUMNS} rows={rows} selected={cursor} />
          {error !== undefined && (
            <Box marginTop={1}>
              <Text color={COLORS.bad}>{error}</Text>
            </Box>
          )}
          <Footer
            keys={[
              { key: '↑↓', label: 'move' },
              { key: 'a', label: 'add' },
              { key: 'd', label: 'delete' },
              { key: 'b/esc', label: 'back' },
            ]}
          />
        </>
      )}
    </Frame>
  );
}
