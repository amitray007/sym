/**
 * BuilderStepContent — the per-step presentational component for BuilderScreen,
 * plus the SummaryLine helper it depends on.
 */

import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';

import type { BuilderState, Step } from './builder-state.js';

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
// StepContent props
// ---------------------------------------------------------------------------

export interface StepContentProps {
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

// ---------------------------------------------------------------------------
// StepContent component
// ---------------------------------------------------------------------------

export function StepContent({
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
                  setStep('injectValueTemplate');
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
  if (step === 'injectValueTemplate') {
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
// Helpers
// ---------------------------------------------------------------------------

function injectParamLabel(at: BuilderState['injectAt']): string {
  if (at === 'env') return 'env var name';
  if (at === 'argv') return 'argv template';
  if (at === 'header') return 'header name';
  return 'file path';
}
