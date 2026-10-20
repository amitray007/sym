import type { Sql } from "../db.ts";
import { json } from "../ledger/jobs.ts";
import { type ConnectionDefault, type ConnectionTool, parseTools, type ToolMode } from "./tools.ts";

// Connection rows (decision 045). The owner adds an MCP server from Slack. The row starts as
// `proposed`, turns `active` when the owner approves it, and turns `disabled` when the owner
// removes it. Only active rows load into a turn (agent/connections/rows.ts).

export type AuthKind = "none" | "env" | "oauth";
export type ConnectionStatus = "proposed" | "active" | "disabled";

export interface Connection {
  id: number;
  name: string;
  url: string;
  description: string;
  authKind: AuthKind;
  envVar: string | null;
  status: ConnectionStatus;
  tools: ConnectionTool[];
  // The mode for tools the owner did not set one by one. Null keeps the annotation rule.
  defaultMode: ConnectionDefault;
  // What the server said in its `initialize` result. Untrusted text, already cleaned.
  serverInstructions: string | null;
  createdBy: string | null;
  approvedBy: string | null;
  approvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewConnection {
  name: string;
  url: string;
  description: string;
  authKind: AuthKind;
  envVar: string | null;
  tools: ConnectionTool[];
  serverInstructions: string | null;
  createdBy: string | null;
}

const normalize = (row: Connection): Connection => ({
  ...row,
  defaultMode: row.defaultMode ?? null,
  id: Number(row.id),
  tools: parseTools(row.tools),
});

export type ProposeResult = { ok: true; row: Connection } | { ok: false; reason: string };

// Saves a proposal. A proposed or disabled row of the same name is replaced by a new row, so
// the new one gets a new ID and Eve treats it as a new connection. An active row is refused:
// the owner removes it first.
export async function proposeConnection(sql: Sql, input: NewConnection): Promise<ProposeResult> {
  return sql.begin(async (tx) => {
    const [existing] = await tx<{ status: ConnectionStatus }[]>`
      select status from connections where name = ${input.name} for update
    `;
    if (existing?.status === "active") {
      return {
        ok: false as const,
        reason: `"${input.name}" is already connected. Remove it first to connect it again.`,
      };
    }
    if (existing) await tx`delete from connections where name = ${input.name}`;
    const [row] = await tx<Connection[]>`
      insert into connections (name, url, description, auth_kind, env_var, tools, server_instructions, created_by)
      values (
        ${input.name}, ${input.url}, ${input.description}, ${input.authKind}, ${input.envVar},
        ${json(sql, input.tools)}, ${input.serverInstructions}, ${input.createdBy}
      )
      returning *
    `;
    if (!row) throw new Error("insert into connections returned no row");
    return { ok: true as const, row: normalize(row) };
  });
}

export async function getConnection(sql: Sql, name: string): Promise<Connection | undefined> {
  const [row] = await sql<Connection[]>`select * from connections where name = ${name}`;
  return row && normalize(row);
}

// All rows, disabled ones last.
export async function listConnections(sql: Sql): Promise<Connection[]> {
  const rows = await sql<Connection[]>`
    select * from connections order by (status = 'disabled'), name limit 100
  `;
  return rows.map(normalize);
}

export async function activeConnections(sql: Sql): Promise<Connection[]> {
  const rows = await sql<Connection[]>`
    select * from connections where status = 'active' order by name limit 50
  `;
  return rows.map(normalize);
}

// Turns a proposal active. Undefined when the row is no longer a proposal.
export async function activateConnection(
  sql: Sql,
  id: number,
  approvedBy: string | null,
  now: Date,
): Promise<Connection | undefined> {
  const [row] = await sql<Connection[]>`
    update connections
    set status = 'active', approved_by = ${approvedBy}, approved_at = ${now}, updated_at = ${now}
    where id = ${id} and status = 'proposed'
    returning *
  `;
  return row && normalize(row);
}

// Replaces the recorded tools, for example after a sign-in lists them for the first time. A
// listing also brings the server's instructions: pass them (null when the server sent none) to
// replace the stored text, or leave them out to keep it.
export async function saveTools(
  sql: Sql,
  id: number,
  tools: ConnectionTool[],
  instructions?: string | null,
): Promise<Connection | undefined> {
  const [row] = await sql<Connection[]>`
    update connections
    set tools = ${json(sql, tools)},
        server_instructions = case when ${instructions !== undefined}
          then ${instructions ?? null}::text else server_instructions end,
        updated_at = now()
    where id = ${id}
    returning *
  `;
  return row && normalize(row);
}

// Sets one tool's own mode, or clears it with null so the tool follows the connection default.
// Undefined when the row or the tool does not exist.
export async function setToolMode(
  sql: Sql,
  id: number,
  tool: string,
  mode: ToolMode | null,
): Promise<Connection | undefined> {
  return sql.begin(async (tx) => {
    const [row] = await tx<Connection[]>`select * from connections where id = ${id} for update`;
    if (!row) return undefined;
    const tools = parseTools(row.tools);
    const target = tools.find((item) => item.name === tool);
    if (!target) return undefined;
    if (mode) target.override = mode;
    else delete target.override;
    const [saved] = await tx<Connection[]>`
      update connections set tools = ${json(sql, tools)}, updated_at = now()
      where id = ${id}
      returning *
    `;
    return saved && normalize(saved);
  });
}

// Sets the connection-wide default mode (null keeps the annotation rule). It reaches every tool
// without its own mode, listed now or later.
export async function setDefaultMode(
  sql: Sql,
  id: number,
  mode: ConnectionDefault,
): Promise<Connection | undefined> {
  const [row] = await sql<Connection[]>`
    update connections set default_mode = ${mode}, updated_at = now()
    where id = ${id}
    returning *
  `;
  return row && normalize(row);
}

// Disables the row and deletes its stored sign-in in one transaction.
export async function disableConnection(sql: Sql, name: string): Promise<Connection | undefined> {
  return sql.begin(async (tx) => {
    const [row] = await tx<Connection[]>`
      update connections set status = 'disabled', updated_at = now()
      where name = ${name} and status <> 'disabled'
      returning *
    `;
    if (!row) return undefined;
    await tx`delete from connection_credentials where connection_id = ${row.id}`;
    return normalize(row);
  });
}
