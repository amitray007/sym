import type { Job } from "../ledger/jobs.ts";
import type { Pack } from "../pack/load.ts";
import { type SlackApi, SlackApiError } from "./api.ts";
import { isSlackUserAllowed } from "./guard.ts";

interface Deps {
  slack?: SlackApi;
  pack?: Pack;
  usersEnv?: string;
}

export function normalizeSlackPerson(person: string): string {
  return person.trim().replace(/^<@([UW][A-Z0-9]+)>$/, "$1");
}

interface PersonResult {
  person: string;
  status: "invited" | "already there" | "refused";
  reason?: string;
}

// Explicit requests only (decision 074). Channel membership changes post no message, so the
// brain reports the outcome through its normal reply. Never write invitation state to the ledger.
export async function inviteToCodeChannel(
  deps: Deps,
  job: Job | undefined,
  people: string[],
  requester: string | undefined,
): Promise<string | { work: string; results: PersonResult[] }> {
  if (!isSlackUserAllowed(deps.pack, deps.usersEnv ?? process.env.SYM_SLACK_USERS, requester)) {
    return "You are not on Sym's Slack allow-list.";
  }
  if (!job) return "I couldn't find the work for this request.";
  if (job.closedAt || job.archiveState !== "none") return "This work is closed.";
  if (!job.codeChannel || !job.slackChannel) return "This work has no live code channel.";
  if (people.length < 1 || people.length > 10) return "Ask to invite 1 to 10 people at a time.";
  const users = [...new Set(people.map(normalizeSlackPerson))];
  if (users.some((user) => !/^[UW][A-Z0-9]+$/.test(user))) {
    return "Use Slack @-mentions or user IDs.";
  }
  const slack = deps.slack;
  if (!slack) return "Slack is not configured.";
  let privateChannel: boolean;
  try {
    const info = await slack.call("conversations.info", { channel: job.slackChannel });
    const channel = info.channel as
      | {
          is_archived?: boolean;
          is_private?: boolean;
          properties?: { record_channel?: { record_type?: string } };
        }
      | undefined;
    if (channel?.is_archived) return "This code channel is archived.";
    if (
      channel?.properties?.record_channel?.record_type !== "agent_channel" ||
      typeof channel.is_private !== "boolean"
    ) {
      return "This work has no live code channel.";
    }
    privateChannel = channel.is_private;
  } catch (error) {
    const code = failure(error);
    return `Slack refused: ${code}.`;
  }

  let originMembers: Set<string> | undefined;
  if (privateChannel && job.originChannel) {
    originMembers = new Set<string>();
    let cursor = "";
    try {
      do {
        const page = await slack.call("conversations.members", {
          channel: job.originChannel,
          limit: 200,
          ...(cursor ? { cursor } : {}),
        });
        if (!Array.isArray(page.members)) throw new Error("Invalid Slack membership response");
        for (const member of page.members) {
          if (typeof member === "string") originMembers.add(member);
        }
        cursor =
          (page.response_metadata as { next_cursor?: string } | undefined)?.next_cursor ?? "";
      } while (cursor);
    } catch (error) {
      const code = failure(error);
      return {
        work: job.title,
        results: users.map((user) => ({ person: `<@${user}>`, status: "refused", reason: code })),
      };
    }
  }

  const results: PersonResult[] = [];
  for (const user of users) {
    const person = `<@${user}>`;
    if (privateChannel && !originMembers?.has(user)) {
      results.push({ person, status: "refused", reason: "not in the original channel" });
      continue;
    }
    try {
      await slack.call("conversations.invite", { channel: job.slackChannel, users: user });
      results.push({ person, status: "invited" });
    } catch (error) {
      const code = failure(error);
      results.push(
        code === "already_in_channel"
          ? { person, status: "already there" }
          : { person, status: "refused", reason: code },
      );
    }
  }
  return { work: job.title, results };
}

function failure(error: unknown): string {
  const code = error instanceof SlackApiError ? error.code : "unknown_error";
  console.warn("Sym could not invite someone into a code channel.", code);
  return code;
}
