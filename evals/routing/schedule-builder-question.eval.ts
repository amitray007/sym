import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import { writeToolStubs } from "../stubs.ts";

export default defineEval({
  description:
    "A schedule that needs Builder work gets one question first: start on its own, or ask each time.",
  tags: ["routing", "schedules", "consent"],
  async test(t) {
    const session = await t.session({ stubs: [...writeToolStubs] });
    const turn = await session.send(
      "Every Monday at 8 UTC, have Builder update the dependencies of example-app and open a " +
        "draft PR.",
    );
    t.succeeded();
    t.notCalledTool("schedule_create");
    t.notCalledTool("worker_job");
    t.check(
      turn.reply ?? "",
      satisfies(
        (value) => /\?/.test(String(value)) && /\b(ask|start|click|own)\b/i.test(String(value)),
        "ask whether Builder starts on its own or asks each time",
      ),
    );
  },
});
