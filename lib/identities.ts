import type { Pack } from "./pack/load.ts";
import { isSlackUserAllowed } from "./slack/guard.ts";

// Who a GitHub or Linear user is in Slack (decision 091). Only an explicit mapping counts: the
// pack's `identities`, or without a pack SYM_GITHUB_USERS and SYM_LINEAR_USERS, each a
// comma-separated list of `<id>=<Slack user ID>`. A GitHub entry names the account's numeric ID,
// because a login can be renamed and taken by someone else; a login-only entry maps nobody and
// logs a warning. A Linear entry names the user's ID, or their email. Sym never guesses from a
// display name. A mapped person must also be on the allow-list.

export type IdentitySource = "github" | "linear";

const ENV: Record<IdentitySource, string> = {
  github: "SYM_GITHUB_USERS",
  linear: "SYM_LINEAR_USERS",
};

const warned = new Set<string>();
function warnOnce(line: string): void {
  if (warned.has(line)) return;
  warned.add(line);
  console.warn(line);
}

const LOGIN_ONLY =
  "A GitHub identity names a login without a numeric ID, so it maps nobody. Use the account's ID.";

function mapping(
  source: IdentitySource,
  pack: Pack | undefined,
  env: NodeJS.ProcessEnv,
): Map<string, string> {
  const map = new Map<string, string>();
  if (pack) {
    for (const entry of pack.config.identities) {
      if (source === "github") {
        if (entry.githubId) map.set(String(entry.githubId), entry.slackUserId);
        else if (entry.github) warnOnce(LOGIN_ONLY);
        continue;
      }
      if (entry.linear) map.set(entry.linear.trim().toLowerCase(), entry.slackUserId);
    }
    return map;
  }
  for (const pair of (env[ENV[source]] ?? "").split(",")) {
    const [id, user] = pair.split("=").map((part) => part.trim());
    if (!id || !user || !/^[UW][A-Z0-9]+$/.test(user)) continue;
    if (source === "github" && !/^\d+$/.test(id)) {
      warnOnce(LOGIN_ONLY);
      continue;
    }
    map.set(id.toLowerCase(), user);
  }
  return map;
}

// The allowed Slack person behind any of `ids` (a GitHub account ID; a Linear user ID or email),
// or undefined.
export function allowedSlackUserFor(
  source: IdentitySource,
  ids: (string | number | null | undefined)[],
  pack: Pack | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const map = mapping(source, pack, env);
  for (const id of ids) {
    const user =
      id === null || id === undefined ? undefined : map.get(String(id).trim().toLowerCase());
    if (user) {
      return isSlackUserAllowed(pack, env.SYM_SLACK_USERS, user, () => {}) ? user : undefined;
    }
  }
  return undefined;
}
