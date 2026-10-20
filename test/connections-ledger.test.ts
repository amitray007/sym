import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { relistTools } from "../lib/connections/add.ts";
import { connectionToken } from "../lib/connections/auth.ts";
import {
  getConnectionCredential,
  saveConnectionCredential,
  signInStates,
  usableAccessToken,
} from "../lib/connections/credentials.ts";
import { connectionDefinitions } from "../lib/connections/load.ts";
import { probeServer } from "../lib/connections/probe.ts";
import {
  activateConnection,
  activeConnections,
  disableConnection,
  getConnection,
  listConnections,
  type NewConnection,
  proposeConnection,
  saveTools,
  setToolMode,
} from "../lib/connections/rows.ts";
import { recordTools } from "../lib/connections/tools.ts";
import { beginSignIn, clientOf, finishSignIn, newState, readRedirect } from "../lib/oauth.ts";
import { type FakeMcp, startFakeMcp } from "./fakes/mcp-server.ts";
import { hasDatabase, useLedger } from "./helpers/ledger.ts";

// Connection rows, stored sign-ins, and the OAuth flow end to end against the fake server
// (decision 045). Needs Postgres.

const proposal = (overrides: Partial<NewConnection> = {}): NewConnection => ({
  name: "example-tracker",
  url: "https://mcp.example.com/mcp",
  description: "Issues.",
  authKind: "none",
  envVar: null,
  tools: recordTools([
    { name: "list_items", annotations: { readOnlyHint: true } },
    { name: "create_item" },
  ]),
  createdBy: "UOWNER",
  ...overrides,
});

describe.skipIf(!hasDatabase)("connection rows", () => {
  const ledger = useLedger();
  const now = new Date("2026-10-20T12:00:00Z");

  it("proposes, activates, and refuses to replace an active connection", async () => {
    const sql = ledger.sql();
    const first = await proposeConnection(sql, proposal());
    if (!first.ok) throw new Error(first.reason);
    expect(first.row).toMatchObject({ status: "proposed", authKind: "none", approvedAt: null });
    expect(await activeConnections(sql)).toEqual([]);

    // A second proposal replaces the first with a new row.
    const second = await proposeConnection(sql, proposal({ url: "https://mcp2.example.com/mcp" }));
    if (!second.ok) throw new Error(second.reason);
    expect(second.row.id).not.toBe(first.row.id);

    const active = await activateConnection(sql, second.row.id, "UOWNER", now);
    expect(active).toMatchObject({ status: "active", approvedBy: "UOWNER", approvedAt: now });
    expect(await activateConnection(sql, second.row.id, "UOWNER", now)).toBeUndefined();
    expect((await activeConnections(sql)).map((row) => row.name)).toEqual(["example-tracker"]);

    const again = await proposeConnection(sql, proposal());
    expect(again).toEqual({
      ok: false,
      reason: '"example-tracker" is already connected. Remove it first to connect it again.',
    });
  });

  it("sets a tool mode only for a known tool", async () => {
    const sql = ledger.sql();
    const row = await getConnection(sql, "example-tracker");
    if (!row) throw new Error("no row");
    const changed = await setToolMode(sql, row.id, "create_item", "hidden");
    expect(changed?.tools.find((tool) => tool.name === "create_item")?.mode).toBe("hidden");
    expect(await setToolMode(sql, row.id, "nope", "auto")).toBeUndefined();
  });

  it("refuses an env var outside SYM_MCP_*_TOKEN in the database too", async () => {
    const sql = ledger.sql();
    await expect(
      proposeConnection(
        sql,
        proposal({ name: "sneaky", authKind: "env", envVar: "SLACK_BOT_TOKEN" }),
      ),
    ).rejects.toThrow();
    await expect(proposeConnection(sql, proposal({ name: "Bad_Name" }))).rejects.toThrow();
  });

  it("removes a connection and deletes its stored sign-in", async () => {
    const sql = ledger.sql();
    const saved = await proposeConnection(sql, proposal({ name: "crm", authKind: "oauth" }));
    if (!saved.ok) throw new Error(saved.reason);
    await activateConnection(sql, saved.row.id, "UOWNER", now);
    await saveConnectionCredential(sql, {
      connectionId: saved.row.id,
      token: { accessToken: "a-secret", refreshToken: "r-secret", expiresAt: null },
      oauthClient: {
        mcpUrl: saved.row.url,
        authorizationServerUrl: "https://auth.example.com",
        clientInformation: { client_id: "c1" },
      },
      approvedBy: "UOWNER",
    });
    expect((await signInStates(sql, [saved.row.id], now)).get(saved.row.id)).toBe("valid");

    const removed = await disableConnection(sql, "crm");
    expect(removed?.status).toBe("disabled");
    expect(await getConnectionCredential(sql, saved.row.id)).toBeUndefined();
    expect(await disableConnection(sql, "crm")).toBeUndefined();
    const listed = await listConnections(sql);
    expect(listed.at(-1)?.name).toBe("crm");
    // A disabled connection can be added again.
    expect((await proposeConnection(sql, proposal({ name: "crm" }))).ok).toBe(true);
  });
});

describe.skipIf(!hasDatabase)("OAuth connection sign-in against the fake server", () => {
  const ledger = useLedger();
  let server: FakeMcp;
  const redirectUrl = "http://127.0.0.1:9/.well-known/workflow/v1/webhook/tok";

  beforeAll(async () => {
    // 30-second tokens are inside the refresh margin, so every read refreshes first.
    server = await startFakeMcp({ mode: "oauth", tokenSeconds: 30 });
  });
  afterAll(() => server.close());

  async function signIn(connectionId: number) {
    const start = await beginSignIn({ mcpUrl: server.url, redirectUrl, state: newState() });
    const authorization = new URL(start.authorizationUrl);
    // The scopes come from the server's protected-resource metadata.
    expect(authorization.searchParams.get("scope")).toBe("items:read items:write");
    const response = await fetch(start.authorizationUrl, { redirect: "manual" });
    const location = new URL(response.headers.get("location") ?? "");
    const redirect = readRedirect(location.searchParams, start, '"crm"');
    if (redirect.kind !== "code") throw new Error(`no code: ${redirect.kind}`);
    const token = await finishSignIn(start, redirect);
    expect(token.refreshToken).not.toBeNull();
    await saveConnectionCredential(ledger.sql(), {
      connectionId,
      token,
      oauthClient: clientOf(start),
      approvedBy: "UOWNER",
    });
    return token;
  }

  it("signs in, refreshes an expiring token, and the token works on the MCP endpoint", async () => {
    const sql = ledger.sql();
    const saved = await proposeConnection(
      sql,
      proposal({ name: "crm", url: server.url, authKind: "oauth", tools: [] }),
    );
    if (!saved.ok) throw new Error(saved.reason);
    const row = await activateConnection(sql, saved.row.id, "UOWNER", new Date());
    if (!row) throw new Error("not active");

    // Before the sign-in the connection does not load.
    const before = connectionDefinitions([row], {
      env: {},
      signIns: await signInStates(sql, [row.id], new Date()),
      token: (item) => connectionToken(sql, item),
      response: () => ({ status: "allowed" }),
    });
    expect(before).toEqual({});

    const first = await signIn(row.id);
    expect((await signInStates(sql, [row.id], new Date())).get(row.id)).toBe("refreshable");

    const fresh = await connectionToken(sql, row);
    expect(server.refreshes).toBe(1);
    expect(fresh?.token).not.toBe(first.accessToken);
    expect(fresh?.token).toBe(server.issued.at(-1));
    const stored = await getConnectionCredential(sql, row.id);
    expect(stored?.accessToken).toBe(fresh?.token);
    expect(stored?.refreshToken).not.toBe(first.refreshToken);

    // The old token no longer works; the new one lists the tools.
    expect((await probeServer(server.url, { token: first.accessToken })).kind).toBe("unauthorized");
    const listed = await relistTools(server.url, fresh?.token, row.tools, probeServer);
    if (!listed.ok) throw new Error(listed.reason);
    const withTools = await saveTools(sql, row.id, listed.tools);
    expect(withTools?.tools.map((tool) => [tool.name, tool.mode])).toEqual([
      ["list_items", "auto"],
      ["create_item", "ask"],
      ["delete_item", "ask"],
    ]);

    // Now the connection loads, and its getToken refreshes again on the next call.
    const after = connectionDefinitions(withTools ? [withTools] : [], {
      env: {},
      signIns: await signInStates(sql, [row.id], new Date()),
      token: (item) => connectionToken(sql, item),
      response: () => ({ status: "allowed" }),
    });
    const auth = after.crm?.auth as {
      getToken: () => Promise<{ token: string; expiresAt?: number }>;
    };
    const viaEve = await auth.getToken();
    expect(viaEve.token).toBe(server.issued.at(-1));
    expect(viaEve.expiresAt).toBeGreaterThan(Date.now());
    expect(server.refreshes).toBe(2);
  });

  it("two refreshes at once take turns, so a rotated refresh token is used once", async () => {
    const sql = ledger.sql();
    const row = await getConnection(sql, "crm");
    if (!row) throw new Error("no row");
    const before = server.refreshes;
    let calls = 0;
    const refresh = async (_client: unknown, refreshToken: string) => {
      calls++;
      return {
        accessToken: `local-${calls}`,
        refreshToken,
        expiresAt: new Date(Date.now() + 3_600_000),
      };
    };
    const [a, b] = await Promise.all([
      usableAccessToken(sql, row.id, refresh),
      usableAccessToken(sql, row.id, refresh),
    ]);
    expect(calls).toBe(1);
    expect(a?.token).toBe("local-1");
    expect(b?.token).toBe("local-1");
    expect(server.refreshes).toBe(before);
  });

  it("treats an expired sign-in without a refresh token as gone", async () => {
    const sql = ledger.sql();
    const row = await getConnection(sql, "crm");
    if (!row) throw new Error("no row");
    await saveConnectionCredential(sql, {
      connectionId: row.id,
      token: { accessToken: "old", refreshToken: null, expiresAt: new Date(Date.now() - 1000) },
      oauthClient: {
        mcpUrl: server.url,
        authorizationServerUrl: server.issuer,
        clientInformation: { client_id: "x" },
      },
      approvedBy: "UOWNER",
    });
    expect(await connectionToken(sql, row)).toBeUndefined();
    expect((await signInStates(sql, [row.id], new Date())).get(row.id)).toBe("expired");
  });
});
