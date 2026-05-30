/**
 * McpDispatcher — implements `ToolDispatcher` over one or more MCP connectors.
 *
 * Each connector's tools are namespaced as `<name>__<toolName>` in the tool
 * list so the model can tell them apart. The prefix is stripped on dispatch
 * and routed to the right client.
 *
 * Pool design:
 *   Module-level `Map<name, PoolEntry>` — clients are created once per named
 *   connector and reused across turns. The agent process is long-lived. On
 *   first `list()` call (lazy connect), the client connects and caches its
 *   tool list. A server that fails to connect or errors on `listTools`
 *   contributes zero tools (FAIL OPEN) and is never retried within the same
 *   process lifetime — keeps the pool cheap.
 *
 * Connect timeout:
 *   `connect + listTools` is bounded by `CONNECT_TIMEOUT_MS` (default 10s).
 *   A server that HANGS (not just errors) fails open instead of blocking the
 *   first turn forever. Configured via `MCP_CONNECT_TIMEOUT_MS` env var.
 *
 * Security invariant:
 *   The `destructiveHint` on every MCP tool descriptor is forced to `true`
 *   unless the connector config has `trust: true` (owner-set). This ensures
 *   all MCP tool calls go through the confirm-before-destructive gate by
 *   default. We NEVER read the MCP server's own annotations to decide
 *   whether to skip confirmation — those are attacker-controlled.
 */

import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

import { buildTransport } from './inject.js';
import { getPendingAuth } from './oauth-registry.js';
import { makeOAuthProvider, type OAuthProvider } from './providers/oauth.js';
import { makeProvider } from './providers/provider.js';

import type { ConnectorConfig } from './config.js';
import type {
  ToolCall,
  ToolDescriptor,
  ToolDispatcher,
  ToolResult,
  ToolRuntimeContext,
} from '@sym/contracts';

// ---------------------------------------------------------------------------
// Connect timeout
// ---------------------------------------------------------------------------

/** Default maximum time to wait for connect + listTools, in milliseconds. */
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

const CONNECT_TIMEOUT_MS =
  process.env['MCP_CONNECT_TIMEOUT_MS'] !== undefined
    ? Math.max(1000, Number(process.env['MCP_CONNECT_TIMEOUT_MS']))
    : DEFAULT_CONNECT_TIMEOUT_MS;

/**
 * Race `work` against a hard timeout. Rejects with a `TimeoutError` when the
 * timeout elapses, regardless of whether `work` resolves later.
 */
async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label}: timed out after ${ms}ms`));
    }, ms);
    work.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Module-level client pool (reused across turns)
// ---------------------------------------------------------------------------

interface PoolEntry {
  client: Client;
  /** Tools discovered at connect time, namespaced. */
  tools: ToolDescriptor[];
  /** Whether this entry is healthy (connected + listTools succeeded). */
  ok: boolean;
}

// One entry per connector name, populated lazily on first list() call.
const pool = new Map<string, PoolEntry>();

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** The separator between connector name and tool name in the public tool namespace. */
export const MCP_TOOL_SEPARATOR = '__';

/** Build the namespaced tool name visible to the model. */
function namespacedName(connectorName: string, toolName: string): string {
  return `${connectorName}${MCP_TOOL_SEPARATOR}${toolName}`;
}

/** Strip the connector prefix from a namespaced tool name. */
function stripPrefix(qualifiedName: string, connectorName: string): string | null {
  const prefix = `${connectorName}${MCP_TOOL_SEPARATOR}`;
  if (!qualifiedName.startsWith(prefix)) return null;
  return qualifiedName.slice(prefix.length);
}

/**
 * Connect a single MCP connector and discover its tools.
 *
 * Acquisition → Injection → Transport → Connect → ListTools, all bounded
 * by CONNECT_TIMEOUT_MS. Returns a `PoolEntry` with `ok: false` and an
 * empty tool list when anything goes wrong (FAIL OPEN).
 *
 * OAuth special case: when the SDK's `transport.start()` throws
 * `UnauthorizedError`, the OAuthProvider's `redirectToAuthorization` has
 * already fired and registered the pending auth in the module-level registry.
 * We log the authorize URL for observability (C3b will surface it to Slack)
 * and fail-open with zero tools for this turn — the connector reconnects
 * after `completeOAuth` is called.
 */
async function connectServer(config: ConnectorConfig): Promise<PoolEntry> {
  const label = `[mcp:${config.name}]`;
  let client: Client | undefined;
  let oauthProvider: OAuthProvider | undefined;
  try {
    // C2.5 stub gate: prepare command is not yet implemented.
    if (config.prepare !== undefined) {
      throw new Error(
        `${label} 'prepare' command is not yet implemented — C2.5 stub. Skipping connector.`,
      );
    }

    // Acquisition: resolve credentials via provider.
    // For oauth kind, use makeOAuthProvider directly so the connector name is
    // available for the store key + callback URL slug.
    let provider;
    if (config.auth?.kind === 'oauth') {
      oauthProvider = makeOAuthProvider(config.name);
      provider = oauthProvider;
    } else {
      provider = makeProvider(config.auth, { connectorName: config.name });
    }

    const cred = provider !== null ? await provider.resolve() : { apply: 'none' as const };

    // Injection + Transport construction: pure, no side effects.
    const { transport, httpTransport } = buildTransport(config.transport, cred);

    // For OAuth: wire the transport into the OAuthProvider so that
    // `redirectToAuthorization` can register it in the pending-auth registry.
    // This MUST happen before client.connect.
    if (oauthProvider !== undefined && httpTransport !== undefined) {
      oauthProvider.wireTransport(httpTransport);
    }

    // Connect + list tools, bounded by timeout.
    client = new Client({ name: 'sym', version: '1.0.0' });

    const { tools: rawTools } = await withTimeout(
      (async () => {
        await client!.connect(transport);
        return client!.listTools();
      })(),
      CONNECT_TIMEOUT_MS,
      label,
    );

    // Map each MCP tool to a Sym ToolDescriptor.
    // Security: destructiveHint is set based on owner-config `trust`, not on
    // the server's annotation. We deliberately ignore rawTool.annotations.
    const tools: ToolDescriptor[] = rawTools.map((rawTool) => ({
      type: 'function' as const,
      name: namespacedName(config.name, rawTool.name),
      description: rawTool.description ?? `MCP tool ${rawTool.name} from server ${config.name}`,
      // Pass the MCP tool's inputSchema straight through as-is.
      parameters: rawTool.inputSchema as ToolDescriptor['parameters'],
      // Security invariant: trust is owner-set. MCP server annotations are ignored.
      // Without trust: destructiveHint=true → confirm gate fires for every call.
      // With trust: no destructiveHint → gate skipped (owner opted in).
      ...(config.trust !== true ? { destructiveHint: true as const } : {}),
    }));

    console.info(
      `${label} connected — ${tools.length} tool(s): ${tools.map((t) => t.name).join(', ') || '(none)'}`,
    );

    return { client, tools, ok: true };
  } catch (err) {
    // OAuth-specific: UnauthorizedError means the user must authorize first.
    // redirectToAuthorization has already fired → the auth URL is in the registry.
    // Fail-open (0 tools) so this turn proceeds; C3b will surface the URL to Slack.
    if (err instanceof UnauthorizedError) {
      const pending = getPendingAuth(config.name);
      const authorizeUrl = pending?.authorizeUrl.toString() ?? '(authorize URL not yet available)';
      console.warn(
        `${label} OAuth authorization required — authorize URL: ${authorizeUrl}\n` +
          `  → Visit the URL above, then the callback will complete the flow. ` +
          `This connector contributes 0 tools until authorized.`,
      );
      // Close client if opened before the error.
      if (client !== undefined) {
        client.close().catch(() => undefined);
      }
      return {
        client: client ?? new Client({ name: 'sym', version: '1.0.0' }),
        tools: [],
        ok: false,
      };
    }

    console.warn(`${label} failed to connect or list tools — contributing zero tools:`, err);
    // If the client was created but connect/listTools failed, attempt a clean close.
    if (client !== undefined) {
      client.close().catch(() => undefined);
    }
    return {
      client: client ?? new Client({ name: 'sym', version: '1.0.0' }),
      tools: [],
      ok: false,
    };
  }
}

/**
 * Ensure the pool entry for `config` exists (lazy connect on first use).
 * Returns the entry (ok=false on any connection failure).
 */
async function ensureEntry(config: ConnectorConfig): Promise<PoolEntry> {
  const existing = pool.get(config.name);
  // Retry failed OAuth connectors: the first connect throws UnauthorizedError
  // and caches ok:false; after the owner completes /oauth/callback the tokens
  // are in the store, so a fresh connect can now succeed and the connector comes
  // online without a process restart. Non-oauth failures stay cached to avoid
  // per-turn retry storms against a genuinely-down server.
  if (existing !== undefined && (existing.ok || config.auth?.kind !== 'oauth')) {
    return existing;
  }

  const entry = await connectServer(config);
  pool.set(config.name, entry);
  return entry;
}

// ---------------------------------------------------------------------------
// McpDispatcher
// ---------------------------------------------------------------------------

/**
 * `ToolDispatcher` over a set of MCP connectors.
 *
 * `list()` — lazily connects all configured connectors, returns their tools
 *   namespaced as `<name>__<toolName>` (builtin-first is the caller's job).
 *
 * `dispatch()` — strips the prefix, routes to the right connector, maps the
 *   MCP `CallToolResult` content into `ToolResult`. A `callTool` error
 *   returns `ok: false`, never throws into the Pi loop.
 */
export class McpDispatcher implements ToolDispatcher {
  constructor(private readonly configs: ConnectorConfig[]) {}

  async listAsync(): Promise<ToolDescriptor[]> {
    const results = await Promise.all(this.configs.map((c) => ensureEntry(c)));
    return results.flatMap((entry) => entry.tools);
  }

  // ToolDispatcher.list() is synchronous — return whatever the pool has cached.
  // On the first turn the pool may be empty; callers that need up-to-date tools
  // must call `initMcpPool()` before `list()`. The handle-turn wiring does this.
  list(): ToolDescriptor[] {
    const out: ToolDescriptor[] = [];
    for (const config of this.configs) {
      const entry = pool.get(config.name);
      if (entry !== undefined && entry.ok) {
        out.push(...entry.tools);
      }
    }
    return out;
  }

  async dispatch(call: ToolCall, _ctx: ToolRuntimeContext): Promise<ToolResult> {
    // Find the matching config by prefix.
    for (const config of this.configs) {
      const localName = stripPrefix(call.name, config.name);
      if (localName === null) continue;

      const entry = pool.get(config.name);
      if (entry === undefined || !entry.ok) {
        return {
          callId: call.id,
          ok: false,
          error: {
            code: 'execution_failed',
            message: `MCP server '${config.name}' is not connected`,
            retryable: false,
          },
        };
      }

      try {
        const result = await entry.client.callTool({
          name: localName,
          arguments: call.arguments,
        });

        // Map MCP CallToolResult content → ToolResult.
        // isError in MCP means the tool itself reported an error (not a protocol error).
        if (result.isError === true) {
          const errText = extractText(result.content);
          return {
            callId: call.id,
            ok: false,
            error: {
              code: 'execution_failed',
              message: errText.length > 0 ? errText : `MCP tool '${call.name}' returned an error`,
              retryable: false,
            },
          };
        }

        const content = extractText(result.content);
        return { callId: call.id, ok: true, content };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          callId: call.id,
          ok: false,
          error: { code: 'execution_failed', message, retryable: false },
        };
      }
    }

    // No matching prefix → unknown tool.
    return {
      callId: call.id,
      ok: false,
      error: { code: 'not_found', message: `No MCP server handles tool '${call.name}'` },
    };
  }
}

/**
 * Extract a text summary from MCP CallToolResult content array.
 */
function extractText(content: unknown): string {
  if (!Array.isArray(content)) {
    return typeof content === 'string' ? content : JSON.stringify(content);
  }
  const parts: string[] = [];
  for (const item of content) {
    if (item !== null && typeof item === 'object') {
      const i = item as Record<string, unknown>;
      if (i['type'] === 'text' && typeof i['text'] === 'string') {
        parts.push(i['text']);
      } else {
        parts.push(JSON.stringify(item));
      }
    }
  }
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Pool init (called once at turn-construction time to warm the pool)
// ---------------------------------------------------------------------------

/**
 * Eagerly connect all configured connectors and warm the tool cache.
 *
 * Called once from `handle-turn.ts` during the first turn (or at startup).
 * Subsequent calls are cheap — already-connected connectors are skipped.
 * Fails open: a server that won't connect simply contributes zero tools.
 */
export async function initMcpPool(configs: ConnectorConfig[]): Promise<void> {
  await Promise.all(configs.map((c) => ensureEntry(c)));
}

// ---------------------------------------------------------------------------
// Test-only pool reset (not exported from index.ts)
// ---------------------------------------------------------------------------

/**
 * Close all pooled clients and clear the pool.
 *
 * Used in tests to tear down open transport connections (e.g. SSE streams
 * held open by StreamableHTTPClientTransport) so test servers can shut down
 * without waiting for connection timeouts.
 */
export function _resetPoolForTesting(): void {
  for (const entry of pool.values()) {
    entry.client.close().catch(() => undefined);
  }
  pool.clear();
}
