import type { LedgerDeps } from "../jobs/run.ts";
import { jobRef } from "../ledger/jobs.ts";
import { SlackApiError } from "./api.ts";
import { jobOfCodeChannel } from "./code-channel.ts";
import { isSlackUserAllowed } from "./guard.ts";

type Deps = LedgerDeps & {
  usersEnv?: string;
  closeJob: (ref: string, by: string) => Promise<string>;
};

// Conversation channels have no job to reconcile. Serialize their info/archive pair across
// processes so two clicks observe one archive. Job closure keeps its existing recovery path.
export async function closeCodeChannel(
  deps: Deps,
  channelId: string,
  by: string | undefined,
): Promise<string> {
  if (!by || !isSlackUserAllowed(deps.pack, deps.usersEnv ?? process.env.SYM_SLACK_USERS, by))
    return "You are not on Sym's Slack allow-list.";
  const job = await jobOfCodeChannel(deps.sql, channelId);
  if (job) return deps.closeJob(jobRef(job.id), by);
  const slack = deps.slack;
  if (!slack) return "Slack is not configured.";
  const lock = await deps.sql.reserve();
  try {
    await lock`select pg_advisory_lock(4242004, hashtext(${channelId}))`;
    const info = await slack.call("conversations.info", { channel: channelId });
    const channel = info.channel as
      | { is_archived?: boolean; properties?: { record_channel?: { record_type?: string } } }
      | undefined;
    if (channel?.properties?.record_channel?.record_type !== "agent_channel")
      return "This is not a code channel.";
    if (channel.is_archived) return "Already closed.";
    await slack.call("agents.conversations.archive", { channel_id: channelId });
    return "Closed this and archived its channel.";
  } catch (error) {
    const code = error instanceof SlackApiError ? error.code : "unknown_error";
    if (code === "already_archived") return "Already closed.";
    return `Slack refused: ${code}.`;
  } finally {
    await lock`select pg_advisory_unlock(4242004, hashtext(${channelId}))`.catch(() => {});
    lock.release();
  }
}
