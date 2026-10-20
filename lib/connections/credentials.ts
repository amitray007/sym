import type { Sql } from "../db.ts";
import { json } from "../ledger/jobs.ts";
import type { OAuthClient, SignInToken } from "../oauth.ts";

// OAuth sign-ins for connections (decision 045), stored like the worker sign-in (decision 036):
// Postgres is the source of truth, nothing here logs a token, and every error is rebuilt without
// the query parameters, so a failed write cannot put a token in a log.

export interface ConnectionCredential {
  connectionId: number;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  oauthClient: OAuthClient;
  approvedBy: string | null;
}

// Refresh this long before the expiry, so a token does not run out during a call.
export const REFRESH_EARLY_MS = 60_000;

// Saves a sign-in. A new sign-in replaces the old one for the same connection.
export async function saveConnectionCredential(
  sql: Sql,
  input: {
    connectionId: number;
    token: SignInToken;
    oauthClient: OAuthClient;
    approvedBy: string | null;
  },
): Promise<void> {
  try {
    await sql`
      insert into connection_credentials (
        connection_id, access_token, refresh_token, expires_at, oauth_client, approved_by
      )
      values (
        ${input.connectionId}, ${input.token.accessToken}, ${input.token.refreshToken},
        ${input.token.expiresAt}, ${json(sql, input.oauthClient)}, ${input.approvedBy}
      )
      on conflict (connection_id) do update set
        access_token = excluded.access_token,
        refresh_token = excluded.refresh_token,
        expires_at = excluded.expires_at,
        oauth_client = excluded.oauth_client,
        approved_by = excluded.approved_by,
        updated_at = now()
    `;
  } catch (error) {
    throw safeError("save", error);
  }
}

export async function getConnectionCredential(
  sql: Sql,
  connectionId: number,
): Promise<ConnectionCredential | undefined> {
  try {
    const [row] = await sql<ConnectionCredential[]>`
      select connection_id, access_token, refresh_token, expires_at, oauth_client, approved_by
      from connection_credentials where connection_id = ${connectionId}
    `;
    return row && { ...row, connectionId: Number(row.connectionId) };
  } catch (error) {
    throw safeError("read", error);
  }
}

// What a sign-in can do now, without the token: for lists and for the loader.
export type SignInState = "missing" | "valid" | "refreshable" | "expired";

export function signInState(
  credential: Pick<ConnectionCredential, "expiresAt" | "refreshToken"> | undefined,
  now: Date,
): SignInState {
  if (!credential) return "missing";
  if (!credential.expiresAt || credential.expiresAt.getTime() - REFRESH_EARLY_MS > now.getTime()) {
    return "valid";
  }
  return credential.refreshToken ? "refreshable" : "expired";
}

// Sign-in states for many connections at once.
export async function signInStates(
  sql: Sql,
  ids: readonly number[],
  now: Date,
): Promise<Map<number, SignInState>> {
  if (ids.length === 0) return new Map();
  try {
    const rows = await sql<{ connectionId: number; expiresAt: Date | null; hasRefresh: boolean }[]>`
      select connection_id, expires_at, refresh_token is not null as has_refresh
      from connection_credentials where connection_id in ${sql(ids)}
    `;
    return new Map(
      rows.map((row) => [
        Number(row.connectionId),
        signInState({ expiresAt: row.expiresAt, refreshToken: row.hasRefresh ? "set" : null }, now),
      ]),
    );
  } catch (error) {
    throw safeError("read", error);
  }
}

// Returns a usable access token, refreshing it first when it is about to expire. The row lock
// makes two steps that refresh at once take turns, so a server that rotates refresh tokens
// does not see the old one twice. Undefined when there is no sign-in or it expired for good.
export async function usableAccessToken(
  sql: Sql,
  connectionId: number,
  refresh: (client: OAuthClient, refreshToken: string) => Promise<SignInToken>,
  now: () => Date = () => new Date(),
): Promise<{ token: string; expiresAt: Date | null } | undefined> {
  const current = await getConnectionCredential(sql, connectionId);
  const state = signInState(current, now());
  if (!current || state === "missing" || state === "expired") return undefined;
  if (state === "valid") return { token: current.accessToken, expiresAt: current.expiresAt };

  let rows: ConnectionCredential[];
  try {
    rows = await sql.begin(async (tx) => {
      const [locked] = await tx<ConnectionCredential[]>`
        select connection_id, access_token, refresh_token, expires_at, oauth_client, approved_by
        from connection_credentials where connection_id = ${connectionId} for update
      `;
      if (!locked) return [];
      // Another step refreshed while this one waited for the lock.
      const changed = locked.accessToken !== current.accessToken;
      if (changed || signInState(locked, now()) === "valid" || !locked.refreshToken) {
        return [locked];
      }
      const token = await refresh(locked.oauthClient, locked.refreshToken);
      await tx`
        update connection_credentials set
          access_token = ${token.accessToken},
          refresh_token = ${token.refreshToken},
          expires_at = ${token.expiresAt},
          updated_at = now()
        where connection_id = ${connectionId}
      `;
      return [
        {
          ...locked,
          accessToken: token.accessToken,
          refreshToken: token.refreshToken,
          expiresAt: token.expiresAt,
        },
      ];
    });
  } catch (error) {
    // refresh() builds its messages without secrets. Postgres errors lose their parameters.
    if (error instanceof Error && !("code" in error)) throw error;
    throw safeError("refresh", error);
  }
  const [fresh] = rows;
  // A token shorter-lived than the refresh margin is still good until it really expires.
  if (!fresh || (fresh.expiresAt && fresh.expiresAt.getTime() <= now().getTime())) return undefined;
  return { token: fresh.accessToken, expiresAt: fresh.expiresAt };
}

// A new error with the Postgres error code only. postgres.js errors can carry the query and
// its parameters, and the parameters hold the token.
function safeError(action: "save" | "read" | "refresh", error: unknown): Error {
  const code =
    error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? ` (${error.code})`
      : "";
  return new Error(`Sym could not ${action} the connection sign-in${code}.`);
}
