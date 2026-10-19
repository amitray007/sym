import { defineSchedule } from "eve/schedules";
import { deliver } from "../../lib/delivery/deliver.ts";
import { DEFAULT_DIGEST_CRON, digestChannel, queueDigest } from "../../lib/digest/post.ts";
import { ledger, pack, slackFromEnv } from "../../lib/runtime.ts";
import { isValidCron } from "../../lib/schedules/cron.ts";

// The daily digest (docs/architecture.md). SYM_DIGEST_CRON sets the time in UTC and is read at
// build time, because the schedule registers when the agent builds. The channel comes from the
// pack or SYM_DIGEST_CHANNEL (digestChannel). Without one, the digest stays off.
const configured = process.env.SYM_DIGEST_CRON?.trim();

export default defineSchedule({
  cron: configured && isValidCron(configured) ? configured : DEFAULT_DIGEST_CRON,
  async run() {
    const channel = digestChannel(pack());
    if (!channel) return;
    const sql = ledger();
    if (!(await queueDigest(sql, channel, new Date()))) return;
    const slack = slackFromEnv();
    if (slack) await deliver(sql, slack);
  },
});
