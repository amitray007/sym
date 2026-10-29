import { defineEval } from "eve/evals";
import { writeToolStubs } from "../stubs.ts";

export default defineEval({
  description:
    "An explicit request to open a PR calls worker_job, without another consent question.",
  tags: ["routing", "consent"],
  async test(t) {
    const session = await t.session({ stubs: [...writeToolStubs] });
    await session.send(
      "In example-app, open a draft PR that adds a configurable 30s timeout to the sync client. " +
        "Use the default branch. Done when the timeout has a passing unit test.",
    );
    t.succeeded();
    t.calledTool("worker_job", {
      input: {
        project: /example-app/i,
        goal: /timeout/i,
        openPullRequest: true,
        doneWhen: (value: unknown) => Array.isArray(value) && value.length > 0,
      },
      count: 1,
    });
    t.notCalledTool("job_followup");
  },
});
