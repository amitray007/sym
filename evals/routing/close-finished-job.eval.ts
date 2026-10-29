import { defineEval } from "eve/evals";
import { afterFinishedJob } from "../conversation.ts";
import { writeToolStubs } from "../stubs.ts";

export default defineEval({
  description: "We're done closes the finished job; it is not a bare acknowledgement.",
  tags: ["routing"],
  async test(t) {
    const session = await t.session({ stubs: [...writeToolStubs] });
    await session.send(afterFinishedJob("we're done here, close J-12"));
    t.succeeded();
    t.calledTool("job_close", { input: { ref: /^J-12$/i }, count: 1 });
    t.notCalledTool("worker_job");
    t.notCalledTool("job_followup");
    t.notCalledTool("job_stop");
  },
});
