import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WORKER_PRINCIPAL } from "../lib/callers.ts";
import { loadPack } from "../lib/pack/load.ts";
import {
  DEFAULT_PERSONA,
  PERSONAS,
  personaInstructions,
  personaName,
  readBuiltinPersona,
} from "../lib/persona.ts";

const BASE = `
owner:
  slackUserId: U0OWNER1
`;

function packWith(extra: string, files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "sym-persona-"));
  writeFileSync(join(dir, "sym.config.yaml"), `${BASE}${extra}`);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return loadPack(dir);
}

describe("personaName", () => {
  it("defaults to casual", () => {
    expect(personaName(undefined)).toBe("casual");
    expect(personaName("  ")).toBe(DEFAULT_PERSONA);
  });

  it("accepts each built-in name in any case", () => {
    expect(personaName("PLAIN")).toBe("plain");
    expect(personaName(" spicy ")).toBe("spicy");
  });

  it("warns on an unknown value and uses casual", () => {
    const warn = vi.fn();
    expect(personaName("grumpy", warn)).toBe("casual");
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toContain("grumpy");
  });
});

describe("built-in persona files", () => {
  it.each(PERSONAS)("%s is short and model-neutral", (name) => {
    const text = readBuiltinPersona(name);
    expect(text.split("\n").length).toBeLessThan(40);
    expect(text).toContain(`# Persona: ${name}`);
    expect(text).not.toMatch(/claude|gpt|gemini|sonnet|opus|kimi|llama/i);
  });

  it("spicy states its hard limits", () => {
    const text = readBuiltinPersona("spicy");
    expect(text).toContain("Never joke about failures, incidents, data loss, security, health");
    expect(text).toContain("No jokes in briefs, approvals, permission DMs, sign-in, or errors");
    expect(text).toContain("Drop the jokes entirely when the person seems stressed");
  });
});

describe("personaInstructions", () => {
  it("loads the persona named by the environment", () => {
    expect(personaInstructions({ env: "plain" })).toContain("# Persona: plain");
    expect(personaInstructions({ env: "spicy" })).toContain("# Persona: spicy");
  });

  it("uses casual without a value or with an unknown one", () => {
    const warn = vi.fn();
    expect(personaInstructions({})).toContain("# Persona: casual");
    expect(personaInstructions({ env: "nope", warn })).toContain("# Persona: casual");
    expect(warn).toHaveBeenCalledOnce();
  });

  it("lets the pack persona win over the environment", () => {
    const pack = packWith("persona: personas/dry.md\n", {
      "personas/dry.md": "# Persona: dry\n\nBe dry.\n",
    });
    expect(personaInstructions({ env: "spicy", pack })).toBe("# Persona: dry\n\nBe dry.");
  });

  it("falls back to the environment when the pack has no persona", () => {
    const pack = packWith("", {});
    expect(personaInstructions({ env: "plain", pack })).toContain("# Persona: plain");
  });
});

describe("pack persona file", () => {
  it("must be a Markdown file", () => {
    expect(() => packWith("persona: personas/dry.txt\n", { "personas/dry.txt": "x" })).toThrow(
      /persona/,
    );
  });

  it("must stay inside the pack", () => {
    expect(() => packWith("persona: ../outside.md\n", {})).toThrow(/outside the pack folder/);
  });

  it("must exist", () => {
    expect(() => packWith("persona: personas/missing.md\n", {})).toThrow(/Cannot read/);
  });
});

describe("the persona instruction", () => {
  // A memo that always runs, as on a session's first evaluation.
  const ctx = (principalId: string) =>
    ({
      session: { id: "s1", auth: { current: { principalId } } },
      memo: (_key: unknown, fn: () => unknown) => fn(),
    }) as never;
  // defineDynamic keeps the function under a symbol key.
  const handler = async () => {
    const mod = (await import("../agent/instructions/persona.ts")).default as object;
    const run = Object.getOwnPropertySymbols(mod)
      .map((key) => (mod as Record<symbol, unknown>)[key])
      .find((value) => typeof value === "function") as
      | ((ctx: never) => Promise<{ content?: string } | null>)
      | undefined;
    if (!run) throw new Error("no dynamic function");
    return run;
  };

  it("gives a Slack caller the persona", async () => {
    vi.stubEnv("SYM_PERSONA", "spicy");
    const run = await handler();
    const out = await run(ctx("slack:T1:U1"));
    expect(JSON.stringify(out)).toContain("# Persona: spicy");
    vi.unstubAllEnvs();
  });

  it("gives a worker caller nothing", async () => {
    vi.stubEnv("SYM_PERSONA", "spicy");
    const run = await handler();
    expect(await run(ctx(WORKER_PRINCIPAL))).toBeNull();
    vi.unstubAllEnvs();
  });
});
