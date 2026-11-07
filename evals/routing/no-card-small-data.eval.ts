import { defineEval } from "eve/evals";
import { includes, satisfies } from "eve/evals/expect";
import { isQuickReply } from "../conversation.ts";
import { writeToolStubs } from "../stubs.ts";

// A few numbers with no request for a chart stay a short text reply (decision 095). Sym is a
// text chat first; a card is only for data too large for a few sentences.
export default defineEval({
  description: "A few numbers without a chart request get a short text reply, not a card.",
  tags: ["routing"],
  async test(t) {
    const session = await t.session({ stubs: [...writeToolStubs] });
    const turn = await session.send(
      "Deploys this week: api had 4, web 2, and worker 1. Which one shipped the most?",
    );
    t.succeeded();
    t.notCalledTool("present_card");
    t.notCalledTool("worker_job");
    t.check(turn.reply, satisfies(isQuickReply, "short text answer"));
    t.check(turn.reply, includes(/api/i));
  },
});
