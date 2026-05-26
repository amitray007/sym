/**
 * Bridge Sym's ToolRegistry → Pi's AgentTool[].
 *
 * Each ToolDescriptor from the composite dispatcher (builtins + MCP connectors)
 * becomes an AgentTool. The execute function dispatches through the existing
 * Sym dispatcher so per-user connector auth (resolveConnectorAuth) is preserved
 * exactly as in the kernel loop.
 *
 * Schema bridge: Sym's `ToolDescriptor.parameters` is a JSON Schema object.
 * Pi's `AgentTool.parameters` is TypeBox `TSchema`. TypeBox TSchema IS JSON
 * Schema at runtime — we pass the existing JSON Schema through with a type cast.
 * Pi's openai-completions provider serializes it as JSON Schema for the model;
 * if Pi's argument validator rejects a raw JSON Schema, the `prepareArguments`
 * passthrough below bypasses validation and returns the raw args unchanged.
 *
 * // TODO(pi): chunk 3.5 — if Pi adds strict TypeBox runtime validation and
 * rejects plain JSON Schema, migrate to Type.Unsafe(descriptor.parameters) here.
 */

import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { TSchema } from '@earendil-works/pi-ai';
import type { JsonObject, ToolDescriptor, ToolRuntimeContext } from '@sym/contracts';
import type { ToolRegistry } from '@sym/kernel';

/**
 * Convert a single Sym `ToolDescriptor` into a Pi `AgentTool`.
 *
 * The `execute` function dispatches through Sym's `ToolDispatcher` so that
 * connector auth, audit hooks, and error handling are identical to the kernel loop.
 *
 * On a Sym tool error (`ok: false`), we throw — Pi surfaces thrown errors to the
 * model as `isError` tool result messages, which is the correct behaviour for
 * recoverable tool failures.
 */
function bridgeTool(
  descriptor: ToolDescriptor,
  registry: ToolRegistry,
  ctx: ToolRuntimeContext,
): AgentTool {
  return {
    name: descriptor.name,
    label: descriptor.name,
    description: descriptor.description,
    // JSON Schema cast to TSchema — structurally identical at runtime.
    // Pi serialises it to the model as JSON Schema.
    // prepareArguments is set below to bypass TypeBox runtime validation.
    // TODO(pi): chunk 3.5 — evaluate Type.Unsafe() wrapper if Pi validates args strictly.
    parameters: descriptor.parameters as unknown as TSchema,
    // Bypass Pi's TypeBox runtime argument validation: return args as-is.
    // Sym's dispatcher validates / coerces args internally.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prepareArguments: (args: unknown) => args as any,
    execute: async (toolCallId: string, params: unknown): Promise<AgentToolResult<unknown>> => {
      const dispatcher = registry.getDispatcher();
      if (!dispatcher) {
        throw new Error(`[pi] no dispatcher available for tool '${descriptor.name}'`);
      }

      const result = await dispatcher.dispatch(
        { id: toolCallId, name: descriptor.name, arguments: params as JsonObject },
        ctx,
      );

      if (!result.ok) {
        // Throw so Pi surfaces it as isError=true in the tool-result message.
        throw new Error(`[${result.error.code}]: ${result.error.message}`);
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

/**
 * Build the full Pi `AgentTool[]` from Sym's registry + runtime context.
 *
 * Returns an empty array when the registry has no tools — Pi will send the model
 * no tool schemas, mirroring the kernel loop's behaviour.
 */
export function bridgeTools(registry: ToolRegistry, ctx: ToolRuntimeContext): AgentTool[] {
  const descriptors = registry.listTools();
  return descriptors.map((d) => bridgeTool(d, registry, ctx));
}
