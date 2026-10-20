import { defineSchedule } from "eve/schedules";
import { digestChannel } from "../../lib/digest/post.ts";
import { markRepeatScan, REPEAT_MIN, repeatScanDue } from "../../lib/learning/repeat.ts";
import { ledger, pack } from "../../lib/runtime.ts";
import slack from "../channels/slack.ts";

// The weekly repeated-work review (decision 058): Monday 06:30 UTC, after `learn`. Code checks
// that enough jobs finished since the last review; only then does the brain read the briefs and
// judge what repeats. The session needs a channel: the digest channel, else the pack's default
// channel. Without one it stays off. The brain posts nothing itself; each proposal queues its
// own notice.
const REPEAT_REVIEW_MESSAGE = [
  "Repeated-work review.",
  "Call repeated_work to read the briefs of recent finished jobs.",
  `Look for work that people asked for at least ${REPEAT_MIN} times: the same kind of outcome, ` +
    "even when the words, dates, or targets differ. Skip work an existing playbook covers, and " +
    "skip one-off jobs that only look alike.",
  "For each real pattern, call repeated_work_propose once with the jobs that show it.",
  "Then call no_reply. Write nothing in the channel.",
].join("\n");

export default defineSchedule({
  cron: "30 6 * * 1",
  run({ to, waitUntil, appAuth }) {
    waitUntil(
      (async () => {
        const digest = digestChannel(pack());
        // A user ID cannot hold a session thread, so a DM digest falls back to the default.
        const channelId =
          (digest && /^[CGD]/.test(digest) ? digest : undefined) ??
          pack()?.config.channels?.default;
        if (!channelId) return;
        const sql = ledger();
        const now = new Date();
        if (!(await repeatScanDue(sql, now))) return;
        // Mark first: a crash after the send must not start a second review.
        await markRepeatScan(sql, now);
        await to(slack, { channelId }).send(REPEAT_REVIEW_MESSAGE, { auth: appAuth });
      })(),
    );
  },
});
