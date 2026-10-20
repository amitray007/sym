import { createHash } from "node:crypto";
import type { Sql } from "../db.ts";
import { chooseDisplay } from "../display.ts";
import { enqueuePost } from "../ledger/outbox.ts";
import { type Playbook, playbookRef, propose } from "./rows.ts";

// The weekly learn pass (docs/learning.md, step 4). It groups feedback with fixed rules and no
// model call. A pattern seen PATTERN_MIN times becomes one proposed row. The text comes from
// Sym's own templates and counts, never from the feedback text, because feedback can carry
// injected text.

export const PATTERN_MIN = 3;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
// A rejected pattern waits this long before Sym proposes it again.
const REJECT_QUIET_MS = 28 * 24 * 60 * 60 * 1000;

export interface Pattern {
  name: string;
  body: string;
  evidence: number[];
}

interface Row {
  id: number;
  kind: string;
  value: string;
  jobKind: string | null;
}

const safeKind = (kind: string) =>
  kind
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

// "Fix: use tabs" and "fix:  Use tabs" are the same fix.
const normalizeFix = (value: string) =>
  value
    .trim()
    .replace(/^fix\s*:\s*/i, "")
    .replace(/\s+/g, " ")
    .toLowerCase();

export function groupFeedback(rows: Row[], min = PATTERN_MIN): Pattern[] {
  const patterns: Pattern[] = [];

  const down = new Map<string, number[]>();
  for (const row of rows) {
    if (row.kind !== "thumbs_down" || !row.jobKind) continue;
    const kind = safeKind(row.jobKind);
    if (kind) down.set(kind, [...(down.get(kind) ?? []), row.id]);
  }
  for (const [kind, ids] of [...down].sort(([a], [b]) => a.localeCompare(b))) {
    if (ids.length < min) continue;
    patterns.push({
      name: `learn-thumbs-down-${kind}`,
      body:
        `People rated ${ids.length} "${kind}" jobs as not helpful in one week. Before you start a ` +
        `"${kind}" job, restate the goal and each done-when check in the brief, and ask the ` +
        "owner about any check that is unclear.",
      evidence: ids,
    });
  }

  const fixes = new Map<string, number[]>();
  for (const row of rows) {
    if (row.kind !== "fix") continue;
    const text = normalizeFix(row.value);
    if (text) fixes.set(text, [...(fixes.get(text) ?? []), row.id]);
  }
  for (const [text, ids] of [...fixes].sort(([a], [b]) => a.localeCompare(b))) {
    if (ids.length < min) continue;
    const hash = createHash("sha256").update(text).digest("hex").slice(0, 8);
    patterns.push({
      name: `learn-repeated-fix-${hash}`,
      body:
        `People sent the same fix ${ids.length} times in one week. Before you start the next ` +
        "job, ask the owner what standing rule would prevent it, then propose that rule with " +
        "playbook_propose.",
      evidence: ids,
    });
  }
  return patterns;
}

// Feedback from the week before `now`, joined to the kind of its job. No upper bound: the
// database clock can run ahead of this process's clock, and feedback is never in the future.
export async function recentFeedback(sql: Sql, now: Date): Promise<Row[]> {
  const since = new Date(now.getTime() - WEEK_MS);
  const rows = await sql<Row[]>`
    select f.id, f.kind, f.value, j.kind as job_kind
    from feedback f left join jobs j on j.id = f.job_id
    where f.created_at >= ${since}
    order by f.id
  `;
  return rows.map((row) => ({ ...row, id: Number(row.id) }));
}

// True when the name has a live proposal or approval, or a recent rejection.
export async function alreadyHandled(sql: Sql, name: string, now: Date): Promise<boolean> {
  const since = new Date(now.getTime() - REJECT_QUIET_MS);
  const [row] = await sql<{ n: string }[]>`
    select count(*) as n from playbooks
    where name = ${name} and (
      status in ('proposed', 'approved') or (status = 'rejected' and decided_at >= ${since})
    )
  `;
  return Number(row?.n ?? 0) > 0;
}

// Proposes one row per new pattern and queues one message that asks the owner to review them.
// `channel` is a channel ID or the owner's user ID for a DM. Returns the new rows.
export async function runLearn(sql: Sql, channel: string, now: Date): Promise<Playbook[]> {
  const created: Playbook[] = [];
  for (const pattern of groupFeedback(await recentFeedback(sql, now))) {
    if (await alreadyHandled(sql, pattern.name, now)) continue;
    created.push(
      await propose(sql, {
        name: pattern.name,
        kind: "rule",
        body: pattern.body,
        source: "learn",
        evidence: pattern.evidence,
      }),
    );
  }
  if (created.length === 0) return created;

  const text = [
    `Sym found ${created.length} pattern${created.length === 1 ? "" : "s"} in last week's feedback.`,
    ...created.map((row) => `${playbookRef(row.id)} ${row.name}: ${row.body}`),
    "Ask me to review each one with playbook_review to approve it. Nothing loads until you do.",
  ].join("\n");
  const dm = /^[DUW]/.test(channel);
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
    idempotencyKey: `learn:${now.toISOString().slice(0, 10)}`,
    method: "chat.postMessage",
    payload: { channel, text },
    display: dm ? { ...display, target: "dm" } : display,
  });
  return created;
}
