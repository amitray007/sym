import { z } from "zod";

// The brief the model writes for a worker job (docs/architecture.md, flow 1). It is the `t3_job`
// tool input and the `brief` column on the job row.
export const Brief = z.object({
  project: z.string().describe("Worker project ID or title, from the worker's project list."),
  title: z.string().min(3).max(80).describe("Short job title, for example 'Billing sync retry'."),
  goal: z.string().min(1).describe("What the worker should achieve."),
  constraints: z.array(z.string()).default([]).describe("Limits the worker must respect."),
  doneWhen: z.array(z.string()).min(1).describe("Checks that prove the job is done."),
  baseRef: z
    .string()
    .optional()
    .describe("Branch the new worktree starts from. Defaults to the project's base branch."),
  model: z
    .string()
    .optional()
    .describe("One model ID from the worker model list. Leave out to use the default."),
  modelReason: z
    .string()
    .max(160)
    .optional()
    .describe("Why this model, in a short phrase. Needed when the model is not the default."),
  openPullRequest: z.boolean().default(false).describe("Push the branch and open a draft PR."),
  estimatedMinutes: z
    .number()
    .int()
    .min(1)
    .max(24 * 60)
    .default(15)
    .describe("Expected minutes of worker time. Long jobs get a live card in Slack."),
});

export type Brief = z.infer<typeof Brief>;

// The first message of the worker thread: the brief, the guardrails, the output contract, and
// the callback that ends Sym's wait early. A pack's guardrails replace the generic data and
// delivery lines, because they state the project's own rules (decision 026).
export function workerMessage(
  brief: Brief,
  ref: string,
  callbackUrl: string,
  guardrails?: string[],
): string {
  const list = (items: string[]) => items.map((item) => `- ${item}`).join("\n");
  const delivery = brief.openPullRequest
    ? "Commit on this worktree's branch, push it, and open a draft pull request."
    : "Commit on this worktree's branch. Do not push and do not open a pull request.";
  const rules = guardrails ?? ["Keep production systems and customer data read-only.", delivery];

  return `You are working on Sym job ${ref}: ${brief.title}

Goal:
${brief.goal}

Constraints:
${list([...brief.constraints, "Work only in this worktree.", ...rules])}

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
