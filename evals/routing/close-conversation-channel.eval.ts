import { defineEval } from "eve/evals";
import { writeToolStubs } from "../stubs.ts";

export default defineEval({
  description: "Close this channel closes a conversation code channel without a job handle.",
  tags: ["routing", "code-channels"],
  async test(t) {
    const session = await t.session({ stubs: [...writeToolStubs] });
    await session.send("close this channel", {
      clientContext:
        "This is a Slack conversation code channel opened by code_channel. No Builder job owns it.",
    });
    t.succeeded();
    t.calledTool("job_close", { input: (value) => !("ref" in value), count: 1 });
    t.notCalledTool("worker_job");
    t.notCalledTool("job_stop");
  },
});
