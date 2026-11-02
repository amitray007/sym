import { defineEval } from "eve/evals";
import { writeToolStubs } from "../stubs.ts";

export default defineEval({
  description:
    "A recurring read-only request calls schedule_create with a cron and an instruction, with no question first.",
  tags: ["routing", "schedules"],
  async test(t) {
    const session = await t.session({ stubs: [...writeToolStubs] });
    await session.send(
      "Every weekday at 9 UTC, check the open pull requests of example-app and tell me " +
        "which ones have waited more than two days for a review.",
    );
    t.succeeded();
    t.calledTool("schedule_create", {
      input: {
        cron: /^0 9 \* \* (1-5|MON-FRI)$/i,
        instruction: /example-app/i,
      },
      count: 1,
    });
    t.notCalledTool("worker_job");
  },
});
