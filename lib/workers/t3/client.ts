import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { workerNoun } from "../../worker-label.ts";
import type { CallTool } from "./adapter.ts";

// Sym calls T3 from code, not through an Eve connection: the watch loop and reconcile run without
// a model turn, and the model must not launch threads around the ledger (decision 015).

export interface T3Connection {
  call: CallTool;
  // POSTs a file's bytes to an upload URL from `t3_attachment_prepare_upload`. The URL is
  // signed, so the request carries no token.
  upload(relativeUrl: string, bytes: Uint8Array, mimeType: string): Promise<void>;
  close(): Promise<void>;
}

export interface T3ConnectOptions {
  // T3's MCP endpoint, for example `https://worker.example.ts.net/mcp`.
  url: string;
  // Returns the bearer token: the stored sign-in, else `T3_TOKEN` (lib/workers/resolve.ts).
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
        throw new Error(`The ${workerNoun()} failed a call (${name}): ${textOf(result.content)}`);
      }
      if (result.structuredContent !== undefined) return result.structuredContent;
      // Tools without an output schema return JSON as text.
      return JSON.parse(textOf(result.content));
    },
    async upload(relativeUrl, bytes, mimeType) {
      const origin = new URL(options.url).origin;
      const target = new URL(relativeUrl, origin);
      if (target.origin !== origin)
        throw new Error(`The ${workerNoun()} gave an upload URL on another host.`);
      const response = await fetch(target, {
        method: "POST",
        headers: { "content-type": mimeType },
        body: bytes,
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok)
        throw new Error(`The ${workerNoun()} refused an upload: ${response.status}`);
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
