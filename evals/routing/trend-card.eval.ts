import { defineEval } from "eve/evals";
import { renderCard } from "../../lib/cards/card.ts";
import { writeToolStubs } from "../stubs.ts";

// Two weeks of daily numbers for two services are too much for a few sentences, so the brain
// may post a chart without being asked (decision 095). The stub answers posted: true, so the
// spec must render and the brain must not add a text reply after it.
export default defineEval({
  description: "A two-week trend for two services becomes one chart card without being asked.",
  tags: ["routing"],
  async test(t) {
    const session = await t.session({ stubs: [...writeToolStubs] });
    await session.send(
      [
        "How has p95 latency moved over the last two weeks? Daily p95 in ms, oldest first:",
        "api: 410, 405, 420, 415, 430, 445, 460, 455, 470, 490, 505, 500, 520, 540",
        "web: 300, 310, 305, 298, 302, 300, 295, 305, 310, 300, 298, 303, 299, 301",
      ].join("\n"),
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
