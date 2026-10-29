import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import { writeToolStubs } from "../stubs.ts";

export default defineEval({
  description: "A vague checkout problem gets a check or a question, not unsolicited Builder work.",
  tags: ["routing", "consent"],
  async test(t) {
    const session = await t.session({ stubs: [...writeToolStubs] });
    const turn = await session.send("In example-app, the checkout page is slow.");
    t.succeeded();
    t.notCalledTool("worker_job");
    t.notCalledTool("job_followup");
    t.notCalledTool("job_steer");
    t.check(
      turn.reply ?? "",
      satisfies(
        (value) =>
          String(value).trim().length > 0 &&
          /\?|can't|cannot|don't know|do not know|couldn't|unable|no access/i.test(String(value)),
        "with no log connection, ask or state the access limit rather than invent a diagnosis",
      ),
    );
  },
});
