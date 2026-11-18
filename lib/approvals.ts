// One setting per kind of approval click (decision 099). `rules` keeps Sym's own rule for when a
// click is needed, `always` asks every time, and `never` skips the click. A mode changes only the
// click: allow-lists, owner checks, reach checks, and post caps still run in the tool.

export type ApprovalKind = "start" | "connections" | "posts" | "dms" | "admin";
export type ApprovalMode = "rules" | "always" | "never";

type Env = Record<string, string | undefined>;

export const APPROVAL_SETTINGS: Record<ApprovalKind, string> = {
  start: "SYM_APPROVAL_START",
  connections: "SYM_APPROVAL_CONNECTIONS",
  posts: "SYM_APPROVAL_POSTS",
  dms: "SYM_APPROVAL_DMS",
  admin: "SYM_APPROVAL_ADMIN",
};

const MODES: readonly ApprovalMode[] = ["rules", "always", "never"];

// An unset or unknown value keeps the rules, so a typo never opens a gate.
export function approvalMode(kind: ApprovalKind, env: Env = process.env): ApprovalMode {
  const word = env[APPROVAL_SETTINGS[kind]]?.trim().toLowerCase();
  return MODES.find((mode) => mode === word) ?? "rules";
}

// Whether a click is needed. `rule` runs only in `rules` mode, so `never` and `always` skip its
// Slack and database reads.
export async function needsApproval(
  kind: ApprovalKind,
  rule: () => boolean | Promise<boolean>,
  env: Env = process.env,
): Promise<boolean> {
  const mode = approvalMode(kind, env);
  if (mode === "never") return false;
  if (mode === "always") return true;
  return rule();
}

// The same decision as an Eve approval status, for a tool's `approval.request`.
export async function approvalStatus(
  kind: ApprovalKind,
  rule: () => boolean | Promise<boolean>,
  env: Env = process.env,
): Promise<"user-approval" | "not-applicable"> {
  return (await needsApproval(kind, rule, env)) ? "user-approval" : "not-applicable";
}
