import type { Pack } from "../pack/load.ts";
import { DEFAULT_WORKER, type WorkerCredential } from "./credentials.ts";
import { parseSignInExpiry } from "./expiry.ts";

// Where the worker URL and token come from (decision 036), in order:
// 1. The stored sign-in in Postgres, from the `worker_sign_in` tool.
// 2. The pack worker's `mcpUrl` with the env `T3_TOKEN`.
// 3. The env `T3_MCP_URL` with `T3_TOKEN`.
// Sym connects to one worker: the pack's first worker, else "default".

export interface WorkerTarget {
  // The worker name the sign-in is stored under.
  name: string;
  // The configured MCP URL, if any. The sign-in tool signs in to this URL.
  mcpUrl: string | undefined;
}

export interface ResolvedWorker {
  name: string;
  url: string;
  token: string;
  expiresAt: Date | null;
  source: "stored" | "pack" | "env";
}

// Do not put credentials or query values in the ledger. An unsafe URL cannot identify a
// follow-up, so the launch remains usable but its thread cannot be resumed through Fix.
export function workerIdentity(name: string, endpoint: string): string | undefined {
  try {
    const url = new URL(endpoint);
    if (url.username || url.password || url.search || url.hash) return undefined;
    return JSON.stringify([name, url.href]);
  } catch {
    return undefined;
  }
}

export function workerTarget(
  pack: Pack | undefined,
  env: Record<string, string | undefined>,
): WorkerTarget {
  const worker = pack?.config.workers[0];
  if (worker) return { name: worker.name, mcpUrl: worker.mcpUrl };
  return { name: DEFAULT_WORKER, mcpUrl: env.T3_MCP_URL?.trim() || undefined };
}

// Returns nothing when no worker URL and token are configured. A stored sign-in for another URL
// than the configured one is stale, so it does not count.
export async function resolveWorker(
  pack: Pack | undefined,
  env: Record<string, string | undefined>,
  stored: (name: string) => Promise<WorkerCredential | undefined>,
): Promise<ResolvedWorker | undefined> {
  const target = workerTarget(pack, env);
  const credential = await stored(target.name);
  if (credential && (!target.mcpUrl || sameUrl(credential.mcpUrl, target.mcpUrl))) {
    return {
      name: target.name,
      url: credential.mcpUrl,
      token: credential.accessToken,
      expiresAt: credential.expiresAt,
      source: "stored",
    };
  }
  const token = env.T3_TOKEN?.trim();
  if (!target.mcpUrl || !token) return undefined;
  return {
    name: target.name,
    url: target.mcpUrl,
    token,
    expiresAt: parseSignInExpiry(env.T3_TOKEN_EXPIRES_AT),
    source: pack?.config.workers[0] ? "pack" : "env",
  };
}

function sameUrl(a: string, b: string): boolean {
  const trim = (value: string) => value.replace(/\/+$/, "");
  return trim(a) === trim(b);
}
