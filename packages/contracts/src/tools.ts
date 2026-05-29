import type { ConversationId, SlackChannelId, SlackUserId, TurnId, WorkspaceId } from './ids.js';
import type { JsonObject, JsonSchema, JsonValue } from './json.js';
import type { RenderIntent } from './render.js';

/**
 * A function-tool the model may call. OpenAI-compatible shape (Fireworks
 * openai-completions API).
 */
export interface ToolDescriptor {
  type: 'function';
  name: string;
  description: string;
  parameters: JsonSchema;
  /** Tool only reads — no side effects. Advisor-eligible; never needs confirmation. */
  readOnlyHint?: boolean;
  /** Tool performs a destructive/irreversible action — requires user confirmation. */
  destructiveHint?: boolean;
  /**
   * Which Slack identity this tool acts under.
   *  - `'bot'`  (default) — workspace bot token; the tool acts AS Sym.
   *  - `'user'` — owner's user token; the tool acts AS the owner (Amit).
   *
   * READ tools that prefer `'user'` (broader visibility into private
   * channels / DMs / full search) fall back to the bot token when no user
   * token is configured. ACT-AS-OWNER WRITE tools with `actor: 'user'`
   * AND `destructiveHint: true` hard-require the user token — they fail
   * cleanly when it's missing rather than silently posting as Sym.
   */
  actor?: 'bot' | 'user';
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
  /**
   * Optional presentation hint. `content` always carries the model-facing text
   * (the model reasons over it unchanged); `render`, when set, is surfaced to
   * the user as Block Kit by the Slack adapter. Code owns the blocks — the
   * model never authors them. Ignored by consumers that only read `content`.
   */
  render?: RenderIntent;
}

export interface ToolFailure {
  callId: string;
  ok: false;
  error: ToolError;
}

export type ToolResult = ToolSuccess | ToolFailure;

/**
 * Harness-owned execution context passed to every tool dispatch. Targeting for
 * context-bound side-effect tools comes from HERE — `channelId`, `conversationId`
 * — never from model-provided arguments (harness-tool-context-spec).
 */
export interface ToolRuntimeContext {
  workspaceId: WorkspaceId;
  conversationId: ConversationId;
  /** Active Slack channel for context-bound tools; absent for non-Slack turns. */
  channelId?: SlackChannelId;
  requester: SlackUserId;
  turnId: TurnId;
}

/**
 * The tool registry + dispatcher the kernel calls. Built-in harness tools run
 * in-process; remote tools run over HTTP. An empty registry fails calls closed.
 */
export interface ToolDispatcher {
  list(): ToolDescriptor[];
  dispatch(call: ToolCall, ctx: ToolRuntimeContext): Promise<ToolResult>;
}
