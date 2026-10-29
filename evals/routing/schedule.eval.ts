import { defineEval } from "eve/evals";
import { writeToolStubs } from "../stubs.ts";

export default defineEval({
  description: "A recurring request calls schedule_create with a cron and waits for approval.",
  tags: ["routing", "approvals"],
  async test(t) {
    const session = await t.session({ stubs: [...writeToolStubs] });
    await session.send(
      "Every weekday at 9 UTC, check the open pull requests of example-app and tell me " +
        "which ones have waited more than two days for a review.",
    );
    // schedule_create needs the owner's approval, so the call stays pending and the run parks.
    t.awaitingInput();
    t.calledTool("schedule_create", {
      status: "pending",
      input: {
        cron: /^0 9 \* \* (1-5|MON-FRI)$/i,
        brief: { project: /example-app/i },
      },
      count: 1,
    });
    t.notCalledTool("worker_job");
  },
});
