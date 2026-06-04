/**
 * Built-in tool: get_current_time.
 *
 * Returns the current UTC date/time as an ISO 8601 string. No Slack API
 * calls; pure in-process. Used when the owner asks the time/date or the
 * model needs the current moment to construct search queries.
 */

import type { JsonSchema, ToolCall, ToolDescriptor, ToolResult } from '@sym/contracts';

export const GET_CURRENT_TIME_DESCRIPTOR: ToolDescriptor = {
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

export function handleGetCurrentTime(call: ToolCall): ToolResult {
  return { callId: call.id, ok: true, content: new Date().toISOString() };
}
