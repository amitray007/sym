import { defineEval } from "eve/evals";
import { writeToolStubs } from "../stubs.ts";

// Owner-run with SYM_CODE_CHANNELS=on. The dynamic tool is absent when that switch is off.
// Context matches the job note supplied on a code-channel turn. No real Slack call runs.
export default defineEval({
  description:
    "An explicit request invites the mentioned teammate once into this work's code channel.",
  tags: ["routing", "code-channels"],
  async test(t) {
    const session = await t.session({ stubs: [...writeToolStubs] });
    await session.send("bring <@U0TEAMMATE> in here", {
      clientContext:
        'This Slack code channel is about J-12 ("Retry work"), now running. Code channels are on. Job references are tool handles; name the work or say "this" to people.',
    });
    t.succeeded();
    t.calledTool("code_channel_invite", {
      input: { people: [/^(?:U0TEAMMATE|<@U0TEAMMATE>)$/] },
      count: 1,
    });
    t.notCalledTool("worker_job");
    t.notCalledTool("job_steer");
  },
});
