import type { Sql } from "../db.ts";
import { jobRef } from "../ledger/jobs.ts";

// Independent random credentials, never derived from the shared status-read bearer. Persisted
// before launch so a lost response can reuse the same capability without rotating a running job.
export async function issueWorkerCapability(sql: Sql, jobId: number, endpoint: string) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = `symjob_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  const [row] = await sql<{ token: string; endpoint: string }[]>`
    insert into worker_capabilities (job_id, token, endpoint)
    values (${jobId}, ${token}, ${endpoint})
    on conflict (job_id) do update set job_id = excluded.job_id
    returning token, endpoint
  `;
  if (!row) throw new Error("Worker capability was not recorded.");
  return row;
}

export async function workerCapabilityJob(sql: Sql, token: string): Promise<number | undefined> {
  if (!/^symjob_[a-f0-9]{64}$/.test(token)) return undefined;
  const [row] = await sql<{ jobId: number }[]>`
    select c.job_id from worker_capabilities c join jobs j on j.id = c.job_id
    where c.token = ${token} and j.status not in ('done', 'failed', 'cancelled')
  `;
  return row ? Number(row.jobId) : undefined;
}

export async function workerCapabilityEndpoint(sql: Sql, jobId: number) {
  const [row] = await sql<{ endpoint: string }[]>`
    select endpoint from worker_capabilities where job_id = ${jobId}
  `;
  return row?.endpoint;
}

export async function workerCallbackInstructions(sql: Sql, jobId: number, endpoint: string) {
  const credential = await issueWorkerCapability(sql, jobId, endpoint);
  return `Worker tools for ${jobRef(jobId)}: connect an MCP client to ${credential.endpoint}
with Authorization: Bearer ${credential.token}
Use sym_post_progress or sym_ask_owner with job "${jobRef(jobId)}". This credential can update
only this job and stops working when it ends. Keep it private: never put it in files, commits,
logs, Slack, or your report. It replaces any earlier job credential in this thread.`;
}
