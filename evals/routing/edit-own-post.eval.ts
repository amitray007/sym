import { defineEval } from "eve/evals";
import { approvePending } from "../conversation.ts";
import { writeToolStubs } from "../stubs.ts";

// Decision 082: a person can ask Sym to fix the post it just made for them.
export default defineEval({
  description: "Asking to fix the last post edits it instead of posting again.",
  tags: ["routing"],
  async test(t) {
    const session = await t.session({ stubs: [...writeToolStubs] });
    await session.send("post in #releases that v2.4 is out");
    await approvePending(session, ["slack_post", "slack_edit"]);
    await session.send("oops, it's v2.5, fix that post");
    await approvePending(session, ["slack_post", "slack_edit"]);
    t.succeeded();
    t.calledTool("slack_post", { count: 1 });
    t.calledTool("slack_edit", { input: { text: /2\.5/ }, count: 1 });
    t.notCalledTool("slack_delete");
  },
});
