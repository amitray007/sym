import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import { writeToolStubs } from "../stubs.ts";

// The shared worker_job stub returns what the real tool returns once Sym has posted the result
// (decisions 044, 064). The brain must stay silent and must not retell the summary.

export default defineEval({
  description:
    "After a worker_job result with posted: true, the brain calls no_reply and writes nothing.",
  tags: ["voice", "routing"],
  async test(t) {
    const session = await t.session({ stubs: [...writeToolStubs] });
    const turn = await session.send(
      "In project example-app, add a retry with backoff to the invoice sync client. " +
        "Done when the unit tests for the client pass. Use the default branch and do not open a pull request.",
    );
    t.succeeded();
    t.calledTool("worker_job", { count: 1 });
    t.calledTool("no_reply", { count: 1 });
    t.toolOrder(["worker_job", "no_reply"]);
    t.check(
      turn.reply ?? "",
      satisfies((message) => String(message).trim().length === 0, "the reply has no visible text"),
    );
  },
});
