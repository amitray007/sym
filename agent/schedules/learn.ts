import { defineSchedule } from "eve/schedules";
import { deliver } from "../../lib/delivery/deliver.ts";
import { runLearn } from "../../lib/learning/learn.ts";
import { ledger, slackFromEnv } from "../../lib/runtime.ts";

// The weekly learn pass (docs/learning.md): Monday 06:00 UTC. It makes no model call. Without
// SYM_DIGEST_CHANNEL it stays off, because the owner would never see a proposal.
export default defineSchedule({
  cron: "0 6 * * 1",
  async run() {
    const channel = process.env.SYM_DIGEST_CHANNEL?.trim();
    if (!channel) return;
    const sql = ledger();
    const created = await runLearn(sql, channel, new Date());
    if (created.length === 0) return;
    const slack = slackFromEnv();
    if (slack) await deliver(sql, slack);
  },
});
