import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import { writeToolStubs } from "../stubs.ts";

// Real brain model, stubbed tools (decision 039). The prompt names the project, so the brain
// does not stop to ask which one.

const DONE_CLAIM =
  /\b(is|are|was|has been|have been|now)\s+(done|complete|completed|finished|merged|fixed|deployed)\b/i;

export default defineEval({
  description:
    "A code-change request calls worker_job with a complete brief and claims nothing done.",
  tags: ["routing"],
  async test(t) {
    const session = await t.session({ stubs: [...writeToolStubs] });
    const turn = await session.send(
      "In project example-app, add a retry with backoff to the invoice sync client. " +
        "Done when the unit tests for the client pass and the retry count is configurable. " +
        "Use the default branch and do not open a pull request.",
    );
    t.succeeded();
    t.calledTool("worker_job", {
      input: {
        project: /example-app/i,
        title: (value: unknown) => typeof value === "string" && value.length >= 3,
        goal: (value: unknown) => typeof value === "string" && value.trim().length > 0,
        doneWhen: (value: unknown) => Array.isArray(value) && value.length > 0,
        constraints: (value: unknown) => Array.isArray(value),
      },
      count: 1,
    });
    t.notCalledTool("schedule_create");
    t.check(
      turn.reply ?? "",
      satisfies(
        (message) => typeof message === "string" && !DONE_CLAIM.test(message),
        "the reply does not claim the job is done",
      ),
    );
  },
});
