import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import { afterFinishedJob, isQuickReply } from "../conversation.ts";
import { writeToolStubs } from "../stubs.ts";

export default defineEval({
  description: "Discussing a finished job's concern is chat and does not propose work.",
  tags: ["routing", "consent", "voice"],
  async test(t) {
    const session = await t.session({ stubs: [...writeToolStubs] });
    const turn = await session.send(afterFinishedJob("Why can the retry wait add 6 minutes?"));
    t.succeeded();
    t.notCalledTool("worker_job");
    t.notCalledTool("job_followup");
    t.notCalledTool("job_steer");
    t.notCalledTool("job_close");
    t.notCalledTool("no_reply");
    t.check(turn.reply, satisfies(isQuickReply, "answer the new question without report headings"));
  },
});
