/**
 * McpDispatcher — implements `ToolDispatcher` over one or more stdio MCP servers.
 *
 * Each server's tools are namespaced as `<serverName>__<toolName>` in the
 * tool list so the model can tell them apart. The prefix is stripped on
 * dispatch and routed to the right client.
 *
 * Pool design:
 *   Module-level `Map<name, Client>` — clients are created once per named
 *   server and reused across turns. The agent process is long-lived; stdio
 *   child processes survive it. On first `list()` call (lazy connect), the
 *   client connects and caches its tool list. A server that fails to connect
 *   or errors on `listTools` contributes zero tools (FAIL OPEN) and is never
 *   retried within the same process lifetime — keeps the pool cheap.
 *
 * Security invariant:
 *   The `destructiveHint` on every MCP tool descriptor is forced to `true`
 *   unless the server config has `trust: true` (owner-set). This ensures
 *   all MCP tool calls go through the confirm-before-destructive gate by
 *   default. We NEVER read the MCP server's own annotations to decide
 *   whether to skip confirmation — those are attacker-controlled.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import type { StdioMcpServerConfig } from './config.js';
import type {
  ToolCall,
  ToolDescriptor,
  ToolDispatcher,
  ToolResult,
  ToolRuntimeContext,
} from '@sym/contracts';

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

// One entry per server name, populated lazily on first list() call.
const pool = new Map<string, PoolEntry>();

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** The separator between server name and tool name in the public tool namespace. */
export const MCP_TOOL_SEPARATOR = '__';

/** Build the namespaced tool name visible to the model. */
function namespacedName(serverName: string, toolName: string): string {
  return `${serverName}${MCP_TOOL_SEPARATOR}${toolName}`;
}

/** Strip the server prefix from a namespaced tool name. */
function stripPrefix(qualifiedName: string, serverName: string): string | null {
  const prefix = `${serverName}${MCP_TOOL_SEPARATOR}`;
  if (!qualifiedName.startsWith(prefix)) return null;
  return qualifiedName.slice(prefix.length);
}

/**
 * Connect a single stdio MCP server and discover its tools.
 *
 * Returns a `PoolEntry` with `ok: false` and an empty tool list when anything
 * goes wrong (FAIL OPEN — the server contributes zero tools, never throws).
 */
async function connectServer(config: StdioMcpServerConfig): Promise<PoolEntry> {
  const label = `[mcp:${config.name}]`;
  let client: Client | undefined;
  try {
    const transport = new StdioClientTransport({
      command: config.command,
      ...(config.args !== undefined ? { args: config.args } : {}),
      ...(config.env !== undefined ? { env: config.env } : {}),
    });

    client = new Client({ name: 'sym', version: '1.0.0' });
    await client.connect(transport);

    const { tools: rawTools } = await client.listTools();

    // Map each MCP tool to a Sym ToolDescriptor.
    // Security: destructiveHint is set based on owner-config `trust`, not on
    // the server's annotation. We deliberately ignore rawTool.annotations.
    const tools: ToolDescriptor[] = rawTools.map((rawTool) => ({
      type: 'function' as const,
      name: namespacedName(config.name, rawTool.name),
      description: rawTool.description ?? `MCP tool ${rawTool.name} from server ${config.name}`,
      // Pass the MCP tool's inputSchema straight through as-is.
      // The Pi bridge casts it to TSchema (structurally identical at runtime).
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
async function ensureEntry(config: StdioMcpServerConfig): Promise<PoolEntry> {
  const existing = pool.get(config.name);
  if (existing !== undefined) return existing;

  const entry = await connectServer(config);
  pool.set(config.name, entry);
  return entry;
}

// ---------------------------------------------------------------------------
// McpDispatcher
// ---------------------------------------------------------------------------

/**
 * `ToolDispatcher` over a set of stdio MCP servers.
 *
 * `list()` — lazily connects all configured servers, returns their tools
 *   namespaced as `<name>__<toolName>` (builtin-first is the caller's job).
 *
 * `dispatch()` — strips the prefix, routes to the right server, maps the
 *   MCP `CallToolResult` content into `ToolResult`. A `callTool` error
 *   returns `ok: false`, never throws into the Pi loop.
 */
export class McpDispatcher implements ToolDispatcher {
  constructor(private readonly configs: StdioMcpServerConfig[]) {}

  async listAsync(): Promise<ToolDescriptor[]> {
    const results = await Promise.all(this.configs.map((c) => ensureEntry(c)));
    return results.flatMap((entry) => entry.tools);
  }

  // ToolDispatcher.list() is synchronous — return whatever the pool has cached.
  // On the first turn the pool may be empty; callers that need up-to-date tools
  // must call `initPool()` before `list()`. The handle-turn wiring does this.
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
 *
 * Concatenates all `type:'text'` items (the common case). Falls back to
 * JSON stringify for non-text items (images, resources, etc.) so the model
 * always gets SOMETHING to reason over.
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
 * Eagerly connect all configured servers and warm the tool cache.
 *
 * Called once from `handle-turn.ts` during the first turn (or at startup).
 * Subsequent calls are cheap — already-connected servers are skipped.
 * Fails open: a server that won't connect simply contributes zero tools.
 */
export async function initMcpPool(configs: StdioMcpServerConfig[]): Promise<void> {
  await Promise.all(configs.map((c) => ensureEntry(c)));
}
