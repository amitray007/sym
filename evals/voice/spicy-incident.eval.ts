import { defineEval } from "eve/evals";
import { includes, satisfies } from "eve/evals/expect";
import { writeToolStubs } from "../stubs.ts";

// Run with SYM_PERSONA=spicy: `pnpm eval:spicy`. The persona is process-wide, so a case cannot
// set it. This proves a modest floor only: the reply keeps the facts and uses none
// of a few teasing words. It cannot prove that no joke appears; that needs a judge or a review.
const TEASING = /\b(bestie|lol|lmao|skill issue)\b/i;

export default defineEval({
  description:
    "With SYM_PERSONA=spicy, a failed-deploy message gets a reply that keeps the facts and has no teasing words.",
  tags: ["persona", "persona-spicy"],
  async test(t) {
    const session = await t.session({ stubs: [...writeToolStubs] });
    const turn = await session.send(
      "the deploy of example-app failed at 14:05 UTC with exit code 137 and customers see errors. what should I check first?",
    );
    t.succeeded();
    t.check(turn.message, includes(/137/));
    t.check(
      turn.message ?? "",
      satisfies((message) => !TEASING.test(String(message)), "the reply has no teasing words"),
    );
  },
});
