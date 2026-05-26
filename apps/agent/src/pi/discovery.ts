/**
 * Dynamic tool discovery meta-tools for the Pi loop (DISPATCH pattern).
 *
 * When connector (MCP) tools are present in the registry, these two meta-tools
 * are injected into the Pi agent's tool list alongside the eager built-in tools:
 *
 *   - search_tools({query}): keyword-match connector descriptors by name +
 *     description; return each match's name, description, and parameters schema
 *     so the model can form correct call_tool args.
 *
 *   - call_tool({name, args}): look up the name among connector descriptors and
 *     dispatch via the Sym ToolDispatcher. Preserves confirm-before-destructive:
 *     if the descriptor carries destructiveHint === true, the call is gated
 *     through requestConfirmation before dispatching. Fails closed when no
 *     confirmation channel is available.
 *
 * Pi snapshots state.tools at run-start (native mid-run mutation does NOT work,
 * as confirmed by the spike). The dispatch pattern is the only reliable path.
 */

import { requestConfirmation } from '../confirmations.js';

import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { TSchema } from '@earendil-works/pi-ai';
import type { SlackClient } from '@sym/adapter-slack';
import type {
  JsonObject,
  SlackChannelId,
  SlackThreadTs,
  ToolDescriptor,
  ToolRuntimeContext,
} from '@sym/contracts';
import type { ToolRegistry } from '@sym/kernel';

// ---------------------------------------------------------------------------
// Public params
// ---------------------------------------------------------------------------

export interface BuildDiscoveryToolsParams {
  /** The connector (mcp__) descriptors to expose via search + dispatch. */
  connectorDescriptors: ToolDescriptor[];
  /** Registry used to resolve the dispatcher for call_tool dispatch. */
  registry: ToolRegistry;
  /** Runtime context forwarded to the dispatcher. */
  ctx: ToolRuntimeContext;
  /** Channel where confirmation prompts are posted (may be undefined). */
  channelId?: string;
  /** Thread timestamp for confirmation prompts (may be undefined). */
  threadTs?: string;
  /** Slack client for posting destructive-tool confirmation messages. */
  slackClient?: SlackClient;
}

// ---------------------------------------------------------------------------
// search_tools
// ---------------------------------------------------------------------------

/**
 * Build the `search_tools` meta-tool.
 *
 * Performs a simple keyword match against the connector descriptors' names and
 * descriptions. Returns matching tools' name, description, and parameters
 * schema so the model can construct correct `call_tool` arguments.
 */
function buildSearchToolsTool(connectorDescriptors: ToolDescriptor[]): AgentTool {
  return {
    name: 'search_tools',
    label: 'search_tools',
    description:
      'Search available tools by keyword. Returns matching tool names, descriptions, and ' +
      'their parameter schemas. Use this when you need a capability that is not already in ' +
      'your tool list, then call call_tool to invoke it.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'A keyword or phrase describing the capability you need ' +
            '(e.g. "search web", "create calendar event", "send email")',
        },
      },
      required: ['query'],
      additionalProperties: false,
    } as unknown as TSchema,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prepareArguments: (args: unknown) => args as any,
    execute: async (
      _toolCallId: string,
      params: unknown,
    ): Promise<AgentToolResult<{ query: string; matches: string[] }>> => {
      const { query } = params as { query: string };
      const q = query.toLowerCase();

      const matches = connectorDescriptors.filter(
        (d) => d.name.toLowerCase().includes(q) || d.description.toLowerCase().includes(q),
      );

      if (matches.length === 0) {
        const allNames = connectorDescriptors.map((d) => d.name).join(', ');
        const text =
          `No connector tools matched "${query}". ` +
          `Available connector tools to search: ${allNames || '(none)'}`;
        return { content: [{ type: 'text', text }], details: { query, matches: [] } };
      }

      // Return each match's name, description, and full parameters schema so the
      // model can correctly form call_tool({name, args}) invocations.
      const listing = matches
        .map(
          (d) =>
            `• ${d.name}\n  Description: ${d.description}\n  Parameters: ${JSON.stringify(d.parameters)}`,
        )
        .join('\n\n');

      const text =
        `Found ${matches.length} connector tool(s) matching "${query}":\n\n${listing}\n\n` +
        `To use one of these tools, call call_tool with the tool name and args object.`;

      return {
        content: [{ type: 'text', text }],
        details: { query, matches: matches.map((d) => d.name) },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// call_tool
// ---------------------------------------------------------------------------

/**
 * Build the `call_tool` meta-tool.
 *
 * Dispatches a connector tool by name through the Sym ToolDispatcher.
 *
 * Confirm-before-destructive (CRITICAL — fail closed):
 *   If the matched descriptor carries `destructiveHint === true`, the call is
 *   gated through `requestConfirmation` before dispatching. If:
 *     - slackClient or channelId is absent → block immediately (no prompt possible).
 *     - the owner denies → return a blocked result (do NOT dispatch).
 *   This mirrors the eager `beforeToolCall` hook's behaviour exactly, ensuring
 *   destructive connector tools cannot run unconfirmed through either path.
 */
function buildCallToolTool(
  connectorDescriptors: ToolDescriptor[],
  registry: ToolRegistry,
  ctx: ToolRuntimeContext,
  channelId: string | undefined,
  threadTs: string | undefined,
  slackClient: SlackClient | undefined,
): AgentTool {
  // Build a name → descriptor map for O(1) lookup.
  const descriptorMap = new Map<string, ToolDescriptor>(
    connectorDescriptors.map((d) => [d.name, d]),
  );

  return {
    name: 'call_tool',
    label: 'call_tool',
    description:
      'Invoke a connector tool by name with given arguments. ' +
      'Use this after search_tools to run a discovered tool.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'The exact tool name returned by search_tools',
        },
        args: {
          type: 'object',
          description: 'The arguments to pass to the tool (as a JSON object)',
          additionalProperties: true,
        },
      },
      required: ['name', 'args'],
      additionalProperties: false,
    } as unknown as TSchema,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prepareArguments: (a: unknown) => a as any,
    execute: async (toolCallId: string, params: unknown): Promise<AgentToolResult<unknown>> => {
      const { name, args } = params as { name: string; args: JsonObject };

      const descriptor = descriptorMap.get(name);
      if (!descriptor) {
        const validNames = [...descriptorMap.keys()].join(', ');
        const text =
          `Unknown connector tool "${name}". ` +
          `Valid connector tool names: ${validNames || '(none)'}. ` +
          `Use search_tools to find the correct name.`;
        return { content: [{ type: 'text', text }], details: { name, found: false } };
      }

      // -----------------------------------------------------------------
      // Confirm-before-destructive (fail closed)
      // -----------------------------------------------------------------
      if (descriptor.destructiveHint === true) {
        if (!channelId || !slackClient) {
          console.warn(
            `[pi/discovery] destructive connector tool '${name}' blocked: confirmation channel unavailable`,
          );
          const text = `Cannot run "${name}": it is a destructive action but no confirmation channel is available. Blocked.`;
          return { content: [{ type: 'text', text }], details: { name, blocked: true } };
        }

        const argsPreview = JSON.stringify(args ?? {});
        const approved = await requestConfirmation({
          slackClient,
          channel: channelId as SlackChannelId,
          ...(threadTs !== undefined ? { threadTs: threadTs as SlackThreadTs } : {}),
          toolName: name,
          argsPreview,
        });

        if (!approved) {
          const text = `"${name}" was not approved by the owner. Action cancelled.`;
          return {
            content: [{ type: 'text', text }],
            details: { name, blocked: true, approved: false },
          };
        }
      }

      // -----------------------------------------------------------------
      // Dispatch through the Sym ToolDispatcher
      // -----------------------------------------------------------------
      const dispatcher = registry.getDispatcher();
      if (!dispatcher) {
        const text = `Cannot run "${name}": no tool dispatcher is available.`;
        return { content: [{ type: 'text', text }], details: { name, blocked: true } };
      }

      const result = await dispatcher.dispatch({ id: toolCallId, name, arguments: args }, ctx);

      if (!result.ok) {
        // Surface the error as text (not a throw) so the model can see the
        // error and potentially recover, rather than getting an isError message.
        const text = `Tool "${name}" failed: [${result.error.code}] ${result.error.message}`;
        return { content: [{ type: 'text', text }], details: { name, error: result.error } };
      }

      const text =
        typeof result.content === 'string' ? result.content : JSON.stringify(result.content);

      return {
        content: [{ type: 'text', text }],
        details: result,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Build the `[search_tools, call_tool]` meta-tool pair for dynamic connector
 * tool discovery. Only call this when `connectorDescriptors.length > 0`.
 */
export function buildDiscoveryTools(params: BuildDiscoveryToolsParams): AgentTool[] {
  const { connectorDescriptors, registry, ctx, channelId, threadTs, slackClient } = params;

  return [
    buildSearchToolsTool(connectorDescriptors),
    buildCallToolTool(connectorDescriptors, registry, ctx, channelId, threadTs, slackClient),
  ];
}
