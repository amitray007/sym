import { defineEval } from "eve/evals";
import { approvePending } from "../conversation.ts";
import { writeToolStubs } from "../stubs.ts";

// Decision 083: "let <@U…> know" sends that person a DM, not a channel post.
export default defineEval({
  description: "Asking Sym to tell a person something sends them one DM.",
  tags: ["routing"],
  async test(t) {
    const session = await t.session({ stubs: [...writeToolStubs] });
    await session.send("let <@U0PRIYA> know the v2.4 release moved to Friday");
    await approvePending(session, ["slack_dm"]);
    t.succeeded();
    t.calledTool("slack_dm", { input: { person: /U0PRIYA/, text: /Friday/ }, count: 1 });
    t.notCalledTool("slack_post");
  },
});
