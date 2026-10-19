import type { OutputContract } from "../jobs/contract.ts";
import type { RunOutcome } from "./rows.ts";

// The digest outcome of a scheduled run, from the job's end state. Deterministic: a done job
// whose output contract lists no open questions and breaks no rule is all clear. A failed job is
// failed. Anything else, including a done job without a readable contract, needs attention. This
// matches when the result message posts (lib/jobs/present.ts), so the digest and Slack agree.
export function runOutcome(
  status: string,
  contract: Pick<OutputContract, "openQuestions"> | null,
  concerns: string[] = [],
): Exclude<RunOutcome, "started"> {
  if (status === "failed") return "failed";
  if (
    status === "done" &&
    contract &&
    contract.openQuestions.length === 0 &&
    concerns.length === 0
  ) {
    return "all_clear";
  }
  return "needs_attention";
}
