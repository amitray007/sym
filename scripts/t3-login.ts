// Milestone 1: sign Sym in to a T3 worker with T3's OAuth consent flow, then save the token to
// `.env.local` for `pnpm t3:check` and `eve dev`. Run `pnpm t3:login <mcp-url>`.
//
// The owner approves the sign-in on T3's page and picks the access level there (Auto by default,
// decision 009). The script never prints the token or the authorization code. Later, Sym runs
// this flow itself and stores the token in Postgres (decision 015).
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import {
  discoverOAuthServerInfo,
  exchangeAuthorization,
  registerClient,
  startAuthorization,
} from "@modelcontextprotocol/client";

const ENV_FILE = ".env.local";
const SCOPE = "orchestration:read orchestration:operate";
const TIMEOUT_MS = 10 * 60 * 1000;

const mcpUrl = process.argv[2] ?? process.env.T3_MCP_URL;
if (!mcpUrl) {
  console.error("Usage: pnpm t3:login <mcp-url>, for example http://127.0.0.1:3773/mcp");
  process.exit(1);
}

// A loopback listener receives the redirect. T3 matches loopback redirects on everything but the
// port, so a random port works.
const state = randomBytes(16).toString("hex");
const callback = await listenForCallback(state);
const redirectUrl = `http://127.0.0.1:${callback.port}/callback`;

try {
  const { authorizationServerUrl, authorizationServerMetadata: metadata } =
    await discoverOAuthServerInfo(mcpUrl);
  const clientInformation = await registerClient(authorizationServerUrl, {
    ...(metadata ? { metadata } : {}),
    clientMetadata: {
      client_name: "Sym",
      redirect_uris: [redirectUrl],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
  });

  const { authorizationUrl, codeVerifier } = await startAuthorization(authorizationServerUrl, {
    ...(metadata ? { metadata } : {}),
    clientInformation,
    redirectUrl,
    scope: SCOPE,
    state,
    resource: mcpUrl,
  });

  openInBrowser(authorizationUrl.toString());
  console.info("Approve Sym on the T3 sign-in page in your browser, and pick the access level.");

  const params = await callback.result;
  const error = params.get("error");
  if (error) throw new Error(`T3 refused the sign-in: ${error}`);
  const code = params.get("code");
  const issuer = params.get("iss");
  if (!code) throw new Error("The sign-in redirect had no authorization code.");

  const tokens = await exchangeAuthorization(authorizationServerUrl, {
    ...(metadata ? { metadata } : {}),
    clientInformation,
    authorizationCode: code,
    // T3 sends its issuer on the redirect (RFC 9207). The SDK checks it against the metadata.
    ...(issuer ? { iss: issuer } : {}),
    codeVerifier,
    redirectUri: redirectUrl,
    resource: mcpUrl,
  });

  const expiresAt =
    tokens.expires_in === undefined
      ? undefined
      : new Date(Date.now() + tokens.expires_in * 1000).toISOString();
  upsertEnv(ENV_FILE, {
    T3_MCP_URL: mcpUrl,
    T3_TOKEN: tokens.access_token,
    // An empty value clears an expiry left by an earlier token.
    T3_TOKEN_EXPIRES_AT: expiresAt ?? "",
  });
  console.info(`Signed in. Saved the token to ${ENV_FILE}.`);
  if (expiresAt) console.info(`The token expires at ${expiresAt}. Run this again before then.`);
} finally {
  callback.close();
}

// Resolves on the first redirect that carries our state. Other requests get 400, so a stray local
// request cannot end the sign-in.
function listenForCallback(state: string) {
  let resolve: (params: URLSearchParams) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const result = new Promise<URLSearchParams>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      response.writeHead(404).end();
      return;
    }
    if (url.searchParams.get("state") !== state) {
      response.writeHead(400).end();
      return;
    }
    response.writeHead(200, { "content-type": "text/plain" }).end("Sym: done. Close this tab.");
    resolve(url.searchParams);
  });
  const timer = setTimeout(() => reject(new Error("The sign-in timed out.")), TIMEOUT_MS);
  return new Promise<{ port: number; result: Promise<URLSearchParams>; close(): void }>((ready) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("No callback port.");
      ready({
        port: address.port,
        result,
        close: () => {
          clearTimeout(timer);
          server.close();
        },
      });
    });
  });
}

function openInBrowser(url: string) {
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  execFile(command, [url], (error) => {
    // Without a browser, show the page address. It holds no secret: the code verifier stays here.
    if (error) console.info(`Open this page to approve Sym:\n${url}`);
  });
}

// Replaces or appends each key in the env file. Other lines stay as they are.
function upsertEnv(path: string, entries: Record<string, string>) {
  const text = existsSync(path) ? readFileSync(path, "utf8").replace(/\n+$/, "") : "";
  const lines = text === "" ? [] : text.split("\n");
  for (const [key, value] of Object.entries(entries)) {
    const index = lines.findIndex((line) => line.startsWith(`${key}=`));
    if (index === -1) lines.push(`${key}=${value}`);
    else lines[index] = `${key}=${value}`;
  }
  writeFileSync(path, `${lines.join("\n")}\n`);
  // The file holds secrets. An existing file keeps its old mode on write, so set it each time.
  chmodSync(path, 0o600);
}
