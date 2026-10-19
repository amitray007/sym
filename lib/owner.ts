// Who owns Sym's standing decisions (docs/learning.md, docs/slack.md). The owner approves
// playbooks, rules, and schedules. Allowed users can still ask questions and start jobs.
import type { Pack } from "./pack/load.ts";

// The pack's owner, then SYM_OWNER_SLACK_USER. Undefined when the deployment names no one.
export function ownerUserId(
  pack: Pack | undefined,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  return pack?.config.owner.slackUserId || env.SYM_OWNER_SLACK_USER?.trim() || undefined;
}

// `slack:<team>:<user>` gives the user. Other principals give nothing.
export function slackUserOfPrincipal(principalId: string | undefined): string | undefined {
  const match = /^slack:[^:]+:([^:]+)$/.exec(principalId ?? "");
  return match?.[1];
}

// True when this Slack user may decide owner matters. With no owner configured, anyone who
// passed the allow-list check may. The caller checks the allow-list itself.
export function mayDecideAsOwner(
  userId: string | undefined,
  pack: Pack | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const owner = ownerUserId(pack, env);
  return owner === undefined || (userId !== undefined && userId === owner);
}

export const OWNER_ONLY = "Only the owner can decide this.";

// Eve marks the buttons of a tool approval with a `tool-approval:` action ID prefix, after an
// optional route. Question buttons and modal answers carry no such prefix.
const APPROVAL_ACTION = /^eve_input:(?:route:[^:]+:[^:]+:)?tool-approval:/;
export function isApprovalAction(actionId: string): boolean {
  return APPROVAL_ACTION.test(actionId);
}
