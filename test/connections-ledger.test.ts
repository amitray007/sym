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
import { tokenEnvVar } from "../lib/connections/names.ts";
import { probeServer } from "../lib/connections/probe.ts";
import { refreshStale } from "../lib/connections/refresh.ts";
import {
  activateConnection,
  activeConnections,
  type Connection,
  disableConnection,
  getConnection,
  listConnections,
  type NewConnection,
  proposeConnection,
  saveTools,
  setDefaultMode,
  setToolMode,
} from "../lib/connections/rows.ts";
import { recordTools, toolMode } from "../lib/connections/tools.ts";
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
  serverInstructions: null,
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
    expect(changed?.tools.find((tool) => tool.name === "create_item")?.override).toBe("hidden");
    expect(await setToolMode(sql, row.id, "nope", "auto")).toBeUndefined();
  });

  it("sets and clears the connection default, and an own mode wins and can be cleared", async () => {
    const sql = ledger.sql();
    const saved = await proposeConnection(sql, proposal({ name: "example-gateway" }));
    if (!saved.ok) throw new Error(saved.reason);
    const id = saved.row.id;
    expect(saved.row.defaultMode).toBeNull();
    await activateConnection(sql, id, "UOWNER", now);

    const modeOf = (row: Connection | undefined, name: string) => {
      const found = row?.tools.find((item) => item.name === name);
      return found ? toolMode(found, row?.defaultMode ?? null) : undefined;
    };
    const wide = await setDefaultMode(sql, id, "auto");
    expect(wide?.defaultMode).toBe("auto");
    expect(modeOf(wide, "create_item")).toBe("auto");
    expect(modeOf(wide, "list_items")).toBe("auto");

    // An own mode wins over the default, and changing the default leaves it alone.
    await setToolMode(sql, id, "create_item", "ask");
    const hidden = await setDefaultMode(sql, id, "hidden");
    expect(modeOf(hidden, "create_item")).toBe("ask");
    expect(modeOf(hidden, "list_items")).toBe("hidden");

    // Clearing the own mode returns the tool to the default.
    const cleared = await setToolMode(sql, id, "create_item", null);
    expect(cleared?.tools.find((item) => item.name === "create_item")?.override).toBeUndefined();
    expect(modeOf(cleared, "create_item")).toBe("hidden");

    const none = await setDefaultMode(sql, id, null);
    expect(none?.defaultMode).toBeNull();
    expect(modeOf(none, "create_item")).toBe("ask");
    expect(modeOf(none, "list_items")).toBe("auto");
    expect(await setDefaultMode(sql, id + 9999, "auto")).toBeUndefined();
    await expect(
      sql`update connections set default_mode = 'sometimes' where id = ${id}`,
    ).rejects.toThrow();
  });

  it("keeps a connection default and own modes through a relist", async () => {
    const sql = ledger.sql();
    const row = await getConnection(sql, "example-gateway");
    if (!row) throw new Error("no row");
    await setDefaultMode(sql, row.id, "auto");
    await setToolMode(sql, row.id, "create_item", "hidden");
    const again = await saveTools(
      sql,
      row.id,
      recordTools(
        [{ name: "list_items" }, { name: "create_item" }, { name: "added_later" }],
        (await getConnection(sql, "example-gateway"))?.tools ?? [],
      ),
    );
    expect(again?.defaultMode).toBe("auto");
    const modes = again?.tools.map((item) => [item.name, toolMode(item, again.defaultMode)]);
    expect(modes).toEqual([
      ["list_items", "auto"],
      ["create_item", "hidden"],
      ["added_later", "auto"],
    ]);
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
    server = await startFakeMcp({
      mode: "oauth",
      tokenSeconds: 30,
      instructions: "Call search first.\u0007 Then execute.",
    });
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
    expect(listed.instructions).toBe("Call search first. Then execute.");
    const withTools = await saveTools(sql, row.id, listed.tools, listed.instructions);
    expect(withTools?.serverInstructions).toBe("Call search first. Then execute.");
    expect(withTools?.tools.map((tool) => [tool.name, toolMode(tool, null)])).toEqual([
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

describe.skipIf(!hasDatabase)("server instructions in the ledger", () => {
  const ledger = useLedger();
  let server: FakeMcp;
  const TEXT = "Use search to find an operation, then execute to run it.";

  beforeAll(async () => {
    server = await startFakeMcp({ mode: "token", token: "fake-static", instructions: TEXT });
  });
  afterAll(() => server.close());

  async function activeEnvRow(name: string, tools = proposal().tools) {
    const sql = ledger.sql();
    const saved = await proposeConnection(
      sql,
      proposal({
        name,
        url: server.url,
        authKind: "env",
        envVar: tokenEnvVar(name),
        tools,
      }),
    );
    if (!saved.ok) throw new Error(saved.reason);
    const row = await activateConnection(sql, saved.row.id, "UOWNER", new Date());
    if (!row) throw new Error("not active");
    return row;
  }

  it("stores the instructions with the proposal and keeps them when only tools are saved", async () => {
    const sql = ledger.sql();
    const saved = await proposeConnection(sql, proposal({ serverInstructions: TEXT }));
    if (!saved.ok) throw new Error(saved.reason);
    expect(saved.row.serverInstructions).toBe(TEXT);
    const kept = await saveTools(sql, saved.row.id, saved.row.tools);
    expect(kept?.serverInstructions).toBe(TEXT);
    const cleared = await saveTools(sql, saved.row.id, saved.row.tools, null);
    expect(cleared?.serverInstructions).toBeNull();
  });

  it("refuses more than 4000 characters in the database too", async () => {
    await expect(
      proposeConnection(ledger.sql(), proposal({ serverInstructions: "x".repeat(4001) })),
    ).rejects.toThrow();
  });

  it("loads the instructions of a token server once the token is there", async () => {
    const sql = ledger.sql();
    const row = await activeEnvRow("docs", []);
    expect(row.tools).toEqual([]);
    expect(row.serverInstructions).toBeNull();
    const attempts = new Map<number, number>();
    const probes: (string | undefined)[] = [];
    const deps = (token: string | undefined, now: Date) => ({
      sql,
      probe: (url: string, options?: { token?: string }) => {
        probes.push(options?.token);
        return probeServer(url, options);
      },
      token: async () => (token ? { token } : undefined),
      attempts,
      now,
    });
    const t0 = new Date("2026-10-20T12:00:00Z");

    // No token yet: nothing is probed and nothing is remembered.
    expect(await refreshStale([row], deps(undefined, t0))).toEqual([row]);
    expect(probes).toEqual([]);

    // The token arrived: tools and instructions load.
    const [fresh] = await refreshStale([row], deps("fake-static", t0));
    expect(fresh?.serverInstructions).toBe(TEXT);
    expect(fresh?.tools.map((tool) => tool.name)).toEqual([
      "list_items",
      "create_item",
      "delete_item",
    ]);
    expect((await getConnection(sql, "docs"))?.serverInstructions).toBe(TEXT);
    expect(probes).toEqual(["fake-static"]);

    // A row that is complete is not probed again.
    await refreshStale(fresh ? [fresh] : [], deps("fake-static", t0));
    expect(probes).toHaveLength(1);
  });

  it("probes a row without instructions at most once per six hours", async () => {
    const sql = ledger.sql();
    const quiet = await startFakeMcp({ mode: "open" });
    try {
      const saved = await proposeConnection(
        sql,
        proposal({ name: "quiet", url: quiet.url, serverInstructions: null }),
      );
      if (!saved.ok) throw new Error(saved.reason);
      const row = await activateConnection(sql, saved.row.id, "UOWNER", new Date());
      if (!row) throw new Error("not active");
      let probes = 0;
      const attempts = new Map<number, number>();
      const run = (now: Date) =>
        refreshStale([row], {
          sql,
          probe: (url, options) => {
            probes++;
            return probeServer(url, options);
          },
          token: async () => undefined,
          attempts,
          now,
        });
      const t0 = new Date("2026-10-20T12:00:00Z");
      await run(t0);
      await run(new Date(t0.getTime() + 60 * 60 * 1000));
      expect(probes).toBe(1);
      await run(new Date(t0.getTime() + 7 * 60 * 60 * 1000));
      expect(probes).toBe(2);
    } finally {
      await quiet.close();
    }
  });

  it("keeps the stored row when the server is down", async () => {
    const sql = ledger.sql();
    const saved = await proposeConnection(
      sql,
      proposal({ name: "gone", url: "http://127.0.0.1:9/mcp" }),
    );
    if (!saved.ok) throw new Error(saved.reason);
    const row = await activateConnection(sql, saved.row.id, "UOWNER", new Date());
    if (!row) throw new Error("not active");
    const out = await refreshStale([row], {
      sql,
      probe: probeServer,
      token: async () => undefined,
      attempts: new Map(),
      now: new Date(),
    });
    expect(out).toEqual([row]);
  });
});
