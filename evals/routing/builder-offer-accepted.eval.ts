import { defineEval } from "eve/evals";
import { writeToolStubs } from "../stubs.ts";

export default defineEval({
  description: "Yes to a specific Builder offer calls worker_job with the offered read-only scope.",
  tags: ["routing", "consent"],
  async test(t) {
    const session = await t.session({ stubs: [...writeToolStubs] });
    await session.send(`<slack_thread_context>
<@UOWNER1>: In example-app, the checkout page is slow.
<@UBOT>: I can't reach the checkout logs. Want me to put Builder on a read-only repository investigation of the checkout path, report likely causes, and leave code and production alone?
</slack_thread_context>

yes put builder on it`);
    t.succeeded();
    t.calledTool("worker_job", {
      input: {
        project: /example-app/i,
        goal: /checkout/i,
        openPullRequest: false,
        constraints: (value: unknown) =>
          Array.isArray(value) &&
          /read.only|no (?:code )?changes|do not (?:edit|change)/i.test(value.join(" ")),
      },
      count: 1,
    });
    t.notCalledTool("job_followup");
  },
});
