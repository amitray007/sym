import { defineEval } from "eve/evals";
import { statusStub, writeToolStubs } from "../stubs.ts";
import { OWNER_ID, threadTurn } from "./shared.ts";

export default defineEval({
  description:
    "A message that names Sym without a tag, from the person Sym serves, gets an answer.",
  tags: ["threads"],
  async test(t) {
    const session = await t.session({ stubs: [...writeToolStubs, statusStub] });
    await session.send(
      threadTurn({
        sender: OWNER_ID,
        maybe: true,
        earlier: ["<@UBOT>: J-12 started. The card shows progress."],
        text: "sym, what's the status?",
      }),
    );
    t.succeeded();
    t.calledTool("jobs_status", { count: 1 });
    t.notCalledTool("worker_job");
  },
});
