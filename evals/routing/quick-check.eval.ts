import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import { writeToolStubs } from "../stubs.ts";

// Real brain model, stubbed tools (decision 063). A quick question about a pull request is a
// check, not a job: the brain answers it with its own tools and connections, or says it cannot
// reach the pull request and offers a job. It never starts the worker for it on its own. Like
// every eval, it expects an eval database with no approved connections, so no live server is
// reached (evals/stubs.ts).

const CLAIM = /\b(is|looks|it's)\s+(green|ready to merge|passing)\b/i;
const CANNOT = /\b(can't|cannot|can not|unable|no access|don't have|do not have|couldn't)\b/i;

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
    // No stub reaches the code host, so the brain cannot know the state of #42. A reply that
    // calls it green or ready must also say it could not check.
    t.check(
      turn.reply ?? "",
      satisfies(
        (message) =>
          String(message).trim() !== "" &&
          (!CLAIM.test(String(message)) || CANNOT.test(String(message))),
        "the reply does not invent the pull request's state",
      ),
    );
  },
});
