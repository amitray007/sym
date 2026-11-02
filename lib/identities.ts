import type { Pack } from "./pack/load.ts";
import { isSlackUserAllowed } from "./slack/guard.ts";

// Who a GitHub or Linear user is in Slack (decision 091). Only an explicit mapping counts: the
// pack's `identities`, or without a pack SYM_GITHUB_USERS and SYM_LINEAR_USERS, each a
// comma-separated list of `<github login or linear email or ID>=<Slack user ID>`. Sym never
// guesses from a display name. A mapped person must also be on the allow-list.

export type IdentitySource = "github" | "linear";

const ENV: Record<IdentitySource, string> = {
  github: "SYM_GITHUB_USERS",
  linear: "SYM_LINEAR_USERS",
};

function mapping(
  source: IdentitySource,
  pack: Pack | undefined,
  env: NodeJS.ProcessEnv,
): Map<string, string> {
  const map = new Map<string, string>();
  if (pack) {
    for (const entry of pack.config.identities) {
      const id = entry[source];
      if (id) map.set(id.trim().toLowerCase(), entry.slackUserId);
    }
    return map;
  }
  for (const pair of (env[ENV[source]] ?? "").split(",")) {
    const [id, user] = pair.split("=").map((part) => part.trim());
    if (id && user && /^[UW][A-Z0-9]+$/.test(user)) map.set(id.toLowerCase(), user);
  }
  return map;
}

// The allowed Slack person behind any of `ids` (a login, an email, a user ID), or undefined.
export function allowedSlackUserFor(
  source: IdentitySource,
  ids: (string | null | undefined)[],
  pack: Pack | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const map = mapping(source, pack, env);
  for (const id of ids) {
    const user = id ? map.get(id.trim().toLowerCase()) : undefined;
    if (user) {
      return isSlackUserAllowed(pack, env.SYM_SLACK_USERS, user, () => {}) ? user : undefined;
    }
  }
  return undefined;
}
