/**
 * BuilderScreen — a guided stepped form for creating or editing a generic
 * ConnectorConfig across transport × auth × injection axes, with a live JSON
 * preview panel.
 *
 * Steps:
 *  1. name         — TextInput: connector name (pre-filled in edit mode)
 *  2. transportKind — key choice: 's' = stdio / 'h' = http
 *  3. target        — TextInput: command (stdio) or url (http)
 *  4. args          — TextInput: space-separated args (stdio only; skipped for http)
 *  5. authKind      — key choice: 'n' none / 's' static / 'o' oauth / 'a' ambient
 *  6. secret        — TextInput (masked): the static secret (static only; skipped otherwise)
 *  7. injectAt      — key choice: 'e' env / 'a' argv / 'h' header / 'f' file
 *                     (only when authKind === 'static'; skipped for other auth kinds)
 *  8. injectParam   — TextInput: env name / argv template / header name / file path
 *                     (only when authKind === 'static'; skipped otherwise)
 *  9. trust         — key choice: 'y' / 'n'
 * 10. submit        — write config, apply reload (best-effort), show result
 *
 * Layout: Frame with a Box row — LEFT = step prompt + summary; RIGHT = live
 * JSON preview. The pure `buildConnectorFromForm` helper is exported for tests.
 *
 * TextInput timing: each TextInput step uses a `useRef` to track the latest
 * value synchronously so `onSubmit` reads the current value even if the React
 * commit hasn't landed yet (same pattern as AddScreen).
 */

import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import React, { useRef, useState } from 'react';

import { applyReload } from '../../cli/admin-client.js';
import { loadConfigFile, upsertConnector, writeConfigFile } from '../../cli/config-store.js';
import { configPath } from '../../mcp/source.js';
import { Frame } from '../ui/components.js';
import { COLORS } from '../ui/theme.js';

import type { AuthConfig, ConnectorConfig, Injection, TransportConfig } from '../../mcp/config.js';
import type { FormProps } from '../types.js';

// ---------------------------------------------------------------------------
// BuilderState — the accumulator filled across steps
// ---------------------------------------------------------------------------

export interface BuilderState {
  name: string;
  transportKind: 'stdio' | 'http';
  target: string;
  args: string;
  authKind: 'none' | 'static' | 'oauth' | 'ambient';
  secret: string;
  injectAt: 'env' | 'argv' | 'header' | 'file';
  injectParam: string; // env name / argv template / header name / file path
  injectValueTemplate: string; // header value template (header injection only)
  trust: boolean;
}

const DEFAULT_STATE: BuilderState = {
  name: '',
  transportKind: 'stdio',
  target: '',
  args: '',
  authKind: 'none',
  secret: '',
  injectAt: 'env',
  injectParam: '',
  injectValueTemplate: '',
  trust: false,
};

// ---------------------------------------------------------------------------
// Pure helper — exported for unit tests
// ---------------------------------------------------------------------------

/**
 * Build a `ConnectorConfig` from a `BuilderState`.
 *
 * Rules:
 * - `args` is split on whitespace; empty tokens dropped; omitted when empty.
 * - `auth` is omitted when `authKind` is 'none'.
 * - `trust` is omitted unless `true`.
 * - No optional field is set to `undefined` — use conditional spread.
 */
export function buildConnectorFromForm(state: BuilderState): ConnectorConfig {
  // --- transport ---
  let transport: TransportConfig;
  if (state.transportKind === 'stdio') {
    const argsList = state.args.split(/\s+/).filter((a) => a.length > 0);
    transport = {
      kind: 'stdio',
      command: state.target,
      ...(argsList.length > 0 ? { args: argsList } : {}),
    };
  } else {
    transport = { kind: 'http', url: state.target };
  }

  // --- auth ---
  let auth: AuthConfig | undefined;
  if (state.authKind === 'static') {
    let inject: Injection;
    if (state.injectAt === 'env') {
      inject = { at: 'env', name: state.injectParam };
    } else if (state.injectAt === 'argv') {
      inject = { at: 'argv', template: state.injectParam };
    } else if (state.injectAt === 'header') {
      inject = {
        at: 'header',
        name: state.injectParam,
        valueTemplate: state.injectValueTemplate,
      };
    } else {
      // file
      inject = { at: 'file', path: state.injectParam };
    }
    auth = {
      kind: 'static',
      ...(state.secret.length > 0 ? { secret: state.secret } : {}),
      inject,
    };
  } else if (state.authKind === 'oauth') {
    auth = { kind: 'oauth' };
  } else if (state.authKind === 'ambient') {
    auth = { kind: 'ambient' };
  }
  // else 'none' → auth stays undefined

  return {
    name: state.name,
    transport,
    ...(auth !== undefined ? { auth } : {}),
    ...(state.trust ? { trust: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// Step type
// ---------------------------------------------------------------------------

type Step =
  | 'name'
  | 'transportKind'
  | 'target'
  | 'args'
  | 'authKind'
  | 'secret'
  | 'injectAt'
  | 'injectParam'
  | 'trust'
  | 'submit';

// ---------------------------------------------------------------------------
// Live JSON preview panel
// ---------------------------------------------------------------------------

function JsonPreview({ state }: { state: BuilderState }): React.ReactElement {
  let preview: ConnectorConfig;
  try {
    preview = buildConnectorFromForm(state);
  } catch {
    return (
      <Box borderStyle="single" borderColor={COLORS.dim} paddingX={1} flexDirection="column">
        <Text dimColor>(building…)</Text>
      </Box>
    );
  }
  const lines = JSON.stringify(preview, null, 2).split('\n');
  return (
    <Box
      borderStyle="single"
      borderColor={COLORS.accent}
      paddingX={1}
      flexDirection="column"
      minWidth={40}
    >
      <Text dimColor bold>
        preview
      </Text>
      {lines.map((line, i) => (
        <Text key={i} dimColor>
          {line}
        </Text>
      ))}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// BuilderScreen component
// ---------------------------------------------------------------------------

export function BuilderScreen({ onBack, connector }: FormProps): React.ReactElement {
  // Pre-fill state from existing connector in edit mode
  const [state, setState] = useState<BuilderState>(() => {
    if (connector === undefined) return { ...DEFAULT_STATE };
    try {
      const path = configPath();
      const cfg = loadConfigFile(path);
      const existing = cfg.mcpServers.find((s) => s.name === connector);
      if (existing === undefined) return { ...DEFAULT_STATE, name: connector };
      return prefillFromConnector(existing);
    } catch {
      return { ...DEFAULT_STATE, name: connector };
    }
  });

  const [step, setStep] = useState<Step>('name');

  // Refs for TextInput synchronous value tracking
  const nameRef = useRef(state.name);
  const targetRef = useRef(state.target);
  const argsRef = useRef(state.args);
  const secretRef = useRef(state.secret);
  const injectParamRef = useRef(state.injectParam);
  const injectValueTemplateRef = useRef(state.injectValueTemplate);

  // Submit-phase state
  const [submitDone, setSubmitDone] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [agentWarning, setAgentWarning] = useState<string | null>(null);
  const [savedName, setSavedName] = useState('');

  // Global escape/back — always active (except on submit done)
  useInput((input, key) => {
    if (key.escape || input === 'b') {
      if (step !== 'submit') {
        onBack();
      }
    }
  });

  // Key-choice steps
  useInput((input) => {
    if (step === 'transportKind') {
      if (input === 's') {
        setState((s) => ({ ...s, transportKind: 'stdio' }));
        setStep('target');
      } else if (input === 'h') {
        setState((s) => ({ ...s, transportKind: 'http' }));
        setStep('target');
      }
    } else if (step === 'authKind') {
      if (input === 'n') {
        setState((s) => ({ ...s, authKind: 'none' }));
        setStep('trust');
      } else if (input === 's') {
        setState((s) => ({ ...s, authKind: 'static' }));
        setStep('secret');
      } else if (input === 'o') {
        setState((s) => ({ ...s, authKind: 'oauth' }));
        setStep('trust');
      } else if (input === 'a') {
        setState((s) => ({ ...s, authKind: 'ambient' }));
        setStep('trust');
      }
    } else if (step === 'injectAt') {
      if (input === 'e') {
        setState((s) => ({ ...s, injectAt: 'env' }));
        setStep('injectParam');
      } else if (input === 'a') {
        setState((s) => ({ ...s, injectAt: 'argv' }));
        setStep('injectParam');
      } else if (input === 'h') {
        setState((s) => ({ ...s, injectAt: 'header' }));
        setStep('injectParam');
      } else if (input === 'f') {
        setState((s) => ({ ...s, injectAt: 'file' }));
        setStep('injectParam');
      }
    } else if (step === 'trust') {
      if (input === 'y') {
        void runSubmit({ ...state, trust: true });
      } else if (input === 'n') {
        void runSubmit({ ...state, trust: false });
      }
    }
  });

  async function runSubmit(finalState: BuilderState): Promise<void> {
    const resolvedState: BuilderState = {
      ...finalState,
      name: nameRef.current.trim() || finalState.name,
      target: targetRef.current.trim() || finalState.target,
      args: argsRef.current,
      secret: secretRef.current,
      injectParam: injectParamRef.current.trim() || finalState.injectParam,
      injectValueTemplate: injectValueTemplateRef.current,
    };
    setSavedName(resolvedState.name);
    setStep('submit');
    try {
      const built = buildConnectorFromForm(resolvedState);
      const path = configPath();
      const cfg = loadConfigFile(path);
      const next = upsertConnector(cfg, built);
      writeConfigFile(path, next);
    } catch (err) {
      setSubmitError(String(err));
      setSubmitDone(true);
      return;
    }
    try {
      await applyReload();
    } catch (err) {
      setAgentWarning(`saved; not applied (agent down): ${String(err)}`);
    }
    setSubmitDone(true);
  }

  const title = connector !== undefined ? `sym · edit ${connector}` : 'sym · new connector';

  // ------ submit step ------
  if (step === 'submit') {
    if (!submitDone) {
      return (
        <Frame title={title}>
          <Text>
            Saving connector <Text bold>{savedName}</Text>…
          </Text>
        </Frame>
      );
    }
    return (
      <Frame title={title}>
        {submitError !== null ? (
          <Text color={COLORS.bad}>Error: {submitError}</Text>
        ) : (
          <>
            <Text color={COLORS.ok}>
              Connector <Text bold>{savedName}</Text> saved.
            </Text>
            {agentWarning !== null && <Text color={COLORS.warn}>{agentWarning}</Text>}
          </>
        )}
        <Text dimColor>[b/Esc] back</Text>
      </Frame>
    );
  }

  // ------ shared layout: left + right (preview) ------
  return (
    <Frame title={title}>
      <Box flexDirection="row" gap={2}>
        {/* LEFT: step prompt */}
        <Box flexDirection="column" gap={1} flexGrow={1}>
          <StepContent
            step={step}
            state={state}
            setState={setState}
            nameRef={nameRef}
            targetRef={targetRef}
            argsRef={argsRef}
            secretRef={secretRef}
            injectParamRef={injectParamRef}
            injectValueTemplateRef={injectValueTemplateRef}
            setStep={setStep}
          />
          <StepFooter step={step} />
        </Box>
        {/* RIGHT: live JSON preview */}
        <JsonPreview state={state} />
      </Box>
    </Frame>
  );
}

// ---------------------------------------------------------------------------
// Step content (factored out for readability)
// ---------------------------------------------------------------------------

interface StepContentProps {
  step: Step;
  state: BuilderState;
  setState: React.Dispatch<React.SetStateAction<BuilderState>>;
  nameRef: React.MutableRefObject<string>;
  targetRef: React.MutableRefObject<string>;
  argsRef: React.MutableRefObject<string>;
  secretRef: React.MutableRefObject<string>;
  injectParamRef: React.MutableRefObject<string>;
  injectValueTemplateRef: React.MutableRefObject<string>;
  setStep: (s: Step) => void;
}

function StepContent({
  step,
  state,
  setState,
  nameRef,
  targetRef,
  argsRef,
  secretRef,
  injectParamRef,
  injectValueTemplateRef,
  setStep,
}: StepContentProps): React.ReactElement {
  if (step === 'name') {
    return (
      <Box flexDirection="column" gap={1}>
        <SummaryLine state={state} upTo="none" />
        <Box>
          <Text>name: </Text>
          <TextInput
            value={state.name}
            onChange={(v) => {
              nameRef.current = v;
              setState((s) => ({ ...s, name: v }));
            }}
            onSubmit={() => {
              const val = nameRef.current.trim();
              if (val.length > 0) {
                setState((s) => ({ ...s, name: val }));
                setStep('transportKind');
              }
            }}
          />
        </Box>
      </Box>
    );
  }

  if (step === 'transportKind') {
    return (
      <Box flexDirection="column" gap={1}>
        <SummaryLine state={state} upTo="name" />
        <Text>transport: [s] stdio [h] http</Text>
      </Box>
    );
  }

  if (step === 'target') {
    const label = state.transportKind === 'stdio' ? 'command' : 'url';
    return (
      <Box flexDirection="column" gap={1}>
        <SummaryLine state={state} upTo="transportKind" />
        <Box>
          <Text>{label}: </Text>
          <TextInput
            value={state.target}
            onChange={(v) => {
              targetRef.current = v;
              setState((s) => ({ ...s, target: v }));
            }}
            onSubmit={() => {
              const val = targetRef.current.trim();
              if (val.length > 0) {
                setState((s) => ({ ...s, target: val }));
                if (state.transportKind === 'stdio') {
                  setStep('args');
                } else {
                  setStep('authKind');
                }
              }
            }}
          />
        </Box>
      </Box>
    );
  }

  if (step === 'args') {
    return (
      <Box flexDirection="column" gap={1}>
        <SummaryLine state={state} upTo="target" />
        <Box>
          <Text>args (space-separated, optional): </Text>
          <TextInput
            value={state.args}
            onChange={(v) => {
              argsRef.current = v;
              setState((s) => ({ ...s, args: v }));
            }}
            onSubmit={() => {
              setState((s) => ({ ...s, args: argsRef.current }));
              setStep('authKind');
            }}
          />
        </Box>
      </Box>
    );
  }

  if (step === 'authKind') {
    return (
      <Box flexDirection="column" gap={1}>
        <SummaryLine state={state} upTo="args" />
        <Text>auth: [n] none [s] static [o] oauth [a] ambient</Text>
      </Box>
    );
  }

  if (step === 'secret') {
    return (
      <Box flexDirection="column" gap={1}>
        <SummaryLine state={state} upTo="authKind" />
        <Box>
          <Text>secret (masked): </Text>
          <TextInput
            value={state.secret}
            mask="*"
            onChange={(v) => {
              secretRef.current = v;
              setState((s) => ({ ...s, secret: v }));
            }}
            onSubmit={() => {
              setState((s) => ({ ...s, secret: secretRef.current }));
              setStep('injectAt');
            }}
          />
        </Box>
      </Box>
    );
  }

  if (step === 'injectAt') {
    return (
      <Box flexDirection="column" gap={1}>
        <SummaryLine state={state} upTo="secret" />
        <Text>inject at: [e] env [a] argv [h] header [f] file</Text>
      </Box>
    );
  }

  if (step === 'injectParam') {
    const paramLabel = injectParamLabel(state.injectAt);
    const needsValueTemplate = state.injectAt === 'header';
    return (
      <Box flexDirection="column" gap={1}>
        <SummaryLine state={state} upTo="injectAt" />
        <Box>
          <Text>{paramLabel}: </Text>
          <TextInput
            value={state.injectParam}
            onChange={(v) => {
              injectParamRef.current = v;
              setState((s) => ({ ...s, injectParam: v }));
            }}
            onSubmit={() => {
              const val = injectParamRef.current.trim();
              if (val.length > 0) {
                setState((s) => ({ ...s, injectParam: val }));
                if (needsValueTemplate) {
                  setStep('injectValueTemplate' as Step);
                } else {
                  setStep('trust');
                }
              }
            }}
          />
        </Box>
      </Box>
    );
  }

  // injectValueTemplate step (header injection only)
  if (step === ('injectValueTemplate' as Step)) {
    return (
      <Box flexDirection="column" gap={1}>
        <SummaryLine state={state} upTo="injectParam" />
        <Box>
          <Text>header value template: </Text>
          <TextInput
            value={state.injectValueTemplate}
            onChange={(v) => {
              injectValueTemplateRef.current = v;
              setState((s) => ({ ...s, injectValueTemplate: v }));
            }}
            onSubmit={() => {
              const val = injectValueTemplateRef.current.trim();
              setState((s) => ({ ...s, injectValueTemplate: val }));
              setStep('trust');
            }}
          />
        </Box>
      </Box>
    );
  }

  // trust step
  return (
    <Box flexDirection="column" gap={1}>
      <SummaryLine state={state} upTo="trust" />
      <Text>trust this connector (skip confirm gate)? [y] yes [n] no</Text>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Summary line — shows entered values above the current prompt
// ---------------------------------------------------------------------------

type SummaryUpTo =
  | 'none'
  | 'name'
  | 'transportKind'
  | 'target'
  | 'args'
  | 'authKind'
  | 'secret'
  | 'injectAt'
  | 'injectParam'
  | 'trust';

function SummaryLine({
  state,
  upTo,
}: {
  state: BuilderState;
  upTo: SummaryUpTo;
}): React.ReactElement {
  const parts: string[] = [];
  const order: SummaryUpTo[] = [
    'name',
    'transportKind',
    'target',
    'args',
    'authKind',
    'secret',
    'injectAt',
    'injectParam',
    'trust',
  ];
  const idx = order.indexOf(upTo);
  if (idx >= 0 && state.name.length > 0) parts.push(`name: ${state.name}`);
  if (idx >= 1) parts.push(`transport: ${state.transportKind}`);
  if (idx >= 2 && state.target.length > 0)
    parts.push(`${state.transportKind === 'stdio' ? 'command' : 'url'}: ${state.target}`);
  if (idx >= 3 && state.args.length > 0) parts.push(`args: ${state.args}`);
  if (idx >= 4) parts.push(`auth: ${state.authKind}`);
  if (idx >= 5 && state.secret.length > 0) parts.push('secret: ****');
  if (idx >= 6) parts.push(`inject at: ${state.injectAt}`);
  if (idx >= 7 && state.injectParam.length > 0) parts.push(`param: ${state.injectParam}`);

  if (parts.length === 0) return <Box />;
  return (
    <Box>
      <Text dimColor>{parts.join('   ')}</Text>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Footer hint per step
// ---------------------------------------------------------------------------

function StepFooter({ step }: { step: Step }): React.ReactElement {
  const textSteps: Step[] = ['name', 'target', 'args', 'secret', 'injectParam'];
  const isText = textSteps.includes(step);
  const hints = [
    ...(isText ? [{ key: 'Enter', label: 'next' }] : []),
    { key: 'b/Esc', label: 'back' },
  ];
  return (
    <Box marginTop={1}>
      <Text dimColor>{hints.map((h) => `[${h.key}] ${h.label}`).join('   ')}</Text>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function injectParamLabel(at: BuilderState['injectAt']): string {
  if (at === 'env') return 'env var name';
  if (at === 'argv') return 'argv template';
  if (at === 'header') return 'header name';
  return 'file path';
}

/**
 * Pre-fill BuilderState from an existing ConnectorConfig (edit mode).
 * Best-effort — unrecognised shapes fall back to defaults.
 */
function prefillFromConnector(c: ConnectorConfig): BuilderState {
  const s: BuilderState = { ...DEFAULT_STATE, name: c.name };
  s.trust = c.trust === true;

  if (c.transport.kind === 'stdio') {
    s.transportKind = 'stdio';
    s.target = c.transport.command;
    s.args = (c.transport.args ?? []).join(' ');
  } else {
    s.transportKind = 'http';
    s.target = c.transport.url;
  }

  if (c.auth === undefined) {
    s.authKind = 'none';
  } else if (c.auth.kind === 'oauth') {
    s.authKind = 'oauth';
  } else if (c.auth.kind === 'ambient') {
    s.authKind = 'ambient';
  } else if (c.auth.kind === 'static') {
    s.authKind = 'static';
    if (typeof c.auth.secret === 'string') {
      s.secret = c.auth.secret;
    }
    const inj = Array.isArray(c.auth.inject) ? c.auth.inject[0] : c.auth.inject;
    if (inj !== undefined) {
      s.injectAt = inj.at;
      if (inj.at === 'env') {
        s.injectParam = inj.name;
      } else if (inj.at === 'argv') {
        s.injectParam = inj.template;
      } else if (inj.at === 'header') {
        s.injectParam = inj.name;
        s.injectValueTemplate = inj.valueTemplate;
      } else if (inj.at === 'file') {
        s.injectParam = inj.path;
      }
    }
  }

  return s;
}
