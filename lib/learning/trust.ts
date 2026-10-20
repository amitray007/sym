import type { Sql } from "../db.ts";
import { chooseDisplay } from "../display.ts";
import { jobRef } from "../ledger/jobs.ts";
import { enqueuePost } from "../ledger/outbox.ts";
import type { Pack } from "../pack/load.ts";
import { playbookRef } from "./rows.ts";

// The trust ladder (docs/learning.md, decision 059). A job class is the approved playbook the
// brain says a brief follows. Each finished job of that playbook records whether it ended clean.
// After TRUST_RUNS clean runs in a row, Sym asks the owner to let the playbook's jobs start
// without the Start click. Only the owner promotes. Any unclean run, a 👎, or a Fix moves the
// playbook back to asking, and Sym says so. A new version of a playbook starts at asking again,
// because trust belongs to the approved row, not the name. This module stays free of Node.js
// builtins: the job steps reach it.

export type StartMode = "ask" | "auto";
const DEFAULT_TRUST_RUNS = 5;
const SCHEDULED_CHECK = "scheduled-check";

// How many clean runs in a row a playbook needs before Sym suggests trust. SYM_TRUST_RUNS can
// raise or lower it, but never below 2.
export function trustRuns(env: Record<string, string | undefined> = process.env): number {
  const value = Number(env.SYM_TRUST_RUNS);
  return Number.isInteger(value) && value >= 2 ? value : DEFAULT_TRUST_RUNS;
}

export interface TrustedPlaybook {
  id: number;
  name: string;
  version: number;
  startMode: StartMode;
}

// The approved playbook with this name, if any.
export async function approvedPlaybook(
  sql: Sql,
  name: string,
): Promise<TrustedPlaybook | undefined> {
  const [row] = await sql<TrustedPlaybook[]>`
    select id, name, version, start_mode from playbooks
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
): Promise<TrustedPlaybook | undefined> {
  if (!name) return undefined;
  const row = await approvedPlaybook(sql, name);
  if (!row) return undefined;
  await sql`update jobs set playbook_id = ${row.id} where id = ${jobId} and playbook_id is null`;
  return row;
}

// The trusted playbook that lets this job skip Start, or nothing. Trust covers only projects
// the playbook already ran clean on, so naming a trusted playbook for other work still asks.
export async function trustedPlaybookOf(
  sql: Sql,
  jobId: number,
): Promise<TrustedPlaybook | undefined> {
  const [row] = await sql<TrustedPlaybook[]>`
    select p.id, p.name, p.version, p.start_mode from jobs j
    join playbooks p on p.id = j.playbook_id
    where j.id = ${jobId} and p.status = 'approved' and p.start_mode = 'auto'
      and exists (
        select 1 from jobs c
        where c.playbook_id = p.id and c.outcome = 'clean' and c.id <> j.id
          and c.brief ->> 'project' = j.brief ->> 'project'
      )
  `;
  return row && { ...row, id: Number(row.id), version: Number(row.version) };
}

export async function markAutoStarted(sql: Sql, jobId: number): Promise<void> {
  await sql`update jobs set auto_started = true where id = ${jobId}`;
}

// Clean runs in a row, newest first, up to the first unclean one.
export async function cleanStreak(sql: Sql, playbookId: number): Promise<number[]> {
  const rows = await sql<{ id: number; outcome: string }[]>`
    select id, outcome from jobs
    where playbook_id = ${playbookId} and outcome is not null and finished_at is not null
    order by finished_at desc, id desc
    limit 50
  `;
  const streak: number[] = [];
  for (const row of rows) {
    if (row.outcome !== "clean") break;
    streak.push(Number(row.id));
  }
  return streak;
}

export interface JobEnd {
  id: number;
  kind: string;
  status: string;
}

// Records how a playbook's job ended, once. A clean end can lead to a trust suggestion; an
// unclean one moves a trusted playbook back to asking.
export async function recordOutcome(
  sql: Sql,
  job: JobEnd,
  clean: boolean,
  pack: Pack | undefined,
): Promise<void> {
  // A person's Stop says nothing about the playbook's quality, so a cancelled job counts neither
  // way.
  if (job.kind === SCHEDULED_CHECK || job.status === "cancelled") return;
  const [row] = await sql<{ playbookId: number }[]>`
    update jobs set outcome = ${clean ? "clean" : "unclean"}
    where id = ${job.id} and playbook_id is not null and outcome is null
    returning playbook_id
  `;
  const reason =
    job.status === "failed" ? `${jobRef(job.id)} failed` : `${jobRef(job.id)} ended with concerns`;
  if (!row) {
    // A 👎 or a Fix while the job ran already made it unclean. The end still demotes, in case the
    // owner trusted the playbook in between.
    const [marked] = await sql<{ playbookId: number }[]>`
      select playbook_id from jobs
      where id = ${job.id} and playbook_id is not null and outcome = 'unclean'
    `;
    if (marked) await demote(sql, Number(marked.playbookId), job.id, reason, pack);
    return;
  }
  const playbookId = Number(row.playbookId);
  if (!clean) {
    await demote(sql, playbookId, job.id, reason, pack);
    return;
  }
  await suggestTrust(sql, playbookId, pack);
}

// A 👎 or a Fix after the end makes the job unclean, even if it ended clean.
export async function markUnclean(
  sql: Sql,
  jobId: number,
  reason: string,
  pack: Pack | undefined,
): Promise<void> {
  const [row] = await sql<{ playbookId: number }[]>`
    update jobs set outcome = 'unclean'
    where id = ${jobId} and playbook_id is not null and kind <> ${SCHEDULED_CHECK}
      and outcome is distinct from 'unclean'
    returning playbook_id
  `;
  if (!row) return;
  await demote(sql, Number(row.playbookId), jobId, reason, pack);
}

export async function setStartMode(
  sql: Sql,
  playbookId: number,
  mode: StartMode,
  by: string,
): Promise<boolean> {
  const rows = await sql`
    update playbooks set start_mode = ${mode}, trust_changed_by = ${by}, trust_changed_at = now()
    where id = ${playbookId} and status = 'approved' and start_mode <> ${mode}
    returning id
  `;
  return rows.length > 0;
}

async function suggestTrust(sql: Sql, playbookId: number, pack: Pack | undefined): Promise<void> {
  const [playbook] = await sql<{ name: string; startMode: StartMode; status: string }[]>`
    select name, start_mode, status from playbooks where id = ${playbookId}
  `;
  if (playbook?.status !== "approved" || playbook.startMode !== "ask") return;
  const streak = await cleanStreak(sql, playbookId);
  const needed = trustRuns();
  if (streak.length < needed) return;
  const runs = streak.slice(0, needed).reverse().map(jobRef).join(", ");
  await notifyOwner(
    sql,
    pack,
    // One suggestion per clean streak: the streak's first job keys it, so a longer streak asks
    // once and a new streak after an unclean run asks again.
    `trust:${playbookRef(playbookId)}:${jobRef(streak.at(-1) ?? 0)}`,
    [
      `${playbookRef(playbookId)} ${playbook.name}: the last ${needed} jobs that followed it ended clean (${runs}).`,
      "Ask me to trust it, and its jobs start without the Start click. A 👎, a Fix, or a run with concerns puts it back to asking.",
    ].join("\n"),
  );
}

async function demote(
  sql: Sql,
  playbookId: number,
  jobId: number,
  reason: string,
  pack: Pack | undefined,
): Promise<void> {
  const [row] = await sql<{ name: string }[]>`
    update playbooks set start_mode = 'ask', trust_changed_by = 'sym', trust_changed_at = now()
    where id = ${playbookId} and start_mode = 'auto'
    returning name
  `;
  if (!row) return;
  await notifyOwner(
    sql,
    pack,
    `trust-off:${playbookRef(playbookId)}:${jobRef(jobId)}`,
    `${playbookRef(playbookId)} ${row.name} asks for Start again: ${reason}.`,
  );
}

// Trust is the owner's decision, so notices go to the owner's DM, else the digest channel.
async function notifyOwner(
  sql: Sql,
  pack: Pack | undefined,
  key: string,
  text: string,
): Promise<void> {
  const owner = pack?.config.owner.slackUserId || process.env.SYM_OWNER_SLACK_USER?.trim();
  const target = owner || pack?.config.channels?.digest || process.env.SYM_DIGEST_CHANNEL?.trim();
  if (!target) return;
  const dm = /^[DUW]/.test(target);
  const display = chooseDisplay({
    kind: "learn",
    needsAction: true,
    isNew: true,
    estMinutes: 0,
    steps: 0,
    lines: text.split("\n").length,
    surface: dm ? "dm" : "channel",
    quiet: false,
  });
  await enqueuePost(sql, {
    idempotencyKey: key,
    method: "chat.postMessage",
    payload: { channel: target, text },
    display: dm ? { ...display, target: "dm" } : display,
  });
}
