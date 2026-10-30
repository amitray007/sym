import type { Sql } from "../db.ts";
import { getJob, type Job, json } from "./jobs.ts";

export const START_ACTION_ID = "sym_proposal_start";
export const DISMISS_ACTION_ID = "sym_proposal_dismiss";

export function startWakeToken(requestKey: string): string {
  return `sym:start:${requestKey}`;
}
export interface JobProposal {
  id: string;
  jobId: number;
  kind: "start" | "followup";
  payload: unknown;
  revision: number;
  channel: string;
  threadTs: string | null;
  message: string;
  messageTs: string | null;
  status: "pending" | "approved" | "dismissed" | "expired";
  decidedBy: string | null;
}

export async function propose(
  sql: Sql,
  input: { key: string; job: Job; kind: JobProposal["kind"]; payload: unknown; message: string },
): Promise<JobProposal> {
  const { job } = input;
  if (!job.slackChannel) throw new Error("This job has no conversation to ask in.");
  return sql.begin(async (transaction) => {
    const tx = transaction as unknown as Sql;
    await tx`select pg_advisory_xact_lock(hashtext(current_schema()), hashtext(${`${job.slackChannel}:${job.slackThreadTs ?? ""}`}))`;
    await tx`select id from jobs where id = ${job.id} for update`;
    const [existing] = await tx<
      JobProposal[]
    >`select * from job_proposals where request_key = ${input.key}`;
    if (existing) return normalize(existing);
    if (input.kind === "start") {
      await tx`update jobs set status = 'cancelled', finished_at = now()
        where id in (select job_id from job_proposals where channel = ${job.slackChannel}
          and thread_ts is not distinct from ${job.slackThreadTs} and kind = 'start' and status = 'pending')
        and id <> ${job.id} and status = 'launching'`;
      await tx`update job_proposals set status = 'expired' where channel = ${job.slackChannel}
        and thread_ts is not distinct from ${job.slackThreadTs} and kind = 'start' and status = 'pending'`;
    }
    await tx`update job_proposals set status = 'expired' where job_id = ${job.id} and status = 'pending'`;
    const [row] = await tx<JobProposal[]>`
      insert into job_proposals (request_key, job_id, kind, payload, revision, channel, thread_ts, message)
      values (${input.key}, ${job.id}, ${input.kind}, ${json(tx, input.payload)}, ${job.revision}, ${job.slackChannel}, ${job.slackThreadTs}, ${input.message}) returning *
    `;
    if (!row) throw new Error("Proposal store returned no row");
    return normalize(row);
  });
}

export function proposalBlocks(proposal: JobProposal): Record<string, unknown>[] {
  return [
    { type: "section", text: { type: "mrkdwn", text: proposal.message } },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: START_ACTION_ID,
          text: { type: "plain_text", text: "Start" },
          value: proposal.id,
          style: "primary",
        },
        {
          type: "button",
          action_id: DISMISS_ACTION_ID,
          text: { type: "plain_text", text: "Not now" },
          value: proposal.id,
        },
      ],
    },
  ];
}

// An exact typed yes is bound only when one current proposal exists here. Edits and ambiguous
// replies go to the brain; they cannot authorize a different payload.
export async function typedProposal(
  sql: Sql,
  channel: string,
  threadTs: string | null,
): Promise<JobProposal | "ambiguous" | undefined> {
  const rows = await sql<JobProposal[]>`
    select * from job_proposals where channel = ${channel} and thread_ts is not distinct from ${threadTs}
      and status = 'pending' and expires_at > now() order by id desc limit 2
  `;
  return rows.length > 1 ? "ambiguous" : rows[0] ? normalize(rows[0]) : undefined;
}

export async function proposalStatus(
  sql: Sql,
  jobId: number,
): Promise<JobProposal["status"] | undefined> {
  await sql`update job_proposals set status = 'expired' where job_id = ${jobId} and status = 'pending' and expires_at <= now()`;
  const [row] = await sql<
    { status: JobProposal["status"] }[]
  >`select status from job_proposals where job_id = ${jobId} and kind = 'start' order by id desc limit 1`;
  return row?.status;
}

export async function decideProposal(
  sql: Sql,
  id: string,
  actor: string,
  start: boolean,
): Promise<JobProposal | undefined> {
  const [row] = await sql<JobProposal[]>`
    select * from job_proposals where id = ${id}::bigint
  `;
  if (row?.status !== "pending") return undefined;
  await sql`select pg_advisory_xact_lock(hashtext(current_schema()), hashtext(${`${row.channel}:${row.threadTs ?? ""}`}))`;
  const [locked] = await sql<
    JobProposal[]
  >`select * from job_proposals where id = ${id}::bigint for update`;
  if (locked?.status !== "pending") return undefined;
  const proposal = normalize(locked);
  await sql`select id from jobs where id = ${proposal.jobId} for update`;
  const job = await getJob(sql, proposal.jobId);
  const valid =
    job &&
    !job.closedAt &&
    (proposal.kind === "start"
      ? job.status === "launching" && JSON.stringify(job.brief) === JSON.stringify(proposal.payload)
      : job.revision === proposal.revision && ["done", "failed"].includes(job.status));
  const [decided] = await sql<JobProposal[]>`
    update job_proposals set status = ${!valid ? "expired" : start ? "approved" : "dismissed"}, decided_by = ${actor}
    where id = ${id}::bigint and status = 'pending' and expires_at > now() returning *
  `;
  if (decided && proposal.kind === "start" && decided.status !== "approved") {
    await sql`update jobs set status = 'cancelled', finished_at = coalesce(finished_at, now()),
      last_summary = 'Not started', revision = revision + 1
      where id = ${proposal.jobId} and status = 'launching' and worker_thread_id is null`;
  }
  return decided ? normalize(decided) : undefined;
}

function normalize(row: JobProposal): JobProposal {
  return { ...row, id: String(row.id), jobId: Number(row.jobId) };
}
