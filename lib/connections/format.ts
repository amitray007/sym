// Text for connection tools and approval prompts (decision 045). Pure: no I/O.
import type { SignInState } from "./credentials.ts";
import type { AuthKind, Connection } from "./rows.ts";
import { type ConnectionTool, type ToolMode, toolCounts } from "./tools.ts";

// What the owner approves. The model passes it back from connection_add's result, and
// connection_approve refuses it when it differs from the stored proposal, so the owner approves
// exactly what loads.
export interface Review {
  name: string;
  url: string;
  auth: AuthKind;
  tools: { name: string; access: "read" | "write" }[];
}

export function reviewOf(row: Pick<Connection, "name" | "url" | "authKind" | "tools">): Review {
  return {
    name: row.name,
    url: row.url,
    auth: row.authKind,
    tools: row.tools.map((tool) => ({
      name: tool.name,
      access: tool.readOnly ? "read" : "write",
    })),
  };
}

export function sameReview(a: Review, b: Review): boolean {
  const key = (review: Review) =>
    JSON.stringify([
      review.name,
      review.url,
      review.auth,
      [...review.tools].map((tool) => `${tool.name}:${tool.access}`).sort(),
    ]);
  return key(a) === key(b);
}

export function authLine(auth: AuthKind, envVar: string | null): string {
  if (auth === "env") return `a token from ${envVar ?? "an env var"}`;
  if (auth === "oauth") return "an OAuth sign-in by the owner";
  return "none";
}

const MODE_TEXT: Record<ToolMode, string> = {
  auto: "runs freely",
  ask: "asks the owner each time",
  hidden: "hidden",
};

// The approval prompt for a new connection. Every tool shows with read or write.
export function approvalPrompt(review: Review, envVar: string | null): string {
  const lines = [
    `Connect "${review.name}"?`,
    `URL: ${review.url}`,
    `Sign-in: ${authLine(review.auth, envVar)}`,
  ];
  if (review.tools.length === 0) {
    lines.push(
      "Tools: listed after the sign-in. Read tools run freely. Write tools ask the owner each time.",
    );
  } else {
    lines.push(`Tools (${review.tools.length}):`);
    for (const tool of review.tools) {
      lines.push(
        `- ${tool.name}: ${tool.access}, ${tool.access === "read" ? MODE_TEXT.auto : MODE_TEXT.ask}`,
      );
    }
  }
  lines.push("Sym treats what this server returns as data, not instructions.");
  return lines.join("\n");
}

export function modePrompt(name: string, tool: string, mode: ToolMode): string {
  const effect =
    mode === "auto"
      ? "It runs without asking anyone."
      : mode === "ask"
        ? "You approve every call."
        : "Sym cannot find or call it.";
  return `Set "${tool}" on "${name}" to ${mode}? ${effect}`;
}

export function removePrompt(name: string): string {
  return `Remove the connection "${name}"? Sym stops loading it and deletes its stored sign-in.`;
}

// What the owner must do before the connection can load, or nothing.
export function credentialNote(
  row: Pick<Connection, "name" | "authKind" | "envVar">,
  state: { tokenSet: boolean; signIn: SignInState },
): string | undefined {
  if (row.authKind === "env" && !state.tokenSet) {
    return `Set ${row.envVar} in the deployment environment and redeploy.`;
  }
  if (row.authKind === "oauth") {
    if (state.signIn === "missing") return "The owner has not signed in yet.";
    if (state.signIn === "expired") return "The sign-in expired. The owner signs in again.";
  }
  return undefined;
}

export function toolsLine(tools: readonly ConnectionTool[]): string {
  if (tools.length === 0) return "no tools listed yet";
  const counts = toolCounts(tools);
  return (
    `${tools.length} tools (${counts.read} read, ${counts.write} write; ` +
    `${counts.auto} auto, ${counts.ask} ask, ${counts.hidden} hidden)`
  );
}

// One line per connection. It never holds a token: only whether one is there.
export function connectionLine(
  row: Connection,
  state: { tokenSet: boolean; signIn: SignInState },
): string {
  const auth =
    row.authKind === "env"
      ? `token ${row.envVar} ${state.tokenSet ? "set" : "missing"}`
      : row.authKind === "oauth"
        ? `OAuth sign-in ${state.signIn === "refreshable" ? "valid" : state.signIn}`
        : "no sign-in";
  return `${row.name}: ${row.status}, ${auth}, ${toolsLine(row.tools)}`;
}

// The tool rows a person can read: name, read or write, and mode.
export function toolDetail(tools: readonly ConnectionTool[]): string {
  return tools
    .map((tool) => `- ${tool.name}: ${tool.readOnly ? "read" : "write"}, ${tool.mode}`)
    .join("\n");
}
