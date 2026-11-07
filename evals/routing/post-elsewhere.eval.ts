import { defineEval } from "eve/evals";
import { approvePending } from "../conversation.ts";
import { writeToolStubs } from "../stubs.ts";

// Decisions 081 and 082: "post this in #channel" posts there in Sym's voice, without a
// mention of the person unless they asked for one.
export default defineEval({
  description: "A request to post in another channel calls slack_post once, without a mention.",
  tags: ["routing"],
  async test(t) {
    const session = await t.session({ stubs: [...writeToolStubs] });
    await session.send("post in #releases that v2.4 is out, with faster sync and the retry fix");
    await approvePending(session);
    t.succeeded();
    t.calledTool("slack_post", {
      input: { target: /releases/, text: /^(?![\s\S]*<@U)[\s\S]*2\.4/ },
      count: 1,
    });
    t.notCalledTool("main_thread_post");
    t.notCalledTool("worker_job");
  },
});
