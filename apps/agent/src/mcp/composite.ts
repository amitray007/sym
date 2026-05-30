/**
 * CompositeDispatcher — combines the builtin dispatcher and the MCP dispatcher
 * into a single `ToolDispatcher` presented to the Pi loop.
 *
 * `list()`:   builtin tools first, then MCP tools (preserves tool-order for
 *             the model; builtin tools are most commonly called).
 *
 * `dispatch()`: routes by prefix — any tool name containing `__` is routed
 *               to the MCP dispatcher; all others go to builtin. This is safe
 *               because builtin tool names never contain `__`.
 */

import { MCP_TOOL_SEPARATOR } from './dispatcher.js';

import type {
  ToolCall,
  ToolDescriptor,
  ToolDispatcher,
  ToolResult,
  ToolRuntimeContext,
} from '@sym/contracts';

export class CompositeDispatcher implements ToolDispatcher {
  constructor(
    private readonly builtin: ToolDispatcher,
    private readonly mcp: ToolDispatcher,
  ) {}

  list(): ToolDescriptor[] {
    return [...this.builtin.list(), ...this.mcp.list()];
  }

  dispatch(call: ToolCall, ctx: ToolRuntimeContext): Promise<ToolResult> {
    // MCP tools are namespaced as `<serverName>__<toolName>`.
    // Builtin tool names never contain the separator.
    if (call.name.includes(MCP_TOOL_SEPARATOR)) {
      return this.mcp.dispatch(call, ctx);
    }
    return this.builtin.dispatch(call, ctx);
  }
}
