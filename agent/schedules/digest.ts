import { defineSchedule } from "eve/schedules";
import { deliver } from "../../lib/delivery/deliver.ts";
import { DEFAULT_DIGEST_CRON, queueDigest } from "../../lib/digest/post.ts";
import { ledger, slackFromEnv } from "../../lib/runtime.ts";
import { isValidCron } from "../../lib/schedules/cron.ts";

// The daily digest (docs/architecture.md). SYM_DIGEST_CRON sets the time in UTC and is read at
// build time, because the schedule registers when the agent builds. SYM_DIGEST_CHANNEL is a
// channel ID or the owner's user ID for a DM. Without it, the digest stays off.
const configured = process.env.SYM_DIGEST_CRON?.trim();

export default defineSchedule({
  cron: configured && isValidCron(configured) ? configured : DEFAULT_DIGEST_CRON,
  async run() {
    const channel = process.env.SYM_DIGEST_CHANNEL?.trim();
    if (!channel) return;
    const sql = ledger();
    if (!(await queueDigest(sql, channel, new Date()))) return;
    const slack = slackFromEnv();
    if (slack) await deliver(sql, slack);
  },
});
