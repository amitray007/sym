import { defineEval } from "eve/evals";
import { includes, satisfies } from "eve/evals/expect";
import { afterFinishedJob } from "../conversation.ts";
import { writeToolStubs } from "../stubs.ts";

export default defineEval({
  description: "A result question asking for parallel facts can use a list, with warnings intact.",
  tags: ["voice"],
  async test(t) {
    const session = await t.session({ stubs: [...writeToolStubs] });
    const turn = await session.send(
      afterFinishedJob(
        "List the PR link, test result, production boundary, and remaining concern as four bullets.",
      ),
    );
    t.succeeded();
    t.notCalledTool("worker_job");
    t.notCalledTool("job_followup");
    t.check(turn.reply, includes("https://example.com/example-app/pull/42"));
    t.check(turn.reply, includes(/pass/i));
    t.check(turn.reply, includes(/6|six/i));
    t.check(turn.reply, includes(/production/i));
    t.check(
      turn.reply,
      satisfies(
        (value) => (String(value).match(/^\s*[-*•]\s+/gm) ?? []).length === 4,
        "use bullets when the requested facts have that shape",
      ),
    );
  },
});
