// A connection's tools and how each one runs (decision 045). Pure: no I/O and no Node built-ins.
//
// - `auto`: the tool runs without asking.
// - `ask`: the owner approves every call.
// - `hidden`: the model cannot find or call the tool.
//
// Each tool resolves in this order (decision 049): the owner's own mode for the tool
// (`override`), then the connection's `default_mode`, then the annotation rule. The annotation
// rule: a read tool is `auto` and a write tool is `ask`. A tool is a read tool only when the
// server marks it `readOnlyHint: true`. Everything else counts as a write.

export type ToolMode = "auto" | "ask" | "hidden";
export const TOOL_MODES: readonly ToolMode[] = ["auto", "ask", "hidden"];

export interface ConnectionTool {
  name: string;
  description: string;
  readOnly: boolean;
  // The mode the owner set for this tool alone. Absent means the tool follows the connection
  // default, then the annotation rule.
  override?: ToolMode | undefined;
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

// The connection-wide default: null keeps the annotation rule.
export type ConnectionDefault = ToolMode | null;

// The mode a tool runs in: the owner's mode for it, else the connection default, else the
// annotation rule.
export function resolveMode(
  override: ToolMode | undefined,
  readOnly: boolean,
  connectionDefault: ConnectionDefault | undefined,
): ToolMode {
  return override ?? connectionDefault ?? defaultMode(readOnly);
}

export function toolMode(
  tool: ConnectionTool,
  connectionDefault: ConnectionDefault | undefined,
): ToolMode {
  return resolveMode(tool.override, tool.readOnly, connectionDefault);
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
    // Keep the owner's choice. A read tool that turned into a write tool loses an `auto` choice
    // and follows the default again.
    const old = before.get(item.name);
    let override = old?.override;
    if (old?.readOnly && !readOnly && override === "auto") override = undefined;
    tools.push({
      name: item.name,
      description: cleanText(item.description ?? ""),
      readOnly,
      ...(override ? { override } : {}),
    });
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

// The mode for one call. A tool Sym has not recorded resolves from the annotations the server
// sends with the call, with no owner mode.
export function modeFor(
  tools: readonly ConnectionTool[],
  bareName: string,
  annotations?: { readOnlyHint?: unknown } | undefined,
  connectionDefault?: ConnectionDefault,
): ToolMode {
  const known = tools.find((tool) => tool.name === bareName);
  if (known) return toolMode(known, connectionDefault);
  return resolveMode(undefined, annotations?.readOnlyHint === true, connectionDefault);
}

// Eve names a connection tool `<connection>__<tool>`.
export function bareToolName(connection: string, qualified: string): string {
  const prefix = `${connection}__`;
  return qualified.startsWith(prefix) ? qualified.slice(prefix.length) : qualified;
}

export function hiddenTools(
  tools: readonly ConnectionTool[],
  connectionDefault?: ConnectionDefault,
): string[] {
  return tools
    .filter((tool) => toolMode(tool, connectionDefault) === "hidden")
    .map((tool) => tool.name);
}

export function toolCounts(
  tools: readonly ConnectionTool[],
  connectionDefault?: ConnectionDefault,
): {
  read: number;
  write: number;
  auto: number;
  ask: number;
  hidden: number;
} {
  const mode = (tool: ConnectionTool) => toolMode(tool, connectionDefault);
  const count = (test: (tool: ConnectionTool) => boolean) => tools.filter(test).length;
  return {
    read: count((tool) => tool.readOnly),
    write: count((tool) => !tool.readOnly),
    auto: count((tool) => mode(tool) === "auto"),
    ask: count((tool) => mode(tool) === "ask"),
    hidden: count((tool) => mode(tool) === "hidden"),
  };
}

// Parses the `tools` jsonb column. A bad entry is dropped instead of loading with a guessed mode.
// Rows from before decision 049 stored the computed `mode` of every tool. A stored mode that
// differs from the annotation rule counts as the owner's choice. One that matches it counts as a
// default, so a later connection default reaches that tool.
export function parseTools(value: unknown): ConnectionTool[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): ConnectionTool[] => {
    if (!item || typeof item !== "object") return [];
    const { name, description, readOnly, override, mode } = item as Record<string, unknown>;
    if (typeof name !== "string" || typeof readOnly !== "boolean") return [];
    let chosen: ToolMode | undefined;
    if (mode !== undefined && override === undefined) {
      // A row from before decision 049.
      if (!TOOL_MODES.includes(mode as ToolMode)) return [];
      chosen = mode === defaultMode(readOnly) ? undefined : (mode as ToolMode);
    } else {
      if (override != null && !TOOL_MODES.includes(override as ToolMode)) return [];
      chosen = (override ?? undefined) as ToolMode | undefined;
    }
    return [
      {
        name,
        description: typeof description === "string" ? description : "",
        readOnly,
        ...(chosen ? { override: chosen } : {}),
      },
    ];
  });
}
