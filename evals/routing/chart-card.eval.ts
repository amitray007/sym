import { defineEval } from "eve/evals";
import { renderCard } from "../../lib/cards/card.ts";
import { writeToolStubs } from "../stubs.ts";

// A request for a chart, with the numbers in the message, becomes one card (decision 095). The
// stub answers posted: true, so the call must carry a spec Sym can render, and the brain must not
// add a text reply after it.
export default defineEval({
  description: "A chart request with its data posts one valid card and no extra reply.",
  tags: ["routing"],
  async test(t) {
    const session = await t.session({ stubs: [...writeToolStubs] });
    await session.send(
      "Can you chart deploys per service this week? api had 4, web 2, and worker 1.",
    );
    t.succeeded();
    t.calledTool("present_card", {
      count: 1,
      input: (input) => {
        const card = renderCard(input.spec);
        return card.ok && card.blocks.some((block) => block.type === "data_visualization");
      },
    });
    t.calledTool("no_reply");
    t.notCalledTool("worker_job");
  },
});
