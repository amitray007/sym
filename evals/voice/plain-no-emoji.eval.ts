import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import { writeToolStubs } from "../stubs.ts";

// Run with SYM_PERSONA=plain: `pnpm eval:plain`. The persona is process-wide, so a case cannot
// set it. Plain replies have no decorative emoji or checklist exceptions.
const EMOJI = /\p{Extended_Pictographic}/u;

export default defineEval({
  description: "With SYM_PERSONA=plain, the reply holds no emoji.",
  tags: ["persona", "persona-plain"],
  async test(t) {
    const session = await t.session({ stubs: [...writeToolStubs] });
    const turn = await session.send("what can you do? keep it friendly.");
    t.succeeded();
    t.check(
      turn.reply ?? "",
      satisfies((message) => !EMOJI.test(String(message)), "the reply has no emoji"),
    );
  },
});
