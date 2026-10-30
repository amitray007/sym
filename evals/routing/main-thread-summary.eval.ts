import { defineEval } from "eve/evals";
import { afterFinishedJob } from "../conversation.ts";
import { writeToolStubs } from "../stubs.ts";

// Decision 079: a code channel can post in its main thread whenever a person asks.
export default defineEval({
  description: "Summarize in the main thread posts there and closes nothing.",
  tags: ["routing"],
  async test(t) {
    const session = await t.session({ stubs: [...writeToolStubs] });
    await session.send(afterFinishedJob("summarize this in the main thread"));
    t.succeeded();
    t.calledTool("main_thread_post", { input: { text: /\S/ }, count: 1 });
    t.notCalledTool("job_close");
    t.notCalledTool("worker_job");
  },
});
