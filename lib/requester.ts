import { isScheduleAuth } from "eve/schedules";
import type { Caller } from "./callers.ts";
import type { Sql } from "./db.ts";
import { slackUserOfPrincipal } from "./owner.ts";
import type { Pack } from "./pack/load.ts";
import { runCreatorOf } from "./schedules/rows.ts";
import { isSlackUserAllowed } from "./slack/guard.ts";

// The Slack person a turn acts for (decisions 081 and 085). A person's turn acts for that
// person. A scheduled run starts as the app principal, the code proof that it is a run, and acts
// for the schedule's creator while they stay on the allow-list. Any other app or worker session
// acts for nobody.

export interface RequesterDeps {
  sql: Sql;
  pack?: Pack | undefined;
}

export interface RequesterSession {
  id: string;
  auth: { current?: Caller };
}

// True for a session the app principal started, such as a scheduled run.
export function isAppSession(session: RequesterSession): boolean {
  return isScheduleAuth(session.auth.current as Parameters<typeof isScheduleAuth>[0]);
}

// `deps` is a getter, so a person's turn reads no ledger.
export async function requesterOf(
  session: RequesterSession,
  deps: () => RequesterDeps,
  usersEnv: string | undefined = process.env.SYM_SLACK_USERS,
): Promise<string | undefined> {
  if (!isAppSession(session)) return slackUserOfPrincipal(session.auth.current?.principalId);
  return allowedCreator(session.id, deps(), usersEnv);
}

// The person a session's Slack thread serves: the sender of the turn, or, for a scheduled run,
// the creator it acts for. A run's thread then counts as the creator's own, so a run in their DM
// can share what they may read there (decision 083). The session keeps the app principal.
export async function threadUserOf(
  session: RequesterSession,
  triggeringUserId: string | null | undefined,
  deps: () => RequesterDeps,
): Promise<string | null> {
  if (triggeringUserId) return triggeringUserId;
  if (!isAppSession(session)) return null;
  return (await requesterOf(session, deps)) ?? null;
}

async function allowedCreator(
  sessionId: string,
  deps: RequesterDeps,
  usersEnv: string | undefined,
): Promise<string | undefined> {
  const creator = await runCreatorOf(deps.sql, sessionId);
  return creator && isSlackUserAllowed(deps.pack, usersEnv, creator, () => {})
    ? creator
    : undefined;
}

async function isCreator(
  user: string | undefined,
  sessionId: string,
  deps: RequesterDeps,
): Promise<boolean> {
  if (!user) return false;
  return user === (await allowedCreator(sessionId, deps, process.env.SYM_SLACK_USERS));
}

interface ResponseArgs {
  request: { principal: { principalId: string } | null };
  response: { principal: { principalId: string } };
  session: { id: string };
}

// An Eve approval response policy for a person's own request (decision 081): only the person
// whose turn asked can approve or cancel it. In a scheduled run, that person is the schedule's
// creator (decision 085).
export function requesterResponse(reason: string, deps: () => RequesterDeps) {
  return async ({ request, response, session }: ResponseArgs) => {
    const responder = response.principal.principalId;
    const allowed = isScheduleAuth(request.principal as Parameters<typeof isScheduleAuth>[0])
      ? await isCreator(slackUserOfPrincipal(responder), session.id, deps())
      : responder === request.principal?.principalId;
    return allowed ? { status: "allowed" as const } : { status: "rejected" as const, reason };
  };
}
