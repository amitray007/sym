/**
 * SecretsScreen — list, add, and remove stored secret identities (names only,
 * never values) via the encrypted credential store.
 *
 * Modes:
 *   list — shows all stored connector/field pairs + key hints.
 *   add  — 3-step TextInput flow: connector → field → value (masked).
 *
 * Missing SYM_ENCRYPTION_KEY is handled gracefully: shows a yellow hint
 * instead of crashing.
 */

import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import React, { useEffect, useState } from 'react';

import { listSecrets, setSecret, removeSecret } from '../../cli/secrets.js';

import type { SecretRef } from '../../mcp/store.js';
import type { ScreenProps } from '../types.js';

type Step = 'list' | 'connector' | 'field' | 'value';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadSecrets(): { refs: SecretRef[]; error: string | null } {
  try {
    return { refs: listSecrets(), error: null };
  } catch {
    return { refs: [], error: 'secrets unavailable — set SYM_ENCRYPTION_KEY' };
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SecretsScreen({ onBack }: ScreenProps): React.ReactElement {
  const [step, setStep] = useState<Step>('list');
  const [refs, setRefs] = useState<SecretRef[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  // ADD mode accumulated values
  const [connector, setConnector] = useState('');
  const [field, setField] = useState('');

  // Per-step TextInput values (separate to avoid shared-instance issues)
  const [connectorInput, setConnectorInput] = useState('');
  const [fieldInput, setFieldInput] = useState('');
  const [valueInput, setValueInput] = useState('');

  const [saveError, setSaveError] = useState<string | null>(null);

  function refresh(): void {
    const { refs: loaded, error } = loadSecrets();
    setRefs(loaded);
    setLoadError(error);
  }

  useEffect(() => {
    refresh();
  }, []);

  // LIST mode key handling
  useInput(
    (input, key) => {
      if (input === 'a') {
        setConnector('');
        setField('');
        setConnectorInput('');
        setFieldInput('');
        setValueInput('');
        setSaveError(null);
        setStep('connector');
      } else if (input === 'd') {
        const last = refs[refs.length - 1];
        if (last) {
          try {
            removeSecret(last.connector, last.field);
          } catch {
            // ignore — store unavailable
          }
          refresh();
        }
      } else if (input === 'b' || key.escape) {
        onBack();
      }
    },
    { isActive: step === 'list' },
  );

  // ADD mode escape handling (TextInput steps)
  useInput(
    (_input, key) => {
      if (key.escape) {
        setStep('list');
      }
    },
    { isActive: step === 'connector' || step === 'field' || step === 'value' },
  );

  // ---------------------------------------------------------------------------
  // Render — LIST step
  // ---------------------------------------------------------------------------

  if (step === 'list') {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold>Stored Secrets</Text>
        <Box marginTop={1} flexDirection="column">
          {loadError !== null ? (
            <Text color="yellow">{loadError}</Text>
          ) : refs.length === 0 ? (
            <Text dimColor>No secrets stored.</Text>
          ) : (
            refs.map((ref) => (
              <Text key={`${ref.connector}/${ref.field}`}>
                {ref.connector}/{ref.field}
              </Text>
            ))
          )}
        </Box>
        <Box marginTop={1}>
          <Text dimColor>[a] add [d] delete last [b/esc] back</Text>
        </Box>
      </Box>
    );
  }

  // ---------------------------------------------------------------------------
  // Render — CONNECTOR step
  // ---------------------------------------------------------------------------

  if (step === 'connector') {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold>Add Secret</Text>
        <Box marginTop={1}>
          <Text>Connector name: </Text>
          <TextInput
            value={connectorInput}
            onChange={setConnectorInput}
            onSubmit={(val) => {
              if (val.trim().length > 0) {
                setConnector(val.trim());
                setFieldInput('');
                setStep('field');
              }
            }}
          />
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Enter connector name, then press Enter [esc] cancel</Text>
        </Box>
      </Box>
    );
  }

  // ---------------------------------------------------------------------------
  // Render — FIELD step
  // ---------------------------------------------------------------------------

  if (step === 'field') {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold>Add Secret</Text>
        <Text>
          <Text dimColor>connector: </Text>
          {connector}
        </Text>
        <Box marginTop={1}>
          <Text>Field name: </Text>
          <TextInput
            value={fieldInput}
            onChange={setFieldInput}
            onSubmit={(val) => {
              if (val.trim().length > 0) {
                setField(val.trim());
                setValueInput('');
                setStep('value');
              }
            }}
          />
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Enter field name, then press Enter [esc] cancel</Text>
        </Box>
      </Box>
    );
  }

  // ---------------------------------------------------------------------------
  // Render — VALUE step
  // ---------------------------------------------------------------------------

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>Add Secret</Text>
      <Text>
        <Text dimColor>connector: </Text>
        {connector}
      </Text>
      <Text>
        <Text dimColor>field: </Text>
        {field}
      </Text>
      <Box marginTop={1}>
        <Text>Secret value: </Text>
        <TextInput
          value={valueInput}
          onChange={setValueInput}
          mask="*"
          onSubmit={(val) => {
            try {
              setSecret(connector, field, val);
              refresh();
              setStep('list');
            } catch (err) {
              setSaveError(err instanceof Error ? err.message : String(err));
              setValueInput('');
            }
          }}
        />
      </Box>
      {saveError !== null && (
        <Box marginTop={1}>
          <Text color="red">{saveError}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>Enter secret value, then press Enter [esc] cancel</Text>
      </Box>
    </Box>
  );
}
