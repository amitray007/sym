import { describe, expect, it } from "vitest";
import { postgresMemory } from "../lib/memory/provider.ts";
import { hasDatabase, useLedger } from "./helpers/ledger.ts";

const ledger = useLedger();

// Calls the provider the way Eve does: recall with a locked scope, tools bound to that scope.
// biome-ignore lint/suspicious/noExplicitAny: Eve's context types are wider than a test needs.
type Any = any;

function as(scopeKey: string) {
  const provider = postgresMemory({ sql: () => ledger.sql() });
  const memory = { scope: { key: scopeKey, namespace: "ns", value: scopeKey }, slot: "owner" };
  return {
    recall: async () => {
      const result = (await provider.recall["turn.started"]({ memory } as Any)) as Any;
      return result.messages[0] as { id: string; content: string };
    },
    tool: async (name: string, input: unknown) => {
      const tools = (await provider.tools?.({ memory } as Any)) as Any;
      return tools[name].execute(input, {}) as Promise<Any>;
    },
  };
}

describe.skipIf(!hasDatabase)("postgres memory provider", () => {
  it("saves a fact and recalls it with a stable id", async () => {
    const a = as("scope-save");
    const saved = await a.tool("save_memory", { text: "Open PRs as drafts." });
    expect(saved.id).toMatch(/^\d+$/);
    const recalled = await a.recall();
    expect(recalled.id).toBe("facts");
    expect(recalled.content).toContain(`[${saved.id}] Open PRs as drafts.`);
  });

  it("keeps one copy when the same text is saved twice", async () => {
    const a = as("scope-dedupe");
    const one = await a.tool("save_memory", { text: "Prefers  short   replies" });
    const two = await a.tool("save_memory", { text: "Prefers short replies" });
    expect(two.id).toBe(one.id);
    const found = await a.tool("search_memory", { query: "" });
    expect(found.memories).toHaveLength(1);
  });

  it("searches by word and by partial word", async () => {
    const a = as("scope-search");
    await a.tool("save_memory", { text: "Deploys happen on Tuesdays" });
    await a.tool("save_memory", { text: "Likes tabs over spaces" });
    expect((await a.tool("search_memory", { query: "deploys" })).memories).toHaveLength(1);
    expect((await a.tool("search_memory", { query: "Tuesd" })).memories).toHaveLength(1);
    expect((await a.tool("search_memory", { query: "nothing here" })).memories).toHaveLength(0);
  });

  it("updates a fact", async () => {
    const a = as("scope-update");
    const { id } = await a.tool("save_memory", { text: "Reviewer is Sam" });
    expect(await a.tool("update_memory", { id, text: "Reviewer is Alex" })).toMatchObject({
      updated: true,
    });
    const recalled = await a.recall();
    expect(recalled.content).toContain("Reviewer is Alex");
    expect(recalled.content).not.toContain("Reviewer is Sam");
    expect(await a.tool("update_memory", { id: "999999999", text: "x" })).toEqual({
      updated: false,
    });
  });

  it("deletes a fact and recalls an empty list", async () => {
    const a = as("scope-delete");
    const { id } = await a.tool("save_memory", { text: "Temporary note" });
    expect(await a.tool("forget_memory", { id })).toEqual({ deleted: true });
    expect(await a.tool("forget_memory", { id })).toEqual({ deleted: false });
    expect((await a.tool("search_memory", { query: "Temporary" })).memories).toHaveLength(0);
    expect((await a.recall()).content).toBe("No saved memories.");
  });

  it("keeps scopes apart", async () => {
    const a = as("scope-a");
    const b = as("scope-b");
    const { id } = await a.tool("save_memory", { text: "Secret preference of A" });
    expect((await b.recall()).content).toBe("No saved memories.");
    expect((await b.tool("search_memory", { query: "Secret" })).memories).toHaveLength(0);
    expect(await b.tool("update_memory", { id, text: "hijacked" })).toEqual({ updated: false });
    expect(await b.tool("forget_memory", { id })).toEqual({ deleted: false });
    expect((await a.recall()).content).toContain("Secret preference of A");
  });

  it("rejects text over the limit", async () => {
    const a = as("scope-limit");
    await expect(a.tool("save_memory", { text: "x".repeat(2001) })).rejects.toThrow();
  });
});
