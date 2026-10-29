import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import persona from "../agent/instructions/persona.ts";
import { WORKER_PRINCIPAL } from "../lib/callers.ts";
import { PERSONAS, readBuiltinPersona } from "../lib/persona.ts";

const sources = vi.hoisted(() => ({
  stored: vi.fn<() => Promise<"plain" | "casual" | "spicy" | undefined>>(),
  pack: vi.fn(),
}));
vi.mock("../lib/persona-setting.ts", () => ({ storedPersonaOrNone: sources.stored }));
vi.mock("../lib/runtime.ts", () => ({ ledger: vi.fn(), pack: sources.pack }));

// Exercise the same resolver Eve evaluates, including its session memo and worker exclusion.
const resolve = Object.getOwnPropertySymbols(persona)
  .map((key) => (persona as unknown as Record<symbol, unknown>)[key])
  .find((value) => typeof value === "function") as (
  ctx: unknown,
) => Promise<{ content: string } | null>;

function context(principalId = "slack:T1:UOWNER1", sessionId = "s1") {
  const cache = new Map<unknown, unknown>();
  return {
    session: { id: sessionId, auth: { current: { principalId } } },
    memo(key: unknown, load: () => unknown) {
      if (!cache.has(key)) cache.set(key, load());
      return cache.get(key);
    },
  };
}

beforeEach(() => {
  sources.stored.mockReset().mockResolvedValue(undefined);
  sources.pack.mockReset().mockReturnValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe("persona instruction loading", () => {
  it.each(PERSONAS)("loads the %s file for a Slack caller", async (name) => {
    vi.stubEnv("SYM_PERSONA", name);
    expect(await resolve(context())).toMatchObject({ content: readBuiltinPersona(name).trim() });
    expect(sources.stored).toHaveBeenCalledOnce();
  });

  it("defaults to casual", async () => {
    vi.stubEnv("SYM_PERSONA", "");
    expect(await resolve(context())).toMatchObject({
      content: readBuiltinPersona("casual").trim(),
    });
  });

  it("keeps one voice per session and picks up a setting in the next session", async () => {
    vi.stubEnv("SYM_PERSONA", "plain");
    sources.stored.mockResolvedValue("casual");
    const current = context();
    const first = await resolve(current);
    sources.stored.mockResolvedValue("spicy");
    expect(await resolve(current)).toEqual(first);
    expect(sources.stored).toHaveBeenCalledOnce();
    expect(await resolve(context("slack:T1:UOWNER1", "s2"))).toMatchObject({
      content: readBuiltinPersona("spicy").trim(),
    });
    expect(sources.stored).toHaveBeenCalledTimes(2);
  });

  it("loads the pack voice ahead of stored and environment voices", async () => {
    vi.stubEnv("SYM_PERSONA", "plain");
    sources.stored.mockResolvedValue("spicy");
    sources.pack.mockReturnValue({ persona: { content: "  A custom colleague voice.\n" } });
    expect(await resolve(context())).toMatchObject({ content: "A custom colleague voice." });
  });

  it("skips worker callers before reading settings or the pack", async () => {
    expect(await resolve(context(WORKER_PRINCIPAL))).toBeNull();
    expect(sources.stored).not.toHaveBeenCalled();
    expect(sources.pack).not.toHaveBeenCalled();
  });

  it("adds nothing when loading fails, leaving the base rules in place", async () => {
    sources.stored.mockRejectedValue(new Error("unavailable"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await resolve(context())).toBeNull();
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });
});
