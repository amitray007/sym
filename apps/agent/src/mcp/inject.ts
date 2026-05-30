/**
 * inject.ts — Transport builder (the injection axis).
 *
 * `buildTransport(transport, resolved)` is the SINGLE pure function that
 * maps a `TransportConfig` + `ResolvedCredential` → an MCP SDK `Transport`
 * instance ready to pass to `client.connect()`.
 *
 * Implemented:
 *   stdio  + env/argv/files injection
 *   http   + header injection (C2)
 *
 * Stubbed (throw NotImplementedError, naming the chunk):
 *   native  → C3
 *
 * Design notes:
 *   - env merge: `transport.env` (base env) is applied FIRST; `resolved.vars`
 *     (credential vars) are overlaid on top. Credentials win on key collision —
 *     this matches the principle of least surprise (the auth config is
 *     authoritative over static env).
 *   - argv append: `transport.args` (static args) come first; `resolved.args`
 *     (credential args) are appended. Order matters for many CLI tools.
 *   - http headers merge: `transport.headers` (non-secret static headers) come
 *     first; injected credential headers overlay on top. Credentials win on key
 *     collision (same principle as env).
 *   - The function is pure — it never has side effects and always returns a new
 *     transport instance. Idempotent to call multiple times.
 */

import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { NotImplementedError } from './providers/provider.js';

import type { TransportConfig } from './config.js';
import type { ResolvedCredential } from './providers/provider.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

/**
 * Build an MCP SDK `Transport` from the connector's transport config and the
 * resolved credential. This is the ONLY place that constructs transports.
 *
 * @param transport - The parsed transport configuration for this connector.
 * @param resolved  - The credential resolved by the CredentialProvider
 *                    (or `{ apply: 'none' }` when there is no auth).
 * @returns A ready-to-connect MCP Transport instance.
 * @throws NotImplementedError when the transport kind or credential apply type
 *         is not yet implemented (names the chunk).
 */
export function buildTransport(
  transport: TransportConfig,
  resolved: ResolvedCredential,
): Transport {
  if (transport.kind === 'stdio') {
    return buildStdioTransport(transport, resolved);
  }

  if (transport.kind === 'http') {
    return buildHttpTransport(transport, resolved);
  }

  // TypeScript exhaustiveness guard.
  const _exhaustive: never = transport;
  throw new Error(`Unknown transport kind: ${JSON.stringify(_exhaustive)}`);
}

// ---------------------------------------------------------------------------
// stdio transport builder
// ---------------------------------------------------------------------------

function buildStdioTransport(
  transport: Extract<TransportConfig, { kind: 'stdio' }>,
  resolved: ResolvedCredential,
): StdioClientTransport {
  // --- env merge: transport.env first, then resolved.vars on top ---
  let mergedEnv: Record<string, string> | undefined;

  if (transport.env !== undefined || resolved.apply === 'env') {
    mergedEnv = {
      ...(transport.env ?? {}),
      ...(resolved.apply === 'env' ? resolved.vars : {}),
    };
  }

  // --- argv append: transport.args first, then resolved.args appended ---
  let mergedArgs: string[] | undefined;
  const baseArgs = transport.args ?? [];
  const credArgs = resolved.apply === 'argv' ? resolved.args : [];

  if (baseArgs.length > 0 || credArgs.length > 0) {
    mergedArgs = [...baseArgs, ...credArgs];
  }

  // Reject apply types that require a non-stdio path.
  if (resolved.apply === 'headers') {
    throw new Error(
      'header credential injection requires an http transport; stdio transports use env/argv/file injection',
    );
  }
  if (resolved.apply === 'native') {
    throw new NotImplementedError('native (OAuth) credential apply — C3');
  }

  // files credential: the files are already on disk (materialized in resolve()).
  // Merge the pointer env-vars into the child env so the child can locate them.
  // Precedence: transport.env (base) → resolved.vars (pointer vars) on top.
  if (resolved.apply === 'files') {
    const filesEnv: Record<string, string> = {
      ...(transport.env ?? {}),
      ...resolved.vars,
    };
    // Only pass env if there is something to pass (vars may be empty).
    const hasEnv = Object.keys(filesEnv).length > 0;
    return new StdioClientTransport({
      command: transport.command,
      ...(mergedArgs !== undefined ? { args: mergedArgs } : {}),
      ...(hasEnv ? { env: filesEnv } : {}),
    });
  }

  // resolved.apply === 'env' | 'argv' | 'none' — all handled above.

  return new StdioClientTransport({
    command: transport.command,
    ...(mergedArgs !== undefined ? { args: mergedArgs } : {}),
    ...(mergedEnv !== undefined ? { env: mergedEnv } : {}),
  });
}

// ---------------------------------------------------------------------------
// http transport builder
// ---------------------------------------------------------------------------

/**
 * Build a StreamableHTTPClientTransport from an http transport config and
 * a resolved credential.
 *
 * Header merge: transport.headers (non-secret static headers) come first;
 * resolved.headers (credential headers) overlay on top. This matches the
 * env-merge convention: credentials win on key collision.
 *
 * Credential apply types that are stdio-only (env/argv/files) are rejected
 * with a clear error — those channels are meaningless over HTTP.
 *
 * native (OAuth) is stubbed for C3.
 */
function buildHttpTransport(
  transport: Extract<TransportConfig, { kind: 'http' }>,
  resolved: ResolvedCredential,
): Transport {
  // Reject stdio-only apply types.
  if (resolved.apply === 'env' || resolved.apply === 'argv' || resolved.apply === 'files') {
    throw new Error(
      `env/argv/file injection is stdio-only; http servers use header or oauth injection` +
        ` (got apply='${resolved.apply}' for url '${transport.url}')`,
    );
  }

  if (resolved.apply === 'native') {
    throw new NotImplementedError('native (OAuth) credential apply on http transport — C3');
  }

  // Merge static transport headers (non-secret) with credential headers (secret on top).
  const mergedHeaders: Record<string, string> = {
    ...(transport.headers ?? {}),
    ...(resolved.apply === 'headers' ? resolved.headers : {}),
  };

  const hasHeaders = Object.keys(mergedHeaders).length > 0;

  // Cast to Transport: StreamableHTTPClientTransport's sessionId getter returns
  // `string | undefined` which conflicts with Transport's `sessionId?: string`
  // under exactOptionalPropertyTypes. Both are functionally equivalent; the
  // cast is safe — the SDK implements the full Transport interface.
  return new StreamableHTTPClientTransport(new URL(transport.url), {
    ...(hasHeaders ? { requestInit: { headers: mergedHeaders } } : {}),
  }) as unknown as Transport;
}
