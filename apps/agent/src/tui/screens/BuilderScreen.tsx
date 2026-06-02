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
import { useRef, useState } from 'react';

import { DEFAULT_STATE, buildConnectorFromForm } from './builder-state.js';
import { StepContent } from './BuilderStepContent.js';
import { applyReload } from '../../cli/admin-client.js';
import { loadConfigFile, upsertConnector, writeConfigFile } from '../../cli/config-store.js';
import { configPath } from '../../mcp/source.js';
import { Frame } from '../ui/components.js';
import { COLORS } from '../ui/theme.js';

import type { ConnectorConfig } from '../../mcp/config.js';
import type { FormProps } from '../types.js';
import type { BuilderState, Step } from './builder-state.js';

// Re-export public surface consumed by tests
export { buildConnectorFromForm } from './builder-state.js';
export type { BuilderState } from './builder-state.js';

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
// Footer hint per step
// ---------------------------------------------------------------------------

function StepFooter({ step }: { step: Step }): React.ReactElement {
  const textSteps: Step[] = [
    'name',
    'target',
    'args',
    'secret',
    'injectParam',
    'injectValueTemplate',
  ];
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
