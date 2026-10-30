import type { Sql } from "../db.ts";
import type { Pack } from "../pack/load.ts";

// Historical trust columns stay in the ledger. Outcomes still inform reviewed learning,
// but no playbook can skip the Start click (decision 071).
const SCHEDULED_CHECK = "scheduled-check";

export interface ApprovedPlaybook {
  id: number;
  name: string;
  version: number;
}

// The approved playbook with this name, if any.
export async function approvedPlaybook(
  sql: Sql,
  name: string,
): Promise<ApprovedPlaybook | undefined> {
  const [row] = await sql<ApprovedPlaybook[]>`
    select id, name, version from playbooks
    where name = ${name} and status = 'approved' and kind = 'playbook'
  `;
  return row && { ...row, id: Number(row.id), version: Number(row.version) };
}

// Ties a job to the approved playbook its brief names. A name with no approved playbook ties
// nothing: the brain's label never creates trust on its own.
export async function linkPlaybook(
  sql: Sql,
  jobId: number,
  name: string | undefined,
): Promise<ApprovedPlaybook | undefined> {
  if (!name) return undefined;
  const row = await approvedPlaybook(sql, name);
  if (!row) return undefined;
  await sql`update jobs set playbook_id = ${row.id} where id = ${jobId} and playbook_id is null`;
  return row;
}

export interface JobEnd {
  id: number;
  kind: string;
  status: string;
}

// Record once. A person's Stop says nothing about playbook quality.
export async function recordOutcome(
  sql: Sql,
  job: JobEnd,
  clean: boolean,
  _pack: Pack | undefined,
): Promise<void> {
  if (job.kind === SCHEDULED_CHECK || job.status === "cancelled") return;
  await sql`update jobs set outcome = ${clean ? "clean" : "unclean"}
    where id = ${job.id} and playbook_id is not null and outcome is null`;
}

// Negative feedback and follow-ups still mark the linked outcome unclean.
export async function markUnclean(
  sql: Sql,
  jobId: number,
  _reason: string,
  _pack: Pack | undefined,
): Promise<void> {
  await sql`update jobs set outcome = 'unclean'
    where id = ${jobId} and playbook_id is not null and kind <> ${SCHEDULED_CHECK}
      and outcome is distinct from 'unclean'`;
}
