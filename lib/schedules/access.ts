import { type Caller, isWorkerCaller, NOT_FOR_WORKERS } from "../callers.ts";
import { slackUserOfPrincipal } from "../owner.ts";
import type { Pack } from "../pack/load.ts";
import { isSlackUserAllowed } from "../slack/guard.ts";

export const NOT_ALLOWED = "Only people on Sym's allow-list can set up or change schedules.";

// Decision 085: any allowed Slack person creates, pauses, resumes, and deletes schedules, with no
// owner approval. A worker thread or a run (the app principal) cannot. Event triggers use the
// same rule with their own refusal (decision 088).
export function scheduleManager(
  caller: Caller,
  pack: Pack | undefined,
  usersEnv: string | undefined,
  notAllowed = NOT_ALLOWED,
): { requester: string } | { refusal: string } {
  if (isWorkerCaller(caller)) return { refusal: NOT_FOR_WORKERS };
  const requester = slackUserOfPrincipal(caller?.principalId);
  if (!requester || !isSlackUserAllowed(pack, usersEnv, requester, () => {})) {
    return { refusal: notAllowed };
  }
  return { requester };
}
