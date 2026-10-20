import {
  Client,
  discoverOAuthServerInfo,
  extractWWWAuthenticateParams,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { isLoopback } from "../workers/sign-in.ts";
import { type ListedTool, MAX_TOOLS } from "./tools.ts";

// Probes an MCP server before the owner approves it (decision 045). Sym connects anonymously
// first. Tools that list are recorded. A 401 means the server needs a sign-in: OAuth when the
// server's authorization server offers dynamic client registration, else a bearer token from
// the deployment environment. Every request times out fast.

const PROBE_TIMEOUT_MS = 8_000;
const MAX_PAGES = 5;

export type UrlCheck = { ok: true; url: string } | { ok: false; reason: string };

// The worker's rule: https, or plain http on a loopback host. No user name or password in the
// URL, because the URL is shown in Slack.
export function checkServerUrl(raw: string): UrlCheck {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: "That is not a URL." };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "Leave the user name and password out of the URL." };
  }
  if (url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url.hostname))) {
    url.hash = "";
    return { ok: true, url: url.toString() };
  }
  return { ok: false, reason: "The server needs an https URL. Plain http works only on loopback." };
}

export type Probe =
  // `instructions` is the server's raw `initialize` text. Run it through recordInstructions.
  | { kind: "tools"; tools: ListedTool[]; instructions?: string | undefined }
  // The server refused the request without a valid token.
  | { kind: "unauthorized"; oauth: boolean }
  | { kind: "failed"; reason: string };

export interface ProbeOptions {
  // A bearer token. Without one, Sym connects anonymously.
  token?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export async function probeServer(url: string, options: ProbeOptions = {}): Promise<Probe> {
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const baseFetch = options.fetch ?? fetch;
  let challenge: { resourceMetadataUrl?: URL } | undefined;
  // Every request gets a deadline. A 401 is kept, so Sym can read its WWW-Authenticate header.
  const timedFetch = async (input: string | URL | Request, init?: RequestInit) => {
    const signal = init?.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs);
    const response = await baseFetch(input, { ...init, signal, redirect: "error" });
    if (response.status === 401) challenge = extractWWWAuthenticateParams(response);
    return response;
  };

  const client = new Client({ name: "sym", version: "0.0.0" });
  const token = options.token;
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    fetch: timedFetch,
    ...(token ? { authProvider: { token: async () => token } } : {}),
  });
  try {
    await client.connect(transport, { timeout: timeoutMs });
    const tools: ListedTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES && tools.length < MAX_TOOLS; page++) {
      const result = await client.listTools(cursor ? { cursor } : {}, { timeout: timeoutMs });
      tools.push(...result.tools);
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    return { kind: "tools", tools, instructions: client.getInstructions() };
  } catch (error) {
    if (challenge) {
      return {
        kind: "unauthorized",
        oauth: await offersOAuth(url, challenge.resourceMetadataUrl, timedFetch),
      };
    }
    return { kind: "failed", reason: `Sym could not reach the server (${describe(error)}).` };
  } finally {
    await client.close().catch(() => {});
  }
}

// OAuth needs an authorization server that registers clients on its own (RFC 7591), because
// Sym registers itself at each sign-in.
async function offersOAuth(
  url: string,
  resourceMetadataUrl: URL | undefined,
  fetchFn: typeof fetch,
): Promise<boolean> {
  try {
    const info = await discoverOAuthServerInfo(url, {
      ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}),
      fetchFn,
    });
    return Boolean(info.authorizationServerMetadata?.registration_endpoint);
  } catch {
    return false;
  }
}

// A short reason without server text: the error name, and the HTTP status when there is one.
function describe(error: unknown): string {
  if (error instanceof Error && error.name === "TimeoutError") return "timed out";
  const status =
    error && typeof error === "object" && "data" in error
      ? (error.data as { status?: unknown } | undefined)?.status
      : undefined;
  const name = error instanceof Error ? error.name : "Error";
  return typeof status === "number" ? `${name}, HTTP ${status}` : name;
}
