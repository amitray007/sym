import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import { writeToolStubs } from "../stubs.ts";

// Real brain model, stubbed tools (decision 063). A quick question about a pull request is a
// check, not a job: the brain answers it with its own tools and connections, or says it cannot
// reach the pull request and offers a job. It never starts the worker for it on its own.

export default defineEval({
  description: "A quick check on a pull request does not start a worker job.",
  tags: ["routing"],
  async test(t) {
    const session = await t.session({ stubs: [...writeToolStubs] });
    const turn = await session.send(
      "In project example-app, is the release pull request #42 green and ready to merge?",
    );
    t.succeeded();
    t.notCalledTool("worker_job");
    t.check(
      turn.message ?? "",
      satisfies((message) => String(message).trim() !== "", "the brain answers in the thread"),
    );
  },
});
