import { connect, type Sql } from "./db.ts";
import { type JobDeps, type LedgerDeps, parseWorkerModel } from "./jobs/run.ts";
import { type Pack, packFromEnv } from "./pack/load.ts";
import type { SlackApi } from "./slack/api.ts";
import { slackApiFromEnv } from "./slack/eve-api.ts";
import { parseSignInExpiry } from "./workers/expiry.ts";
import { t3Adapter } from "./workers/t3/adapter.ts";
import { connectT3 } from "./workers/t3/client.ts";

// Real dependencies for workflow steps, schedules, and tools. Tests build JobDeps from fakes.

let pool: Sql | undefined;

export function ledger(): Sql {
  pool ??= connect();
  return pool;
}

// Sym posts to Slack itself only when the deployment has a bot token. Without one (local runs
// through the Eve channel), posts wait in the outbox.
export function slackFromEnv(): SlackApi | undefined {
  return process.env.SLACK_BOT_TOKEN ? slackApiFromEnv() : undefined;
}

let loadedPack: { pack: Pack | undefined } | undefined;

// The adopter pack from SYM_PACK_DIR, read once. An invalid pack throws with the file and the
// field, so a bad pack stops jobs instead of running them without its rules (decision 026).
export function pack(): Pack | undefined {
  loadedPack ??= { pack: packFromEnv() };
  return loadedPack.pack;
}

export function ledgerDeps(): LedgerDeps {
  const slack = slackFromEnv();
  const adopterPack = pack();
  return {
    sql: ledger(),
    ...(slack ? { slack } : {}),
    ...(adopterPack ? { pack: adopterPack } : {}),
  };
}

// Opens a worker connection for one step and closes it after. A step can run on any replay, so
// it holds no connection across durable waits.
export async function withJobDeps<T>(fn: (deps: JobDeps) => Promise<T>): Promise<T> {
  const url = process.env.T3_MCP_URL;
  const token = process.env.T3_TOKEN;
  if (!url || !token) {
    throw new Error(
      "Set T3_MCP_URL and T3_TOKEN. Run `pnpm t3:login <mcp-url>` (docs/workers.md).",
    );
  }
  const connection = await connectT3({ url, getToken: async () => token });
  try {
    const workerModel = parseWorkerModel(process.env.SYM_WORKER_MODEL);
    return await fn({
      ...ledgerDeps(),
      worker: t3Adapter(connection.call, {
        signInExpiresAt: parseSignInExpiry(process.env.T3_TOKEN_EXPIRES_AT),
      }),
      ...(workerModel ? { workerModel } : {}),
    });
  } finally {
    await connection.close();
  }
}

export async function withLedger<T>(fn: (sql: Sql) => Promise<T>): Promise<T> {
  return fn(ledger());
}
