import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { CallTool } from "./adapter.ts";

// Sym calls T3 from code, not through an Eve connection: the watch loop and reconcile run without
// a model turn, and the model must not launch threads around the ledger (decision 015).

export interface T3Connection {
  call: CallTool;
  close(): Promise<void>;
}

export interface T3ConnectOptions {
  // T3's MCP endpoint, for example `https://worker.example.ts.net/mcp`.
  url: string;
  // Returns the bearer token. Milestone 1 reads a manual token. Later, Sym stores the OAuth token
  // in Postgres after the owner approves the sign-in.
  getToken(): Promise<string>;
}

export async function connectT3(options: T3ConnectOptions): Promise<T3Connection> {
  const client = new Client({ name: "sym", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(options.url), {
    authProvider: { token: options.getToken },
  });
  await client.connect(transport);

  return {
    async call(name, args, options) {
      const result = await client.callTool(
        { name, arguments: args },
        options?.timeoutMs ? { timeout: options.timeoutMs } : undefined,
      );
      if (result.isError) {
        throw new Error(`T3 tool ${name} failed: ${textOf(result.content)}`);
      }
      if (result.structuredContent !== undefined) return result.structuredContent;
      // Tools without an output schema return JSON as text.
      return JSON.parse(textOf(result.content));
    },
    close: () => client.close(),
  };
}

function textOf(content: readonly { type: string; text?: string }[]): string {
  return content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}
