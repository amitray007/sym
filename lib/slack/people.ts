import type { Pack } from "../pack/load.ts";
import { type SlackApi, SlackApiError } from "./api.ts";
import { isSlackUserAllowed } from "./guard.ts";

// Workspace people for the brain (decision 083): who someone is, and whether Sym may DM them.
// The workspace directory already shows these fields to every member.

export interface PersonDeps {
  slack?: SlackApi | undefined;
  pack?: Pack | undefined;
  usersEnv?: string | undefined;
}

export interface Person {
  id: string;
  name: string;
  displayName?: string | undefined;
  title?: string | undefined;
  timeZone?: string | undefined;
  localTime?: string | undefined;
  status?: string | undefined;
  isBot: boolean;
  deactivated: boolean;
  // Another organization's member, seen through a Slack Connect channel.
  external: boolean;
}

export const UNKNOWN_PERSON = "I couldn't find that person.";

export function slackUserId(person: string): string | undefined {
  const id = person.trim().replace(/^<@([UW][A-Z0-9]+)(?:\|[^>]*)?>$/, "$1");
  return /^[UW][A-Z0-9]+$/.test(id) ? id : undefined;
}

export async function lookUpPerson(
  deps: PersonDeps,
  requester: string | undefined,
  person: string,
  now = new Date(),
): Promise<Person | undefined> {
  const id = slackUserId(person);
  if (!id || !deps.slack) return undefined;
  if (!isSlackUserAllowed(deps.pack, deps.usersEnv ?? process.env.SYM_SLACK_USERS, requester)) {
    return undefined;
  }
  try {
    const info = await deps.slack.call("users.info", { user: id });
    return toPerson(info.user as SlackUser | undefined, now);
  } catch (error) {
    const code = error instanceof SlackApiError ? error.code : "unknown_error";
    console.warn(`Sym could not look up a person: ${code}.`);
    return undefined;
  }
}

interface SlackUser {
  id?: string;
  name?: string;
  real_name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  is_stranger?: boolean;
  tz?: string;
  profile?: {
    display_name?: string;
    real_name?: string;
    title?: string;
    status_text?: string;
    status_emoji?: string;
  };
}

function toPerson(user: SlackUser | undefined, now: Date): Person | undefined {
  if (!user?.id) return undefined;
  const status = [user.profile?.status_emoji, user.profile?.status_text].filter(Boolean).join(" ");
  return {
    id: user.id,
    name: user.real_name || user.profile?.real_name || user.name || user.id,
    displayName: user.profile?.display_name || undefined,
    title: user.profile?.title || undefined,
    timeZone: user.tz || undefined,
    localTime: user.tz ? localTime(user.tz, now) : undefined,
    status: status || undefined,
    isBot: user.is_bot === true,
    deactivated: user.deleted === true,
    external: user.is_stranger === true,
  };
}

function localTime(timeZone: string, now: Date): string | undefined {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
    }).format(now);
  } catch {
    return undefined;
  }
}
