import type { Sql } from "../db.ts";
import { refreshSignIn } from "../oauth.ts";
import { usableAccessToken } from "./credentials.ts";
import { readTokenEnv } from "./names.ts";
import type { Connection } from "./rows.ts";

// The bearer token for a connection (decision 045): the SYM_MCP_<NAME>_TOKEN env var for a
// token connection, the stored sign-in for an OAuth one, refreshed when it is about to expire.
// Undefined when the connection needs no token or has none yet. The token never reaches the
// model or a log.
export async function connectionToken(
  sql: Sql,
  row: Pick<Connection, "id" | "name" | "authKind" | "envVar">,
  env: Record<string, string | undefined> = process.env,
): Promise<{ token: string; expiresAt: Date | null } | undefined> {
  if (row.authKind === "env") {
    const token = row.envVar ? readTokenEnv(row.envVar, env) : undefined;
    return token ? { token, expiresAt: null } : undefined;
  }
  if (row.authKind === "oauth") {
    return usableAccessToken(sql, row.id, (client, refreshToken) =>
      refreshSignIn(client, refreshToken, new Date(), row.name),
    );
  }
  return undefined;
}
