import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import { WRITE_TOOLS, writeToolStubs } from "../stubs.ts";
import { ALLOWED_ID, OWNER_ID, threadTurn } from "./shared.ts";

// Decision 050: in a thread with several people, Sym stays silent for talk between people and
// calls no tool.

export default defineEval({
  description: "Side talk to another person in a shared thread gets no reply and no tool call.",
  tags: ["threads"],
  async test(t) {
    const session = await t.session({ stubs: [...writeToolStubs] });
    const turn = await session.send(
      threadTurn({
        sender: OWNER_ID,
        maybe: true,
        earlier: [
          `<@${OWNER_ID}>: <@UBOT> how is the sync retry going?`,
          "<@UBOT>: It passed review and is merged.",
          `<@${ALLOWED_ID}>: nice, thanks Sym`,
        ],
        text: "Bob, can you look at the staging deploy before lunch?",
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
