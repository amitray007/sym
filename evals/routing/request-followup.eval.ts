import { defineEval } from "eve/evals";
import { afterFinishedJob } from "../conversation.ts";
import { writeToolStubs } from "../stubs.ts";

export default defineEval({
  description: "A requested change after a result proposes a follow-up on that job.",
  tags: ["routing", "consent"],
  async test(t) {
    const session = await t.session({ stubs: [...writeToolStubs] });
    await session.send(afterFinishedJob("ok change it to 30s"));
    t.succeeded();
    t.calledTool("job_followup", {
      input: { ref: /^J-12$/i, change: /30\s*(s|sec|seconds)/i },
      count: 1,
    });
    t.notCalledTool("worker_job");
    t.notCalledTool("job_steer");
    t.notCalledTool("job_close");
  },
});
