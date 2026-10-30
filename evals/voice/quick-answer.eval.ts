import { defineEval } from "eve/evals";
import { includes, satisfies } from "eve/evals/expect";
import { isQuickReply } from "../conversation.ts";
import { statusStub, writeToolStubs } from "../stubs.ts";

export default defineEval({
  description: "A quick status answer leads with the point and needs no heading or checklist.",
  tags: ["voice"],
  async test(t) {
    const session = await t.session({ stubs: [...writeToolStubs, statusStub] });
    const turn = await session.send("Is J-12 still running? Just a quick answer.");
    t.succeeded();
    t.calledTool("jobs_status", { input: { job: /^J-12$/i }, count: 1 });
    t.notCalledTool("worker_job");
    t.notCalledTool("offer_choices");
    t.check(turn.reply, satisfies(isQuickReply, "plain answer without a report or checklist"));
    t.check(turn.reply, includes(/running/i));
  },
});
