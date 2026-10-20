import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import { writeToolStubs } from "../stubs.ts";
import { LIST_LINE, lines } from "./shared.ts";

export default defineEval({
  description:
    "A capability question gets a short reply: an answer line first, then a list, at most 8 lines.",
  tags: ["voice"],
  async test(t) {
    const session = await t.session({ stubs: [...writeToolStubs] });
    const turn = await session.send("what can you do?");
    t.succeeded();
    const all = lines(turn.message);
    t.check(
      turn.message ?? "",
      satisfies(() => all.length > 0 && all.length <= 8, "the reply has 1 to 8 non-empty lines"),
    );
    t.check(
      turn.message ?? "",
      satisfies(() => all.some((line) => LIST_LINE.test(line)), "the reply has a list line"),
    );
    t.check(
      turn.message ?? "",
      satisfies(
        () => all.length > 0 && !LIST_LINE.test(all[0] ?? ""),
        "the first line is not a list item",
      ),
    );
  },
});
