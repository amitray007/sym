import { z } from "zod";

// The brief the model writes for a worker job (docs/architecture.md, flow 1). It is the `t3_job`
// tool input and the `brief` column on the job row.
export const Brief = z.object({
  project: z.string().describe("Worker project ID or title, from the worker's project list."),
  title: z.string().min(3).max(80).describe("Short job title, for example 'Billing sync retry'."),
  goal: z.string().min(1).describe("What the worker should achieve."),
  constraints: z.array(z.string()).default([]).describe("Limits the worker must respect."),
  doneWhen: z.array(z.string()).min(1).describe("Checks that prove the job is done."),
  baseRef: z.string().default("main").describe("Branch the new worktree starts from."),
  openPullRequest: z.boolean().default(false).describe("Push the branch and open a draft PR."),
});

export type Brief = z.infer<typeof Brief>;

// The first message of the worker thread: the brief, the guardrails, the output contract, and
// the callback that ends Sym's wait early.
export function workerMessage(brief: Brief, ref: string, callbackUrl: string): string {
  const list = (items: string[]) => items.map((item) => `- ${item}`).join("\n");
  const delivery = brief.openPullRequest
    ? "Commit on this worktree's branch, push it, and open a draft pull request."
    : "Commit on this worktree's branch. Do not push and do not open a pull request.";

  return `You are working on Sym job ${ref}: ${brief.title}

Goal:
${brief.goal}

Constraints:
${list([
  ...brief.constraints,
  "Work only in this worktree.",
  "Keep production systems and customer data read-only.",
  delivery,
])}

Done when:
${list(brief.doneWhen)}

When you finish, end your last message with one JSON block in this shape:
\`\`\`json
{"summary": "", "pr_url": null, "tests": "", "files_changed": [], "open_questions": []}
\`\`\`

Then tell Sym you are done. Run this exactly once:
curl -fsS -X POST '${callbackUrl}' -H 'content-type: application/json' -d '{"job":"${ref}"}'
If the call fails, continue. Sym also checks the thread on a timer.`;
}
