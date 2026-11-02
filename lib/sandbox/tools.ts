import { defineTool, type ToolContext, type ToolDefinition } from "eve/tools";
import { isWorkerCaller, NOT_FOR_WORKERS } from "../callers.ts";
import { carriesSecret, sandboxEnabled } from "./config.ts";

// Eve's sandbox tools (bash, read_file, write_file, glob, grep) with Sym's checks in front
// (decision 089). Each refusal is a tool error: the brain reads it and the turn goes on.

export const SANDBOX_OFF =
  "The sandbox is off on this deployment, so Sym cannot run commands or open files. Answer without it.";
export const CARRIES_SECRET =
  "Refused: the input contains one of Sym's secrets, and secrets never enter the sandbox.";

export function sandboxUnavailable(error: unknown): string {
  const reason = (error instanceof Error ? error.message : String(error)).split("\n", 1)[0] ?? "";
  return `The sandbox is not available right now (${reason.slice(0, 200)}). Answer without it, and say the sandbox is unavailable if the person asked for it.`;
}

export function sandboxTool<Input, Output>(
  tool: ToolDefinition<Input, Output>,
): ToolDefinition<Input, Output> {
  return defineTool({
    ...tool,
    async execute(input: Input, ctx: ToolContext): Promise<Output> {
      // Eve's MCP channel publishes every plain tool. Worker threads have their own machines.
      if (isWorkerCaller(ctx.session.auth.current)) throw new Error(NOT_FOR_WORKERS);
      if (!sandboxEnabled()) throw new Error(SANDBOX_OFF);
      if (carriesSecret(JSON.stringify(input) ?? "")) throw new Error(CARRIES_SECRET);
      try {
        await ctx.getSandbox();
      } catch (error) {
        throw new Error(sandboxUnavailable(error));
      }
      return (await tool.execute(input, ctx)) as Output;
    },
  });
}
