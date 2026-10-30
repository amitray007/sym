import { defineEval } from "eve/evals";
import { afterFinishedJob } from "../conversation.ts";
import { writeToolStubs } from "../stubs.ts";

// Decision 079: both parts of the request happen, the post before the close.
export default defineEval({
  description: "Close and send a summary to the main thread posts there, then closes.",
  tags: ["routing"],
  async test(t) {
    const session = await t.session({ stubs: [...writeToolStubs] });
    await session.send(afterFinishedJob("close this and send a summary to the main thread"));
    t.succeeded();
    t.calledTool("main_thread_post", { input: { text: /\S/ }, count: 1 });
    t.calledTool("job_close", { input: { ref: /^J-12$/i }, count: 1 });
    t.notCalledTool("worker_job");
  },
});
