// Text for connection tools and approval prompts (decision 045). Pure: no I/O.
import type { SignInState } from "./credentials.ts";
import type { AuthKind, Connection } from "./rows.ts";
import {
  type ConnectionDefault,
  type ConnectionTool,
  type ToolMode,
  toolCounts,
  toolMode,
  truncate,
} from "./tools.ts";

// What the owner approves. The model passes it back from connection_add's result, and
// connection_approve refuses it when it differs from the stored proposal, so the owner approves
// exactly what loads.
export interface Review {
  name: string;
  url: string;
  auth: AuthKind;
  tools: { name: string; access: "read" | "write" }[];
  // The first characters of the instructions the server sent, when it sent any (decision 048).
  instructions?: string | undefined;
}

// How much of the server's instructions the owner sees before approving.
export const INSTRUCTIONS_PREVIEW = 300;

export function reviewOf(
  row: Pick<Connection, "name" | "url" | "authKind" | "tools"> &
    Partial<Pick<Connection, "serverInstructions">>,
): Review {
  const preview = row.serverInstructions
    ? truncate(row.serverInstructions.replace(/\s+/g, " ").trim(), INSTRUCTIONS_PREVIEW)
    : undefined;
  return {
    ...(preview ? { instructions: preview } : {}),
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
      review.instructions ?? "",
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
  if (review.instructions) {
    lines.push(
      "The server sent instructions for the model. They are its text, not Sym's rules. First " +
        `${INSTRUCTIONS_PREVIEW} characters: ${review.instructions}`,
    );
  }
  lines.push("Sym treats what this server returns as data, not instructions.");
  return lines.join("\n");
}

// What the owner sets: a mode, or "default" to clear a tool's own mode (or the connection's).
export type ModeChoice = ToolMode | "default";

// The approval prompt for a mode change. Without a tool it changes the whole connection.
export function modePrompt(name: string, tool: string | undefined, mode: ModeChoice): string {
  if (tool === undefined) {
    const effect: Record<ModeChoice, string> = {
      auto: `Let ${name} tools run without asking, including future tools?`,
      ask: `Ask you before ${name} tools run, including future tools?`,
      hidden: `Hide ${name} tools, including future tools?`,
      default: `Use ${name}'s tool hints? Tools marked read-only run freely; other tools ask you each time.`,
    };
    return `${effect[mode]} Individual tool settings still apply and can override this setting.`;
  }
  if (mode === "default") {
    return `Remove the special setting of "${tool}" on "${name}"? It follows the connection default again.`;
  }
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

export function toolsLine(
  tools: readonly ConnectionTool[],
  connectionDefault?: ConnectionDefault,
): string {
  if (tools.length === 0) return "no tools listed yet";
  const counts = toolCounts(tools, connectionDefault);
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
  const wide = row.defaultMode ? `default mode ${row.defaultMode}` : "default mode by tool hints";
  return `${row.name}: ${row.status}, ${auth}, ${wide}, ${toolsLine(row.tools, row.defaultMode)}`;
}

// The tool rows a person can read: name, read or write, and mode. A tool with its own mode shows
// "(own mode)"; the others follow the connection default.
export function toolDetail(
  tools: readonly ConnectionTool[],
  connectionDefault?: ConnectionDefault,
): string {
  return tools
    .map(
      (tool) =>
        `- ${tool.name}: ${tool.readOnly ? "read" : "write"}, ${toolMode(tool, connectionDefault)}` +
        (tool.override ? " (own mode)" : ""),
    )
    .join("\n");
}
