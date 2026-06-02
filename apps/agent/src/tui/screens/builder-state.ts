/**
 * builder-state.ts — Pure form state types and the buildConnectorFromForm helper.
 * No JSX. Imported by BuilderScreen.tsx and by unit tests.
 */

import type { AuthConfig, ConnectorConfig, Injection, TransportConfig } from '../../mcp/config.js';

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

export const DEFAULT_STATE: BuilderState = {
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
// Step type
// ---------------------------------------------------------------------------

export type Step =
  | 'name'
  | 'transportKind'
  | 'target'
  | 'args'
  | 'authKind'
  | 'secret'
  | 'injectAt'
  | 'injectParam'
  | 'injectValueTemplate'
  | 'trust'
  | 'submit';

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
