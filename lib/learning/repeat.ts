import type { Sql } from "../db.ts";
import { chooseDisplay } from "../display.ts";
import { jobRef } from "../ledger/jobs.ts";
import { enqueuePost } from "../ledger/outbox.ts";
import { alreadyHandled } from "./learn.ts";
import { type Playbook, playbookRef, propose } from "./rows.ts";

// Repeated work (decision 058). The brain reads the briefs of recent finished jobs, finds work
// people ask for again and again, and drafts a playbook for each pattern. Code decides when the
// brain looks and checks every proposal against the ledger; the brain decides what repeats. The
// owner approves a proposal before it loads (learning layer 2).

// A pattern needs this many finished jobs before it becomes a proposal.
export const REPEAT_MIN = 3;
// The brain reads briefs from this far back, newest first, at most REPEAT_LIMIT of them.
const WINDOW_MS = 60 * 24 * 60 * 60 * 1000;
const REPEAT_LIMIT = 40;
const GOAL_CHARS = 300;
const SCAN_KEY = "repeat_scan_at";
const SCHEDULED_CHECK = "scheduled-check";

export interface FinishedBrief {
  id: number;
  project: string;
  title: string;
  goal: string;
  doneWhen: string[];
}

// Briefs only: people and the brain wrote them, and the owner's Start approved them. Worker
// output stays out, because it can carry injected text. Scheduled checks already repeat by
// design, so they stay out too.
export async function recentBriefs(sql: Sql, now: Date): Promise<FinishedBrief[]> {
  const since = new Date(now.getTime() - WINDOW_MS);
  const rows = await sql<{ id: number; title: string; brief: Record<string, unknown> | null }[]>`
    select id, title, brief from jobs
    where status = 'done' and kind <> ${SCHEDULED_CHECK} and finished_at >= ${since}
    order by id desc limit ${REPEAT_LIMIT}
  `;
  return rows.map((row) => {
    const brief = row.brief ?? {};
    const text = (value: unknown) => (typeof value === "string" ? value : "");
    return {
      id: Number(row.id),
      project: text(brief.project),
      title: row.title,
      goal: text(brief.goal).slice(0, GOAL_CHARS),
      doneWhen: Array.isArray(brief.doneWhen)
        ? brief.doneWhen.filter((v) => typeof v === "string")
        : [],
    };
  });
}

// The text the brain reads: one block per job, then the playbook names that already exist, so
// it does not propose work a playbook covers.
export function briefsText(briefs: FinishedBrief[], playbooks: Playbook[]): string {
  if (briefs.length === 0) return "No finished jobs in the last 60 days.";
  const jobs = briefs.map((brief) =>
    [
      `${jobRef(brief.id)} [${brief.project}] ${brief.title}`,
      `  goal: ${brief.goal}`,
      ...brief.doneWhen.slice(0, 5).map((check) => `  done when: ${check}`),
    ].join("\n"),
  );
  const names = playbooks.map((row) => `${row.name} (${row.status})`);
  return [
    `Finished jobs, newest first (${briefs.length}):`,
    ...jobs,
    names.length > 0 ? `Existing playbooks: ${names.join(", ")}` : "Existing playbooks: none",
  ].join("\n");
}

// True when enough jobs finished since the last look to make another look worth a model call.
export async function repeatScanDue(sql: Sql, now: Date): Promise<boolean> {
  const [setting] = await sql<{ value: string }[]>`
    select value from settings where key = ${SCAN_KEY}
  `;
  const last = setting ? new Date(setting.value) : new Date(0);
  const since = Number.isNaN(last.getTime()) ? new Date(0) : last;
  const [row] = await sql<{ n: string }[]>`
    select count(*) as n from jobs
    where status = 'done' and kind <> ${SCHEDULED_CHECK} and finished_at > ${since}
      and finished_at <= ${now}
  `;
  return Number(row?.n ?? 0) >= REPEAT_MIN;
}

export async function markRepeatScan(sql: Sql, now: Date): Promise<void> {
  await sql`
    insert into settings (key, value) values (${SCAN_KEY}, ${now.toISOString()})
    on conflict (key) do update set value = excluded.value, updated_at = now()
  `;
}

export interface RepeatProposal {
  name: string;
  body: string;
  jobIds: number[];
}

// Saves one proposal after checking its evidence: at least REPEAT_MIN distinct finished jobs
// that the brain could have read, and a name with no live proposal, approval, or recent
// rejection. Returns the row, or the reason it was refused.
export async function proposeRepeated(
  sql: Sql,
  input: RepeatProposal,
  now: Date,
): Promise<Playbook | string> {
  const ids = [...new Set(input.jobIds)];
  if (ids.length < REPEAT_MIN) {
    return `A repeated-work playbook needs at least ${REPEAT_MIN} different jobs as evidence.`;
  }
  const readable = new Set((await recentBriefs(sql, now)).map((brief) => brief.id));
  const unknown = ids.filter((id) => !readable.has(id));
  if (unknown.length > 0) {
    return `These are not recent finished jobs: ${unknown.map(jobRef).join(", ")}.`;
  }
  if (await alreadyHandled(sql, input.name, now)) {
    return `"${input.name}" already has a proposal, an approval, or a recent rejection.`;
  }
  return propose(sql, {
    name: input.name,
    kind: "playbook",
    body: input.body,
    source: "repeat",
    evidence: ids,
  });
}

// One message for all of a review's proposals, to the digest channel or the owner's DM, so a
// review is one ping however many patterns it finds.
export async function queueRepeatNotice(sql: Sql, target: string, rows: Playbook[]): Promise<void> {
  if (rows.length === 0) return;
  const text = [
    `Sym noticed repeated work and drafted ${rows.length === 1 ? "a playbook" : `${rows.length} playbooks`}.`,
    ...rows.map(
      (row) =>
        `${playbookRef(row.id)} ${row.name} (from ${row.evidence.map(jobRef).join(", ")}):\n${row.body}`,
    ),
    "Ask me to review each one to approve it. Nothing loads until you do.",
  ].join("\n");
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
    idempotencyKey: `repeat:${rows.map((row) => playbookRef(row.id)).join(",")}`,
    method: "chat.postMessage",
    payload: { channel: target, text },
    display: dm ? { ...display, target: "dm" } : display,
  });
}
