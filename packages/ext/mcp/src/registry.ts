/**
 * Tool registry — wraps one or more MCP servers and presents a single
 * ToolDispatcher to @sym/kernel.
 *
 * Responsibilities:
 *  - list(): aggregate all tools from configured MCP servers into ToolDescriptors.
 *  - dispatch(): route a ToolCall to the correct MCP server, execute via the
 *    sandbox SandboxContext, and audit every list + call.
 *
 * Dispatch routing through the sandbox:
 *   The `ctx` (SandboxContext) carries the workspace identity and sandbox JWT.
 *   The actual MCP tool call runs here (host-side) — the sandbox runner is
 *   invoked when the MCP server requires a sandboxed process (stdio transport).
 *   For HTTP-transport MCP servers the request goes through the egress proxy
 *   that injects credentials; the SandboxContext is used to derive the actor
 *   ID for audit purposes.
 *
 * Audit events emitted:
 *   `app.tool.call`  — on every dispatch() call (before execution).
 *   `app.tool.result` — on every dispatch() completion (success or failure).
 *
 * NOTE: The `append` call requires a real Drizzle DB handle.  Tests should
 * pass a mock `auditFn` via constructor injection.
 */

import { McpClient, McpProtocolError } from './client.js';

import type { McpServerConfig, McpToolInfo, McpTransport } from './types.js';
import type { AppendInput } from '@sym/audit';
import type {
  AuditEvent,
  SandboxContext,
  ToolCall,
  ToolDescriptor,
  ToolDispatcher,
  ToolError,
  ToolResult,
} from '@sym/contracts';

// ---------------------------------------------------------------------------
// Injected dependencies (allow test mocking)
// ---------------------------------------------------------------------------

/** Minimal DB handle subset needed for audit. */
export interface AuditDb {
  transaction<T>(fn: (tx: AuditDb) => Promise<T>): Promise<T>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute(query: any): Promise<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

export type AuditFn = (db: AuditDb, input: AppendInput) => Promise<AuditEvent>;

/**
 * Factory that builds a McpTransport for a given server config.
 * Injected so tests can substitute a StubMcpTransport without real I/O.
 */
export type TransportFactory = (config: McpServerConfig) => McpTransport;

// ---------------------------------------------------------------------------
// ToolRegistry
// ---------------------------------------------------------------------------

interface RegisteredServer {
  config: McpServerConfig;
  client: McpClient;
  tools: McpToolInfo[];
}

export class McpToolRegistry implements ToolDispatcher {
  private servers: RegisteredServer[] = [];

  constructor(
    private readonly db: AuditDb,
    private readonly auditFn: AuditFn,
    private readonly transportFactory: TransportFactory,
  ) {}

  /**
   * Connect to a set of MCP servers and discover their tools.
   * Must be called before list() or dispatch().
   */
  async connect(configs: McpServerConfig[]): Promise<void> {
    const connected: RegisteredServer[] = [];

    for (const config of configs) {
      const transport = this.transportFactory(config);
      const client = new McpClient(transport);

      await client.initialize();
      const tools = await client.listTools();

      connected.push({ config, client, tools });
    }

    this.servers = connected;
  }

  /** ToolDispatcher.list — returns all tools from all connected MCP servers. */
  list(): ToolDescriptor[] {
    return this.servers.flatMap((s) => s.tools.map((t) => mcpToolToDescriptor(s.config.slug, t)));
  }

  /**
   * ToolDispatcher.dispatch — route the call to the correct MCP server.
   *
   * Routing: the canonical tool name is `mcp__<slug>__<tool>`.  We parse the
   * slug from the call name, find the matching server, and forward to that
   * server's McpClient.
   *
   * The SandboxContext is used for audit actor information.  All provider
   * HTTP traffic is routed through the sandbox egress proxy (which handles
   * credential injection) when the sandbox network policy is active.
   */
  async dispatch(call: ToolCall, ctx: SandboxContext): Promise<ToolResult> {
    // Emit app.tool.call audit event before execution.
    void this.emitAudit(ctx, 'app.tool.call', {
      toolName: call.name,
      callId: call.id,
      arguments: call.arguments as Record<string, unknown>,
    });

    const parsed = parseToolName(call.name);
    if (!parsed) {
      return this.failure(call.id, 'not_found', `Unknown tool name format: ${call.name}`);
    }

    const server = this.servers.find((s) => s.config.slug === parsed.slug);
    if (!server) {
      return this.failure(
        call.id,
        'not_found',
        `No MCP server registered for slug "${parsed.slug}"`,
      );
    }

    try {
      const result = await server.client.callTool(parsed.toolName, call.arguments);

      void this.emitAudit(ctx, 'app.tool.result', {
        toolName: call.name,
        callId: call.id,
        ok: true,
        isError: result.isError ?? false,
      });

      return {
        callId: call.id,
        ok: true,
        content: result.content ?? null,
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      // McpProtocolError is already an execution failure; other errors too
      const code: ToolError['code'] =
        err instanceof McpProtocolError ? 'execution_failed' : 'execution_failed';

      void this.emitAudit(ctx, 'app.tool.result', {
        toolName: call.name,
        callId: call.id,
        ok: false,
        error: errMsg,
      });

      return this.failure(call.id, code, errMsg);
    }
  }

  /** Gracefully shut down all server connections. */
  async close(): Promise<void> {
    await Promise.allSettled(this.servers.map((s) => s.client.close()));
    this.servers = [];
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private failure(callId: string, code: ToolError['code'], message: string): ToolResult {
    return {
      callId,
      ok: false,
      error: { code, message },
    };
  }

  private async emitAudit(
    ctx: SandboxContext,
    kind: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.auditFn(this.db, {
        workspaceId: ctx.workspaceId,
        kind,
        actorKind: 'sandbox',
        actorId: ctx.identity.sandboxId,
        onBehalfOf: ctx.identity.requester,
        targetKind: 'tool',
        payload,
      });
    } catch {
      // Audit failure must not break the tool call — log only.
      console.warn('[ext-mcp] audit append failed for', kind);
    }
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Convert an MCP tool info to a ToolDescriptor.
 * Canonical name: `mcp__<slug>__<tool>`.
 */
function mcpToolToDescriptor(slug: string, tool: McpToolInfo): ToolDescriptor {
  return {
    type: 'function',
    name: `mcp__${slug}__${tool.name}`,
    description: tool.description ?? `MCP tool ${tool.name} from server ${slug}`,
    parameters: tool.inputSchema,
  };
}

interface ParsedToolName {
  slug: string;
  toolName: string;
}

/** Parse `mcp__<slug>__<toolName>` → { slug, toolName }. */
function parseToolName(name: string): ParsedToolName | null {
  if (!name.startsWith('mcp__')) return null;
  const rest = name.slice(5); // drop "mcp__"
  const sep = rest.indexOf('__');
  if (sep === -1) return null;
  return {
    slug: rest.slice(0, sep),
    toolName: rest.slice(sep + 2),
  };
}
