import type {
  JsonSchema,
  ToolCall,
  ToolDescriptor,
  ToolDispatcher,
  ToolResult,
  ToolRuntimeContext,
} from '@sym/contracts';

const GET_CURRENT_TIME_DESCRIPTOR: ToolDescriptor = {
  type: 'function',
  name: 'get_current_time',
  description:
    'Get the current UTC date and time as an ISO 8601 string. Use when the user asks the time/date or you need the current moment.',
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  } satisfies JsonSchema,
  readOnlyHint: true,
};

/**
 * Create the built-in in-process tool dispatcher.
 *
 * Currently provides one tool: `get_current_time`.
 * ctx is unused by built-in tools (no side-effects needing workspace context)
 * but is received for interface conformance.
 */
export function createBuiltinDispatcher(): ToolDispatcher {
  return {
    list(): ToolDescriptor[] {
      return [GET_CURRENT_TIME_DESCRIPTOR];
    },

    async dispatch(call: ToolCall, _ctx: ToolRuntimeContext): Promise<ToolResult> {
      if (call.name === 'get_current_time') {
        return { callId: call.id, ok: true, content: new Date().toISOString() };
      }
      return {
        callId: call.id,
        ok: false,
        error: { code: 'not_found', message: `Unknown tool: ${call.name}` },
      };
    },
  };
}
