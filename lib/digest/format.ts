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
  const section = (label: string, list: typeof jobs) => {
    if (list.length === 0) return;
    lines.push(`${label} (${list.length}):`);
    for (const job of list) lines.push(`- ${jobRef(job.id)} ${job.title}`);
  };
  section("Finished", done);
  section("Failed", failed);
  section("Waiting for you", waiting);
  if (running.length > 0) lines.push(`Still running: ${running.length}`);

  for (const [title, outcomes] of groupRuns(input.runs)) {
    lines.push(`${title}: ${describeOutcomes(outcomes)}`);
  }

  if (lines.length === 0) return undefined;
  return [`Daily digest for ${input.day}`, ...lines].join("\n");
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
