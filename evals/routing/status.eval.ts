import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";
import { statusStub, writeToolStubs } from "../stubs.ts";

export default defineEval({
  description: "A status question calls jobs_status with the job reference, not t3_job.",
  tags: ["routing"],
  async test(t) {
    const session = await t.session({ stubs: [...writeToolStubs, statusStub] });
    const turn = await session.send("What's the update on J-12?");
    t.succeeded();
    t.calledTool("jobs_status", { input: { job: /^J-12$/i }, count: 1 });
    t.notCalledTool("t3_job");
    t.check(turn.message ?? "", includes(/J-12|running|step 3/i));
  },
});
