import { defineEval } from "eve/evals";
import { includes, satisfies } from "eve/evals/expect";
import { afterFinishedJob, isQuickReply } from "../conversation.ts";
import { writeToolStubs } from "../stubs.ts";

export default defineEval({
  description: "A simple result question gets its answer without a full result recap or structure.",
  tags: ["voice"],
  async test(t) {
    const session = await t.session({ stubs: [...writeToolStubs] });
    const turn = await session.send(afterFinishedJob("Did the tests run and pass?"));
    t.succeeded();
    t.notCalledTool("worker_job");
    t.notCalledTool("job_followup");
    t.notCalledTool("no_reply");
    t.check(
      turn.reply,
      satisfies(isQuickReply, "answer the test question without report sections"),
    );
    t.check(turn.reply, includes(/pass/i));
    t.check(turn.reply, includes(/4|four/i));
  },
});
