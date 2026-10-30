import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import symPersona from "../agent/tools/sym_persona.ts";
import { WORKER_PRINCIPAL } from "../lib/callers.ts";
import { migrations as MIGRATIONS } from "../lib/ledger/migrations.ts";
import { loadPack } from "../lib/pack/load.ts";
import {
  LOADING_MESSAGES,
  loadingMessages,
  PERSONAS,
  personaInstructions,
  personaSource,
} from "../lib/persona.ts";
import {
  changePersona,
  describePersona,
  getStoredPersona,
  PERSONA_OWNER_ONLY,
  personaStatus,
  storedPersonaOrNone,
} from "../lib/persona-setting.ts";
import { parseSymCommand, USAGE } from "../lib/quiet/command.ts";
import { hasDatabase, useLedger } from "./helpers/ledger.ts";

const OWNER = "U0OWNER1";

function packWith(extra: string, files: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sym-persona-set-"));
  writeFileSync(join(dir, "sym.config.yaml"), `owner:\n  slackUserId: ${OWNER}\n${extra}`);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return loadPack(dir);
}

describe("migration 012", () => {
  it("is registered once, after 011", () => {
    const versions = MIGRATIONS.map((m) => m.version);
    expect(versions).toContain("012_settings_updated_by");
    expect(new Set(versions).size).toBe(versions.length);
    expect(versions.indexOf("012_settings_updated_by")).toBeGreaterThan(
      versions.indexOf("011_job_worker_model"),
    );
  });
});

describe("/sym persona parsing", () => {
  it.each([
    ["persona", { type: "persona" }],
    ["PERSONA spicy", { type: "persona", name: "spicy" }],
    ["persona Plain", { type: "persona", name: "plain" }],
    ["persona casual", { type: "persona", name: "casual" }],
  ])("reads %j", (text, expected) => {
    expect(parseSymCommand(text)).toEqual(expected);
  });

  it.each(["persona grumpy", "persona spicy now", "persona off"])("rejects %j", (text) => {
    expect(parseSymCommand(text)).toEqual({ type: "usage" });
  });

  it("is in the usage text", () => {
    expect(USAGE).toContain("/sym persona");
  });
});

describe("resolution order", () => {
  const pack = packWith("persona: personas/dry.md\n", {
    "personas/dry.md": "# Persona: dry\n\nBe dry.\n",
  });

  it("uses pack, then Slack setting, then env, then casual", () => {
    expect(personaInstructions({ pack, stored: "spicy", env: "plain" })).toBe(
      "# Persona: dry\n\nBe dry.",
    );
    expect(personaInstructions({ stored: "spicy", env: "plain" })).toContain("# Persona: spicy");
    expect(personaInstructions({ env: "plain" })).toContain("# Persona: plain");
    expect(personaInstructions({})).toContain("# Persona: casual");
  });

  it("names the source", () => {
    expect(personaSource({ pack, stored: "spicy", env: "plain" })).toBe("pack");
    expect(personaSource({ stored: "spicy", env: "plain" })).toBe("slack");
    expect(personaSource({ env: "plain" })).toBe("env");
    expect(personaSource({})).toBe("default");
  });

  it("describes the current persona and the choices", () => {
    const text = describePersona(personaStatus(undefined, "spicy", "plain"));
    expect(text).toContain("`spicy`");
    expect(text).toContain("Set from Slack");
    for (const name of PERSONAS) expect(text).toContain(`\`${name}\``);
    expect(describePersona(personaStatus(pack, "spicy", undefined))).toContain("pack");
  });
});

describe("changePersona", () => {
  const sqlThatMustNotRun = new Proxy(
    {},
    {
      apply() {
        throw new Error("database used");
      },
    },
  ) as never;
  const noPack = { SYM_OWNER_SLACK_USER: OWNER };

  it("refuses a user who is not the owner, before any write", async () => {
    const answer = await changePersona({
      sql: sqlThatMustNotRun,
      pack: undefined,
      userId: "U0OTHER",
      name: "spicy",
      env: noPack,
    });
    expect(answer).toBe(PERSONA_OWNER_ONLY);
  });

  it("refuses an unknown caller", async () => {
    const answer = await changePersona({
      sql: sqlThatMustNotRun,
      pack: undefined,
      userId: undefined,
      name: "spicy",
      env: noPack,
    });
    expect(answer).toBe(PERSONA_OWNER_ONLY);
  });

  it("says the pack decides and stores nothing", async () => {
    const pack = packWith("persona: personas/dry.md\n", { "personas/dry.md": "# dry\n" });
    const answer = await changePersona({
      sql: sqlThatMustNotRun,
      pack,
      userId: OWNER,
      name: "spicy",
      env: {},
    });
    expect(answer).toContain("pack");
  });
});

describe("sym_persona tool", () => {
  const saved = process.env.SYM_OWNER_SLACK_USER;
  const savedPack = process.env.SYM_PACK_DIR;
  afterEach(() => {
    if (saved === undefined) delete process.env.SYM_OWNER_SLACK_USER;
    else process.env.SYM_OWNER_SLACK_USER = saved;
    if (savedPack === undefined) delete process.env.SYM_PACK_DIR;
    else process.env.SYM_PACK_DIR = savedPack;
  });
  const run = (principalId: string) =>
    // biome-ignore lint/suspicious/noExplicitAny: a test context with only the fields the tool reads
    (symPersona as any).execute(
      { persona: "spicy" },
      { session: { id: "s1", auth: { current: { principalId } } } },
    );

  it("refuses a non-owner and a worker", async () => {
    process.env.SYM_OWNER_SLACK_USER = OWNER;
    delete process.env.SYM_PACK_DIR;
    expect(await run("slack:T1:U0OTHER")).toBe(PERSONA_OWNER_ONLY);
    expect(await run(WORKER_PRINCIPAL)).not.toContain("Persona set");
  });
});

describe("loading messages", () => {
  it("uses one honest fallback until a real tool step replaces it", () => {
    for (const name of PERSONAS) {
      const list = LOADING_MESSAGES[name];
      expect(list).toEqual(["Working..."]);
      for (const line of list) expect(line.length).toBeLessThanOrEqual(50);
    }
  });

  it("follows the same order as the persona text", () => {
    const pack = packWith("persona: personas/dry.md\n", { "personas/dry.md": "# dry\n" });
    expect(loadingMessages({ stored: "spicy", env: "plain" })).toBe(LOADING_MESSAGES.spicy);
    expect(loadingMessages({ env: "plain" })).toBe(LOADING_MESSAGES.plain);
    expect(loadingMessages({})).toBe(LOADING_MESSAGES.casual);
    expect(loadingMessages({ pack, stored: "spicy" })).toBe(LOADING_MESSAGES.plain);
  });
});

describe("storedPersonaOrNone", () => {
  it("fails open with one warning", async () => {
    const warn = vi.fn();
    const result = await storedPersonaOrNone(() => {
      throw new Error("no database");
    }, warn);
    expect(result).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe.skipIf(!hasDatabase)("persona setting in the ledger", () => {
  const ledger = useLedger();
  const env = { SYM_OWNER_SLACK_USER: OWNER };

  it("starts empty and takes the 012 column", async () => {
    expect(await getStoredPersona(ledger.sql())).toBeUndefined();
    const columns = await ledger.sql()`
      select column_name from information_schema.columns
      where table_schema = current_schema() and table_name = 'settings'`;
    expect(columns.map((c) => c.columnName)).toContain("updated_by");
  });

  it("stores the owner's choice and replaces it", async () => {
    const sql = ledger.sql();
    const set = (name: "plain" | "spicy") =>
      changePersona({ sql, pack: undefined, userId: OWNER, name, env });
    expect(await set("spicy")).toContain("`spicy`");
    expect(await getStoredPersona(sql)).toBe("spicy");
    await set("plain");
    expect(await getStoredPersona(sql)).toBe("plain");
    const [row] = await sql`select updated_by from settings where key = 'persona'`;
    expect(row?.updatedBy).toBe(OWNER);
  });

  it("does not store for a non-owner or under a pack persona", async () => {
    const sql = ledger.sql();
    await sql`delete from settings where key = 'persona'`;
    await changePersona({ sql, pack: undefined, userId: "U0OTHER", name: "spicy", env });
    const pack = packWith("persona: personas/dry.md\n", { "personas/dry.md": "# dry\n" });
    await changePersona({ sql, pack, userId: OWNER, name: "spicy", env });
    expect(await getStoredPersona(sql)).toBeUndefined();
  });

  it("ignores an unknown stored value", async () => {
    const sql = ledger.sql();
    await sql`
      insert into settings (key, value) values ('persona', 'grumpy')
      on conflict (key) do update set value = 'grumpy'`;
    expect(await getStoredPersona(sql)).toBeUndefined();
  });
});
