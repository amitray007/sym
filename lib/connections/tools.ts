// A connection's tools and how each one runs (decision 045). Pure: no I/O and no Node built-ins.
//
// - `auto`: the tool runs without asking.
// - `ask`: the owner approves every call.
// - `hidden`: the model cannot find or call the tool.
//
// A read tool starts as `auto` and a write tool as `ask`. A tool is a read tool only when the
// server marks it `readOnlyHint: true`. Everything else counts as a write.

export type ToolMode = "auto" | "ask" | "hidden";
export const TOOL_MODES: readonly ToolMode[] = ["auto", "ask", "hidden"];

export interface ConnectionTool {
  name: string;
  description: string;
  readOnly: boolean;
  mode: ToolMode;
}

// What the MCP SDK's `tools/list` gives for one tool. Server text, so untrusted.
export interface ListedTool {
  name: string;
  description?: string | undefined;
  annotations?: { readOnlyHint?: boolean | undefined } | undefined;
}

// Sym records at most this many tools. More stay reachable under the default rule.
export const MAX_TOOLS = 100;
const MAX_DESCRIPTION = 160;
const TOOL_NAME = /^[A-Za-z0-9_./-]{1,128}$/;

export function defaultMode(readOnly: boolean): ToolMode {
  return readOnly ? "auto" : "ask";
}

// Turns a server's tool list into rows. Names with odd characters are left out, and
// descriptions lose control characters and are cut short, so server text stays small in
// prompts. `previous` keeps the owner's earlier choices for tools that are still there.
export function recordTools(
  listed: readonly ListedTool[],
  previous: readonly ConnectionTool[] = [],
): ConnectionTool[] {
  const before = new Map(previous.map((tool) => [tool.name, tool]));
  const seen = new Set<string>();
  const tools: ConnectionTool[] = [];
  for (const item of listed) {
    if (tools.length >= MAX_TOOLS) break;
    if (!TOOL_NAME.test(item.name) || seen.has(item.name)) continue;
    seen.add(item.name);
    const readOnly = item.annotations?.readOnlyHint === true;
    // Keep the owner's choice. A read tool that turned into a write tool asks again.
    const old = before.get(item.name);
    let mode = old ? old.mode : defaultMode(readOnly);
    if (old?.readOnly && !readOnly && mode === "auto") mode = "ask";
    tools.push({ name: item.name, description: cleanText(item.description ?? ""), readOnly, mode });
  }
  return tools;
}

// Instructions a server sends in its MCP `initialize` result (decision 048). A code-mode server
// uses them to say how to call its few tools. Untrusted text: control and invisible format
// characters go, lines stay, and the length is capped. It is data for the model to read and
// never changes a mode, the project list, or a worker rule.
export const MAX_INSTRUCTIONS = 4000;

export function recordInstructions(text: string | null | undefined): string | null {
  if (!text) return null;
  const plain = text
    .replace(/\r\n?/g, "\n")
    .replace(/[^\P{Cc}\n\t]|\p{Cf}/gu, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!plain) return null;
  return truncate(plain, MAX_INSTRUCTIONS);
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…` : text;
}

function cleanText(text: string): string {
  const plain = text
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > MAX_DESCRIPTION ? `${plain.slice(0, MAX_DESCRIPTION - 1)}…` : plain;
}

// The mode for one call. A tool Sym has not recorded follows the default rule from the
// annotations the server sends with the call.
export function modeFor(
  tools: readonly ConnectionTool[],
  bareName: string,
  annotations?: { readOnlyHint?: unknown } | undefined,
): ToolMode {
  const known = tools.find((tool) => tool.name === bareName);
  if (known) return known.mode;
  return defaultMode(annotations?.readOnlyHint === true);
}

// Eve names a connection tool `<connection>__<tool>`.
export function bareToolName(connection: string, qualified: string): string {
  const prefix = `${connection}__`;
  return qualified.startsWith(prefix) ? qualified.slice(prefix.length) : qualified;
}

export function hiddenTools(tools: readonly ConnectionTool[]): string[] {
  return tools.filter((tool) => tool.mode === "hidden").map((tool) => tool.name);
}

export function toolCounts(tools: readonly ConnectionTool[]): {
  read: number;
  write: number;
  auto: number;
  ask: number;
  hidden: number;
} {
  const count = (test: (tool: ConnectionTool) => boolean) => tools.filter(test).length;
  return {
    read: count((tool) => tool.readOnly),
    write: count((tool) => !tool.readOnly),
    auto: count((tool) => tool.mode === "auto"),
    ask: count((tool) => tool.mode === "ask"),
    hidden: count((tool) => tool.mode === "hidden"),
  };
}

// Parses the `tools` jsonb column. A bad entry is dropped instead of loading with a guessed mode.
export function parseTools(value: unknown): ConnectionTool[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): ConnectionTool[] => {
    if (!item || typeof item !== "object") return [];
    const { name, description, readOnly, mode } = item as Record<string, unknown>;
    if (typeof name !== "string" || typeof readOnly !== "boolean") return [];
    if (!TOOL_MODES.includes(mode as ToolMode)) return [];
    return [
      {
        name,
        description: typeof description === "string" ? description : "",
        readOnly,
        mode: mode as ToolMode,
      },
    ];
  });
}
