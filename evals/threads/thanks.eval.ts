import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import { WRITE_TOOLS, writeToolStubs } from "../stubs.ts";
import { OWNER_ID, threadTurn } from "./shared.ts";

export default defineEval({
  description: "An acknowledgement in a shared thread gets no reply and no tool call.",
  tags: ["threads"],
  async test(t) {
    const session = await t.session({ stubs: [...writeToolStubs] });
    const turn = await session.send(
      threadTurn({
        sender: OWNER_ID,
        maybe: true,
        earlier: ["<@UBOT>: The retry change is merged."],
        text: "thanks!",
      }),
    );
    t.succeeded();
    t.calledTool("no_reply");
    for (const tool of WRITE_TOOLS) t.notCalledTool(tool);
    t.check(
      turn.message ?? "",
      satisfies((message) => String(message ?? "").trim() === "", "the reply is empty"),
    );
  },
});
