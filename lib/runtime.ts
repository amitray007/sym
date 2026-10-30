import { connect, type Sql } from "./db.ts";
import { type JobDeps, type LedgerDeps, parseWorkerModel } from "./jobs/run.ts";
import { type Pack, packFromEnv } from "./pack/load.ts";
import { type AllowedProject, allowedProjects } from "./projects/allowed.ts";
import { createEmojiCache, type EmojiCache } from "./reactions/emoji.ts";
import type { SlackApi } from "./slack/api.ts";
import { slackApiFromEnv } from "./slack/eve-api.ts";
import { getCredential } from "./workers/credentials.ts";
import { type ResolvedWorker, resolveWorker, workerIdentity } from "./workers/resolve.ts";
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

// SYM_WORKER_MODEL, the default worker model. A malformed value only warns: every ledger step
// builds these deps, so a typo must not stop delivery or reconcile. Jobs then use the list default.
function envWorkerModel() {
  try {
    return parseWorkerModel(process.env.SYM_WORKER_MODEL);
  } catch (error) {
    console.warn(error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

// The projects Sym may touch: the pack's, else SYM_PROJECTS, else none (decision 042).
export function allowedFromEnv(): AllowedProject[] {
  return allowedProjects(pack(), process.env.SYM_PROJECTS);
}

export function ledgerDeps(): LedgerDeps {
  const slack = slackFromEnv();
  const adopterPack = pack();
  const workerModel = envWorkerModel();
  return {
    sql: ledger(),
    allowedProjects: allowedFromEnv(),
    ...(workerModel ? { workerModel } : {}),
    ...(slack ? { slack } : {}),
    ...(adopterPack ? { pack: adopterPack } : {}),
  };
}

// The worker URL and token: the stored sign-in, then the pack worker with T3_TOKEN, then
// T3_MCP_URL with T3_TOKEN (decision 036). Nothing when none is configured.
export function currentWorker(): Promise<ResolvedWorker | undefined> {
  return resolveWorker(pack(), process.env, (name) => getCredential(ledger(), name));
}

// No worker URL and token at all: a setup gap, not an outage. Reconcile skips the worker pass
// for it instead of marking jobs offline.
export class WorkerNotConfiguredError extends Error {
  override name = "WorkerNotConfiguredError";
  constructor() {
    super(
      "Sym has no worker sign-in. Ask Sym to sign in to the worker, or set T3_MCP_URL and " +
        "T3_TOKEN (docs/workers.md).",
    );
  }
}

// Opens a worker connection for one step and closes it after. A step can run on any replay, so
// it holds no connection across durable waits.
export async function withJobDeps<T>(fn: (deps: JobDeps) => Promise<T>): Promise<T> {
  const worker = await currentWorker();
  if (!worker) throw new WorkerNotConfiguredError();
  const { token } = worker;
  const connection = await connectT3({ url: worker.url, getToken: async () => token });
  try {
    // `workerName` names the worker this connection reaches, so a job for a pack project on
    // another worker is refused instead of running here.
    const deps = {
      ...ledgerDeps(),
      worker: t3Adapter(connection.call, {
        signInExpiresAt: worker.expiresAt,
        upload: connection.upload,
      }),
      workerName: worker.name,
      workerIdentity: workerIdentity(worker.name, worker.url),
    };
    return await fn(deps);
  } finally {
    await connection.close();
  }
}

let emoji: EmojiCache | undefined;

// The workspace's custom emoji, listed at most once an hour per process (decision 051).
export function emojiCache(): EmojiCache {
  emoji ??= createEmojiCache(slackFromEnv());
  return emoji;
}

export async function withLedger<T>(fn: (sql: Sql) => Promise<T>): Promise<T> {
  return fn(ledger());
}
