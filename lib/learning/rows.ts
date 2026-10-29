import type { Sql } from "../db.ts";
import { json } from "../ledger/jobs.ts";

// Layer 2 rows (docs/learning.md, decision 007). A row loads into a session only after the owner
// approves it. Approving a new version retires the old approved version of the same name.

export type PlaybookKind = "playbook" | "rule";
export type PlaybookStatus = "proposed" | "approved" | "rejected" | "retired";
export type PlaybookSource = "owner" | "learn" | "repeat";

export interface Playbook {
  id: number;
  name: string;
  kind: PlaybookKind;
  body: string;
  status: PlaybookStatus;
  version: number;
  source: PlaybookSource;
  evidence: number[];
  proposedAt: Date;
  decidedBy: string | null;
  decidedAt: Date | null;
  // Historical trust data (decision 059); decision 071 retired auto-start.
  startMode: "ask" | "auto";
}

export interface NewPlaybook {
  name: string;
  kind: PlaybookKind;
  body: string;
  source: PlaybookSource;
  evidence?: number[];
}

export const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const MAX_BODY_CHARS = 2000;
// All approved text together stays under this size, so a runaway row cannot flood the prompt.
export const MAX_SESSION_CHARS = 8000;

const normalize = (row: Playbook): Playbook => ({
  ...row,
  id: Number(row.id),
  version: Number(row.version),
});

export function playbookRef(id: number): string {
  return `P-${id}`;
}

// Adds a proposed row. It takes the next version number of its name.
export async function propose(sql: Sql, input: NewPlaybook): Promise<Playbook> {
  if (!NAME_PATTERN.test(input.name)) {
    throw new Error("A name uses lowercase letters, digits, and hyphens, up to 64 characters.");
  }
  const body = input.body.trim();
  if (body.length === 0 || body.length > MAX_BODY_CHARS) {
    throw new Error(`A body holds 1 to ${MAX_BODY_CHARS} characters.`);
  }
  const [row] = await sql<Playbook[]>`
    insert into playbooks (name, kind, body, version, source, evidence)
    values (
      ${input.name}, ${input.kind}, ${body},
      (select coalesce(max(version), 0) + 1 from playbooks where name = ${input.name}),
      ${input.source}, ${json(sql, input.evidence ?? [])}
    )
    returning *
  `;
  if (!row) throw new Error("insert into playbooks returned no row");
  return normalize(row);
}

export async function getPlaybook(sql: Sql, id: number): Promise<Playbook | undefined> {
  const [row] = await sql<Playbook[]>`select * from playbooks where id = ${id}`;
  return row && normalize(row);
}

// Newest first. `status` filters; without it every version shows.
export async function listPlaybooks(
  sql: Sql,
  status?: PlaybookStatus,
  limit = 100,
): Promise<Playbook[]> {
  const rows = await sql<Playbook[]>`
    select * from playbooks
    where ${status === undefined ? sql`true` : sql`status = ${status}`}
    order by id desc limit ${limit}
  `;
  return rows.map(normalize);
}

// Approves a proposed row and retires the approved version of the same name. Returns undefined
// when the row is not proposed.
export async function approvePlaybook(
  sql: Sql,
  id: number,
  by: string,
  now: Date,
): Promise<Playbook | undefined> {
  return sql.begin(async (tx) => {
    const [target] = await tx<{ name: string }[]>`
      select name from playbooks where id = ${id} and status = 'proposed' for update
    `;
    if (!target) return undefined;
    await tx`
      update playbooks set status = 'retired', decided_by = ${by}, decided_at = ${now}
      where name = ${target.name} and status = 'approved'
    `;
    const [row] = await tx<Playbook[]>`
      update playbooks set status = 'approved', decided_by = ${by}, decided_at = ${now}
      where id = ${id} returning *
    `;
    return row && normalize(row);
  });
}

export async function rejectPlaybook(
  sql: Sql,
  id: number,
  by: string,
  now: Date,
): Promise<Playbook | undefined> {
  const [row] = await sql<Playbook[]>`
    update playbooks set status = 'rejected', decided_by = ${by}, decided_at = ${now}
    where id = ${id} and status = 'proposed' returning *
  `;
  return row && normalize(row);
}

export async function retirePlaybook(
  sql: Sql,
  id: number,
  by: string,
  now: Date,
): Promise<Playbook | undefined> {
  const [row] = await sql<Playbook[]>`
    update playbooks set status = 'retired', decided_by = ${by}, decided_at = ${now}
    where id = ${id} and status = 'approved' returning *
  `;
  return row && normalize(row);
}

// The rows a new session loads: approved only, rules first, oldest decision first. Rows stop
// once the next one would pass `maxChars`. This is a pure read, so a resolver can re-run.
export async function approvedForSession(
  sql: Sql,
  maxChars = MAX_SESSION_CHARS,
): Promise<Playbook[]> {
  const rows = await sql<Playbook[]>`
    select * from playbooks where status = 'approved'
    order by (kind = 'rule') desc, decided_at, id
  `;
  const kept: Playbook[] = [];
  let used = 0;
  for (const row of rows.map(normalize)) {
    if (used + row.body.length > maxChars) continue;
    used += row.body.length;
    kept.push(row);
  }
  return kept;
}
