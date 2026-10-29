import type { Job } from "../ledger/jobs.ts";
import { jobRef } from "../ledger/jobs.ts";
import type { RunOutcome } from "../schedules/rows.ts";

// The daily digest text (docs/architecture.md, "Proactive updates"). The digest carries what the
// noise budget kept out of the threads. Pure code: the caller loads the rows.

export interface DigestRun {
  title: string;
  outcome: RunOutcome;
}

export interface DigestInput {
  day: string;
  jobs: Pick<Job, "id" | "title" | "status">[];
  runs: DigestRun[];
}

const WAITING = new Set(["waiting_input", "waiting_permission"]);
const OUTCOME_LABEL: Record<RunOutcome, string> = {
  all_clear: "all clear",
  needs_attention: "needs attention",
  failed: "failed",
  started: "ran, no result yet",
};

// Returns undefined when there is nothing to report, so Sym posts no empty digest.
export function digestMessage(input: DigestInput): string | undefined {
  const jobs = input.jobs;
  const done = jobs.filter((job) => job.status === "done");
  const failed = jobs.filter((job) => job.status === "failed");
  const waiting = jobs.filter((job) => WAITING.has(job.status));
  const running = jobs.filter(
    (job) => !["done", "failed", "cancelled"].includes(job.status) && !WAITING.has(job.status),
  );

  const lines: string[] = [];
  const describe = (list: typeof jobs) =>
    list.map((job) => `${jobRef(job.id)} ${job.title}`).join(", ");
  if (waiting.length)
    lines.push(`${describe(waiting)} ${waiting.length === 1 ? "needs" : "need"} you.`);
  if (failed.length) lines.push(`${describe(failed)} failed.`);
  if (done.length) lines.push(`${describe(done)} finished.`);
  if (running.length)
    lines.push(`${describe(running)} ${running.length === 1 ? "is" : "are"} still running.`);
  for (const [title, outcomes] of groupRuns(input.runs))
    lines.push(`${title}: ${describeOutcomes(outcomes)}.`);
  if (!lines.length) return undefined;
  return [...lines, "Ask me for the details."].join("\n");
}

function groupRuns(runs: DigestRun[]): Map<string, RunOutcome[]> {
  const groups = new Map<string, RunOutcome[]>();
  for (const run of runs) groups.set(run.title, [...(groups.get(run.title) ?? []), run.outcome]);
  return groups;
}

function describeOutcomes(outcomes: RunOutcome[]): string {
  const counts = new Map<RunOutcome, number>();
  for (const outcome of outcomes) counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
  if (counts.size === 1) return OUTCOME_LABEL[outcomes[0] ?? "started"];
  return [...counts].map(([outcome, count]) => `${count} ${OUTCOME_LABEL[outcome]}`).join(", ");
}
