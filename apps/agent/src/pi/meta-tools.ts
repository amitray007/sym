/**
 * On-demand MCP tool access — `find_tools` + `call_tool`.
 *
 * Why: bridging every MCP tool into the model's tool array on every turn costs
 * ~10k tokens even for "hi" and gets worse with each connector. Instead we keep
 * the per-turn tool array small (built-ins + these two meta-tools) and let the
 * model pull MCP tools in on demand:
 *
 *   find_tools(query)        → search MCP tools, return name+description+schema
 *   call_tool(name, args)    → execute one MCP tool by exact name
 *
 * pi-ai snapshots `state.tools` at `prompt()` start, so we cannot hot-add native
 * tool schemas mid-loop. A single search+execute surface is the robust fit (and
 * it's the only search surface the model sees — no nested connector search).
 *
 * MCP tools are namespaced `<server>__<tool>`; built-ins never contain `__`.
 * `call_tool` dispatches through the SAME registry dispatcher, which routes the
 * `__` name to the MCP dispatcher — so no extra wiring.
 */

import { MCP_TOOL_SEPARATOR } from '../mcp/dispatcher.js';

import type { RenderSink } from './tools.js';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { TSchema } from '@earendil-works/pi-ai';
import type { JsonObject, ToolDescriptor, ToolRuntimeContext } from '@sym/contracts';
import type { ToolRegistry } from '@sym/kernel';

/** Owner-confirmation callback for a destructive MCP tool. Returns true if approved. */
export type ConfirmFn = (toolName: string, args: Record<string, unknown>) => Promise<boolean>;

/** Split a descriptor list into built-in (no `__`) and MCP (`<server>__<tool>`). */
export function partitionDescriptors(all: ToolDescriptor[]): {
  builtin: ToolDescriptor[];
  mcp: ToolDescriptor[];
} {
  const builtin: ToolDescriptor[] = [];
  const mcp: ToolDescriptor[] = [];
  for (const d of all) {
    (d.name.includes(MCP_TOOL_SEPARATOR) ? mcp : builtin).push(d);
  }
  return { builtin, mcp };
}

/** Group MCP tools by connector (the segment before `__`). */
function groupByConnector(mcp: ToolDescriptor[]): Map<string, string[]> {
  const byConnector = new Map<string, string[]>();
  for (const d of mcp) {
    const sep = d.name.indexOf(MCP_TOOL_SEPARATOR);
    const connector = sep > 0 ? d.name.slice(0, sep) : d.name;
    const local = sep > 0 ? d.name.slice(sep + MCP_TOOL_SEPARATOR.length) : d.name;
    const arr = byConnector.get(connector) ?? [];
    arr.push(local);
    byConnector.set(connector, arr);
  }
  return byConnector;
}

/**
 * Compact, cache-stable catalog appended to the system prompt. Lists connectors
 * + their tool names (NOT schemas) so the model knows what exists and to reach
 * for `find_tools`. Static per deploy → keeps the prompt prefix cacheable.
 */
export function buildConnectorCatalog(mcp: ToolDescriptor[]): string {
  if (mcp.length === 0) return '';
  const PER_CONNECTOR_CAP = 30;
  const lines = [...groupByConnector(mcp).entries()].map(([connector, tools]) => {
    const shown = tools.slice(0, PER_CONNECTOR_CAP).join(', ');
    const more =
      tools.length > PER_CONNECTOR_CAP ? `, …(+${tools.length - PER_CONNECTOR_CAP})` : '';
    return `- ${connector} (${tools.length}): ${shown}${more}`;
  });
  return [
    '## Connector tools (on demand)',
    '',
    'You have many connector tools that are NOT preloaded. To use one:',
    '1. call `find_tools` with a short query to get exact tool names + input schemas;',
    '2. then call `call_tool` with the chosen name and arguments matching its schema.',
    'Before telling the user you cannot do something in these domains, call `find_tools` first.',
    '',
    'Connectors:',
    ...lines,
  ].join('\n');
}

/** Rank MCP descriptors against a free-text query by term overlap (name + description). */
export function searchDescriptors(
  mcp: ToolDescriptor[],
  query: string,
  limit: number,
): ToolDescriptor[] {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
  if (terms.length === 0) return mcp.slice(0, limit);
  const scored = mcp
    .map((d) => {
      const hay = `${d.name} ${d.description ?? ''}`.toLowerCase();
      let score = 0;
      for (const t of terms) if (hay.includes(t)) score += 1;
      return { d, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((x) => x.d);
}

const FIND_TOOLS_PARAMS = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: 'What you want to do, e.g. "list sentry issues" or "create calendar event".',
    },
  },
  required: ['query'],
} as const;

/** The `find_tools` meta-tool: search MCP tools, return name+description+schema. */
export function makeFindTools(mcp: ToolDescriptor[], limit = 12): AgentTool {
  const connectors = [...groupByConnector(mcp).keys()];
  return {
    name: 'find_tools',
    label: 'find_tools',
    description:
      'Search the on-demand connector tools. Returns matching tool names, descriptions, and ' +
      'input schemas. Call this before call_tool whenever you need a connector capability.',
    parameters: FIND_TOOLS_PARAMS as unknown as TSchema,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prepareArguments: (args: unknown) => args as any,
    execute: async (_toolCallId: string, params: unknown): Promise<AgentToolResult<unknown>> => {
      const query = String((params as { query?: unknown })?.query ?? '').trim();
      const matches = searchDescriptors(mcp, query, limit);
      if (matches.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text:
                `No tools matched "${query}". Available connectors: ${connectors.join(', ')}. ` +
                'Try a broader query or a connector name.',
            },
          ],
          details: null,
        };
      }
      const payload = matches.map((d) => ({
        name: d.name,
        description: d.description,
        parameters: d.parameters,
      }));
      return {
        content: [
          {
            type: 'text',
            text:
              `Found ${matches.length} tool(s). Call \`call_tool\` with one of these "name" values ` +
              `and "arguments" matching its schema:\n${JSON.stringify(payload)}`,
          },
        ],
        details: null,
      };
    },
  };
}

const CALL_TOOL_PARAMS = {
  type: 'object',
  properties: {
    name: {
      type: 'string',
      description: 'Exact tool name from find_tools, e.g. "sentry__list_issues".',
    },
    arguments: {
      type: 'object',
      description: 'Arguments object matching the tool input schema.',
    },
  },
  required: ['name'],
} as const;

/** The `call_tool` meta-tool: execute one MCP tool by exact name (with confirm for destructive). */
export function makeCallTool(opts: {
  mcp: ToolDescriptor[];
  registry: ToolRegistry;
  ctx: ToolRuntimeContext;
  confirm: ConfirmFn;
  onRender?: RenderSink;
}): AgentTool {
  const { mcp, registry, ctx, confirm, onRender } = opts;
  const byName = new Map(mcp.map((d) => [d.name, d]));
  return {
    name: 'call_tool',
    label: 'call_tool',
    description:
      'Execute a connector tool by its exact name (from find_tools) with arguments matching its ' +
      'input schema.',
    parameters: CALL_TOOL_PARAMS as unknown as TSchema,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prepareArguments: (args: unknown) => args as any,
    execute: async (toolCallId: string, params: unknown): Promise<AgentToolResult<unknown>> => {
      const name = String((params as { name?: unknown })?.name ?? '');
      const args = ((params as { arguments?: unknown })?.arguments ?? {}) as JsonObject;

      const descriptor = byName.get(name);
      if (!descriptor) {
        throw new Error(
          `Unknown tool '${name}'. Call find_tools first to get the exact tool name.`,
        );
      }

      // Confirm destructive tools (MCP tools default to destructiveHint=true unless
      // the connector is trusted). Built-ins are gated separately via beforeToolCall.
      if (descriptor.destructiveHint === true) {
        const approved = await confirm(name, args);
        if (!approved) {
          throw new Error('The owner did not approve this action.');
        }
      }

      const dispatcher = registry.getDispatcher();
      if (!dispatcher) {
        throw new Error(`[call_tool] no dispatcher available for '${name}'`);
      }

      const result = await dispatcher.dispatch({ id: toolCallId, name, arguments: args }, ctx);
      if (!result.ok) {
        throw new Error(`[${result.error.code}]: ${result.error.message}`);
      }
      if (result.render !== undefined) {
        onRender?.(result.render);
      }
      const text =
        typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
      return { content: [{ type: 'text', text }], details: result };
    },
  };
}
