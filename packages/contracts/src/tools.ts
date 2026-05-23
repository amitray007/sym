import type { JsonObject, JsonSchema, JsonValue } from './json.js';
import type { SandboxContext } from './sandbox.js';

/**
 * A function-tool the model may call. OpenAI-compatible shape. The exact
 * provider wire format (Fireworks vs OpenAI streaming deltas) is finalized
 * when S5 wires tools end-to-end (overview decision D2).
 */
export interface ToolDescriptor {
  type: 'function';
  name: string;
  description: string;
  parameters: JsonSchema;
}

/** A resolved tool invocation handed to the dispatcher (arguments parsed). */
export interface ToolCall {
  id: string;
  name: string;
  arguments: JsonObject;
}

export type ToolErrorCode =
  | 'not_found'
  | 'invalid_arguments'
  | 'execution_failed'
  | 'timeout'
  | 'unauthorized'
  | 'egress_denied';

export interface ToolError {
  code: ToolErrorCode;
  message: string;
  retryable?: boolean;
}

export interface ToolSuccess {
  callId: string;
  ok: true;
  content: JsonValue | string;
}

export interface ToolFailure {
  callId: string;
  ok: false;
  error: ToolError;
}

export type ToolResult = ToolSuccess | ToolFailure;

/**
 * The tool registry + dispatcher the kernel (S2) calls. Implemented by S5,
 * which runs the call inside the S6 sandbox via `ctx`. An empty registry
 * fails calls closed until S5 ships.
 */
export interface ToolDispatcher {
  list(): ToolDescriptor[];
  dispatch(call: ToolCall, ctx: SandboxContext): Promise<ToolResult>;
}
