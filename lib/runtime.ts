import { connect, type Sql } from "./db.ts";
import { type JobDeps, parseWorkerModel } from "./jobs/run.ts";
import { t3Adapter } from "./workers/t3/adapter.ts";
import { connectT3 } from "./workers/t3/client.ts";

// Real dependencies for workflow steps. Tests build JobDeps from fakes instead.

let pool: Sql | undefined;

function ledger(): Sql {
  pool ??= connect();
  return pool;
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
      sql: ledger(),
      worker: t3Adapter(connection.call),
      ...(workerModel ? { workerModel } : {}),
    });
  } finally {
    await connection.close();
  }
}

export async function withLedger<T>(fn: (sql: Sql) => Promise<T>): Promise<T> {
  return fn(ledger());
}
