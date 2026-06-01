/**
 * AddScreen — a stepped form for adding (or replacing) an MCP connector in the
 * Sym config file, then best-effort applying the change to the running agent.
 *
 * Steps:
 *  1. name    — TextInput: connector name
 *  2. kind    — key choice: 's' = stdio, 'h' = http
 *  3. target  — TextInput: command (stdio) or url (http)
 *  4. args    — TextInput: space-separated args (stdio only; skipped for http)
 *  5. trust   — key choice: 'y' / 'n'
 *  6. submit  — write config, apply reload (best-effort), show result
 *
 * TextInput timing note: each step uses a useRef to track the latest input
 * value synchronously alongside the React state prop, so that onSubmit always
 * reads the current value even if the React commit hasn't landed yet.
 */

import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import React, { useRef, useState } from 'react';

import { applyReload } from '../../cli/admin-client.js';
import { loadConfigFile, upsertConnector, writeConfigFile } from '../../cli/config-store.js';
import { configPath } from '../../mcp/source.js';

import type { ConnectorConfig, TransportConfig } from '../../mcp/config.js';
import type { ScreenProps } from '../types.js';

// ---------------------------------------------------------------------------
// Pure helper — exported so tests can assert the shape independently
// ---------------------------------------------------------------------------

export interface BuildConnectorInput {
  name: string;
  kind: 'stdio' | 'http';
  target: string;
  args: string;
  trust: boolean;
}

/**
 * Build a `ConnectorConfig` from form field values.
 *
 * - args string is split on whitespace; empty tokens are dropped; omitted when empty.
 * - trust is omitted unless true.
 */
export function buildConnector(input: BuildConnectorInput): ConnectorConfig {
  const { name, kind, target, args, trust } = input;

  let transport: TransportConfig;
  if (kind === 'stdio') {
    const argsList = args.split(/\s+/).filter((a) => a.length > 0);
    transport = {
      kind: 'stdio',
      command: target,
      ...(argsList.length > 0 ? { args: argsList } : {}),
    };
  } else {
    transport = { kind: 'http', url: target };
  }

  return {
    name,
    transport,
    ...(trust ? { trust: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// Step types
// ---------------------------------------------------------------------------

type Step = 'name' | 'kind' | 'target' | 'args' | 'trust' | 'submit';

// ---------------------------------------------------------------------------
// AddScreen component
// ---------------------------------------------------------------------------

export function AddScreen({ onBack }: ScreenProps): React.ReactElement {
  const [step, setStep] = useState<Step>('name');
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'stdio' | 'http'>('stdio');
  const [target, setTarget] = useState('');
  const [args, setArgs] = useState('');

  // Refs track the latest value synchronously so onSubmit isn't stale
  const nameRef = useRef('');
  const targetRef = useRef('');
  const argsRef = useRef('');

  // Submit-phase state
  const [submitDone, setSubmitDone] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [agentWarning, setAgentWarning] = useState<string | null>(null);
  const [savedName, setSavedName] = useState('');

  // Global escape/back — always active
  useInput((input, key) => {
    if (key.escape || input === 'b') {
      if (step !== 'submit') {
        onBack();
      }
    }
  });

  // Kind + trust choice keys — only meaningful on those steps
  useInput((input) => {
    if (step === 'kind') {
      if (input === 's') {
        setKind('stdio');
        setStep('target');
      } else if (input === 'h') {
        setKind('http');
        setStep('target');
      }
    } else if (step === 'trust') {
      if (input === 'y') {
        void runSubmit(true);
      } else if (input === 'n') {
        void runSubmit(false);
      }
    }
  });

  async function runSubmit(resolvedTrust: boolean): Promise<void> {
    const resolvedName = nameRef.current.trim();
    const resolvedTarget = targetRef.current.trim();
    const resolvedArgs = argsRef.current;
    setSavedName(resolvedName);
    setStep('submit');
    try {
      const connector = buildConnector({
        name: resolvedName,
        kind,
        target: resolvedTarget,
        args: resolvedArgs,
        trust: resolvedTrust,
      });
      const path = configPath();
      const cfg = loadConfigFile(path);
      const next = upsertConnector(cfg, connector);
      writeConfigFile(path, next);
    } catch (err) {
      setSubmitError(String(err));
      setSubmitDone(true);
      return;
    }

    // Best-effort apply reload
    try {
      await applyReload();
    } catch (err) {
      setAgentWarning(`saved; not applied (agent down): ${String(err)}`);
    }
    setSubmitDone(true);
  }

  // ------ Render ------

  if (step === 'name') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>Add MCP Connector</Text>
        <Box>
          <Text>name: </Text>
          <TextInput
            value={name}
            onChange={(v) => {
              nameRef.current = v;
              setName(v);
            }}
            onSubmit={() => {
              const val = nameRef.current.trim();
              if (val.length > 0) {
                setStep('kind');
              }
            }}
          />
        </Box>
        <Text dimColor>[Enter] next · [b/Esc] back</Text>
      </Box>
    );
  }

  if (step === 'kind') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>Add MCP Connector</Text>
        <Text>name: {nameRef.current || name}</Text>
        <Text>transport kind: press [s] stdio or [h] http</Text>
        <Text dimColor>[b/Esc] back</Text>
      </Box>
    );
  }

  if (step === 'target') {
    const label = kind === 'stdio' ? 'command' : 'url';
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>Add MCP Connector</Text>
        <Text>
          name: {nameRef.current || name} kind: {kind}
        </Text>
        <Box>
          <Text>{label}: </Text>
          <TextInput
            value={target}
            onChange={(v) => {
              targetRef.current = v;
              setTarget(v);
            }}
            onSubmit={() => {
              const val = targetRef.current.trim();
              if (val.length > 0) {
                if (kind === 'stdio') {
                  setStep('args');
                } else {
                  setStep('trust');
                }
              }
            }}
          />
        </Box>
        <Text dimColor>[Enter] next · [b/Esc] back</Text>
      </Box>
    );
  }

  if (step === 'args') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>Add MCP Connector</Text>
        <Text>
          name: {nameRef.current || name} command: {targetRef.current || target}
        </Text>
        <Box>
          <Text>args (space-separated, optional): </Text>
          <TextInput
            value={args}
            onChange={(v) => {
              argsRef.current = v;
              setArgs(v);
            }}
            onSubmit={() => {
              setStep('trust');
            }}
          />
        </Box>
        <Text dimColor>[Enter] next · [b/Esc] back</Text>
      </Box>
    );
  }

  if (step === 'trust') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>Add MCP Connector</Text>
        <Text>
          name: {nameRef.current || name} transport: {kind}
        </Text>
        <Text>Trust this connector (skip confirm gate)? [y] yes / [n] no</Text>
        <Text dimColor>[b/Esc] back</Text>
      </Box>
    );
  }

  // submit step
  if (!submitDone) {
    return (
      <Box flexDirection="column" gap={1}>
        <Text>
          Saving connector <Text bold>{savedName}</Text>…
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" gap={1}>
      {submitError !== null ? (
        <Text color="red">Error: {submitError}</Text>
      ) : (
        <>
          <Text color="green">
            Connector <Text bold>{savedName}</Text> saved.
          </Text>
          {agentWarning !== null && <Text color="yellow">{agentWarning}</Text>}
        </>
      )}
      <Text dimColor>[b/Esc] back</Text>
    </Box>
  );
}
