import { defineSchedule } from "eve/schedules";
import { deliver } from "../../lib/delivery/deliver.ts";
import { ledger, slackFromEnv } from "../../lib/runtime.ts";

// The delivery safety net (docs/architecture.md). Job steps send their posts at once; this sends
// what a crash or a Slack error left in the outbox, and edits stale job cards.
export default defineSchedule({
  cron: "* * * * *",
  async run() {
    const slack = slackFromEnv();
    if (!slack) return;
    await deliver(ledger(), slack);
  },
});
