import { defineEval } from "eve/evals";
import { includes, satisfies } from "eve/evals/expect";
import { writeToolStubs } from "../stubs.ts";

export default defineEval({
  description: "Status replies name the work without exposing internal job handles.",
  tags: ["voice"],
  async test(t) {
    const session = await t.session({
      stubs: [
        ...writeToolStubs,
        {
          id: "named-status",
          tool: "jobs_status",
          outcome: {
            response: {
              job: "J-142",
              ledgerStatus: "running",
              freshRead: "ok",
              answer: "Billing sync retry: running for 5m. Writing the retry loop.",
            },
          },
        },
      ],
    });
    const turn = await session.send("What's the update on the billing sync retry?");
    t.succeeded();
    t.calledTool("jobs_status");
    t.notCalledTool("worker_job");
    t.check(turn.reply, includes(/retry|billing/i));
    t.check(
      turn.reply,
      satisfies(
        (reply) => typeof reply === "string" && !/J-\d+/i.test(reply),
        "never write internal job handles to people",
      ),
    );
  },
});
