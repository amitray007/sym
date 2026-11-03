import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import { hasNoBotPhrases } from "../conversation.ts";
import { writeToolStubs } from "../stubs.ts";

// A few words of chat get a few words back, with no stock assistant phrases (decision 093).
export default defineEval({
  description: "A short casual message gets a short reply without bot phrases.",
  tags: ["voice"],
  async test(t) {
    const session = await t.session({ stubs: [...writeToolStubs] });
    const turn = await session.send("hey, you around?");
    t.succeeded();
    t.notCalledTool("worker_job");
    t.check(
      turn.reply ?? "",
      satisfies((value) => {
        const text = String(value).trim();
        const lines = text.split("\n").filter((line) => line.trim() !== "").length;
        return text.length <= 160 && lines <= 2;
      }, "a reply about as short as the message"),
    );
    t.check(turn.reply ?? "", satisfies(hasNoBotPhrases, "no stock assistant phrases"));
  },
});
