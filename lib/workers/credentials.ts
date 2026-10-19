import type { Sql } from "../db.ts";

// The worker sign-in store (decision 036). The owner approves the OAuth sign-in in the browser,
// and the `worker_sign_in` tool saves the token here. Postgres is the source of truth, so a new
// session or a restart keeps the sign-in.
//
// The token is a secret. Nothing here logs it, and every error is rebuilt without the query
// parameters, so a failed write cannot put the token in a log.

export const DEFAULT_WORKER = "default";

export interface WorkerCredential {
  worker: string;
  mcpUrl: string;
  accessToken: string;
  expiresAt: Date | null;
  approvedBy: string | null;
  createdAt: Date;
}

export interface NewWorkerCredential {
  worker: string;
  mcpUrl: string;
  accessToken: string;
  expiresAt: Date | null;
  approvedBy: string | null;
}

// Saves the sign-in. A new sign-in replaces the old one for the same worker.
export async function saveCredential(sql: Sql, credential: NewWorkerCredential): Promise<void> {
  try {
    await sql`
      insert into worker_credentials (worker, mcp_url, access_token, expires_at, approved_by)
      values (
        ${credential.worker}, ${credential.mcpUrl}, ${credential.accessToken},
        ${credential.expiresAt}, ${credential.approvedBy}
      )
      on conflict (worker) do update set
        mcp_url = excluded.mcp_url,
        access_token = excluded.access_token,
        expires_at = excluded.expires_at,
        approved_by = excluded.approved_by,
        created_at = now()
    `;
  } catch (error) {
    throw safeError("save", error);
  }
}

export async function getCredential(
  sql: Sql,
  worker: string,
): Promise<WorkerCredential | undefined> {
  try {
    const [row] = await sql<WorkerCredential[]>`
      select worker, mcp_url, access_token, expires_at, approved_by, created_at
      from worker_credentials where worker = ${worker}
    `;
    return row;
  } catch (error) {
    throw safeError("read", error);
  }
}

// A new error with the Postgres error code only. postgres.js errors can carry the query and
// its parameters, and the parameters hold the token.
function safeError(action: "save" | "read", error: unknown): Error {
  const code =
    error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? ` (${error.code})`
      : "";
  return new Error(`Sym could not ${action} the worker sign-in${code}.`);
}
