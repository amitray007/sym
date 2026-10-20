import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import { writeToolStubs } from "../stubs.ts";
import { lines } from "./shared.ts";

const MAX_LINE = 220;

export default defineEval({
  description: "An explanation stays in short lines: no line over 220 characters.",
  tags: ["voice"],
  async test(t) {
    const session = await t.session({ stubs: [...writeToolStubs] });
    const turn = await session.send("explain what a job card is");
    t.succeeded();
    t.check(
      turn.message ?? "",
      satisfies(
        () => lines(turn.message).every((line) => line.length <= MAX_LINE),
        `no line is longer than ${MAX_LINE} characters`,
      ),
    );
    t.check(
      turn.message ?? "",
      satisfies(() => lines(turn.message).length <= 12, "the reply has at most 12 lines"),
    );
  },
});
