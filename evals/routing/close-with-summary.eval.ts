import { defineEval } from "eve/evals";
import { afterFinishedJob } from "../conversation.ts";
import { writeToolStubs } from "../stubs.ts";

export default defineEval({
  description: "Close and share a summary in the main thread is one job_close call with a summary.",
  tags: ["routing"],
  async test(t) {
    const session = await t.session({ stubs: [...writeToolStubs] });
    await session.send(afterFinishedJob("close this and send a summary to the main thread"));
    t.succeeded();
    t.calledTool("job_close", { input: { ref: /^J-12$/i, summary: /\S/ }, count: 1 });
    t.notCalledTool("worker_job");
    t.notCalledTool("job_followup");
  },
});
