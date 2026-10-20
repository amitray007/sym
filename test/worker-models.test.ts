import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPack } from "../lib/pack/load.ts";
import { workerModelList } from "../lib/pack/policy.ts";
import {
  briefModelLine,
  chooseModel,
  DEFAULT_MODELS,
  modelInstructions,
  modelList,
  resolveAvailable,
  splitModelId,
} from "../lib/workers/models.ts";
import type { WorkerCapabilities } from "../lib/workers/types.ts";

const SONNET = "claudeAgent/claude-sonnet-5-5";
const OPUS = "claudeAgent/claude-opus-5-5";
const LUNA = "codex/gpt-6-luna";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function pack(manifest: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "sym-models-"));
  dirs.push(dir);
  writeFileSync(join(dir, "sym.config.yaml"), JSON.stringify(manifest));
  return loadPack(dir);
}

const owner = { owner: { slackUserId: "U0OWNER01" } };
const worker = (models?: unknown[]) => ({
  name: "mac",
  kind: "t3",
  mcpUrl: "https://mac.example.ts.net/mcp",
  ...(models ? { models } : {}),
});
const project = (extra: Record<string, unknown> = {}) => ({
  name: "app",
  worker: "mac",
  allowedPaths: ["src/**"],
  ...extra,
});

describe("pack model validation", () => {
  it("accepts models, a default flag, and a project model", () => {
    const loaded = pack({
      ...owner,
      workers: [
        worker([
          { id: SONNET, use: "Routine changes", effort: "medium" },
          { id: OPUS, use: "Hard bugs", default: true },
        ]),
      ],
      projects: [project({ model: OPUS })],
    });
    expect(loaded.config.workers[0]?.models).toHaveLength(2);
    expect(loaded.config.projects[0]?.model).toBe(OPUS);
  });

  it("accepts a project model from the built-in list when the worker lists none", () => {
    const loaded = pack({ ...owner, workers: [worker()], projects: [project({ model: LUNA })] });
    expect(loaded.config.projects[0]?.model).toBe(LUNA);
  });

  it.each([
    [
      "an id without a provider",
      [{ id: "sonnet", use: "x" }],
      /models\.0\.id.*<provider>\/<model>/,
    ],
    [
      "two defaults",
      [
        { id: SONNET, use: "a", default: true },
        { id: OPUS, use: "b", default: true },
      ],
      /at most one model can set default/,
    ],
    [
      "a duplicate id",
      [
        { id: SONNET, use: "a" },
        { id: SONNET, use: "b" },
      ],
      /model ids must be unique/,
    ],
    ["a model without a use line", [{ id: SONNET }], /models\.0\.use/],
    ["an unknown field", [{ id: SONNET, use: "a", cost: 1 }], /models\.0/],
  ])("rejects %s", (_name, models, message) => {
    expect(() => pack({ ...owner, workers: [worker(models)] })).toThrow(message);
  });

  it("rejects a project model that is not in the worker's list", () => {
    expect(() =>
      pack({
        ...owner,
        workers: [worker([{ id: SONNET, use: "a" }])],
        projects: [project({ model: OPUS })],
      }),
    ).toThrow(/projects\.0\.model: "claudeAgent\/claude-opus-5-5" is not in the model list/);
  });

  it("rejects a project model that is not in the built-in list", () => {
    expect(() =>
      pack({ ...owner, workers: [worker()], projects: [project({ model: "x/y" })] }),
    ).toThrow(/projects\.0\.model/);
  });
});

describe("modelList", () => {
  it("uses the built-in list with the first entry as the default", () => {
    const list = modelList();
    expect(list.entries.map((entry) => entry.id)).toEqual(DEFAULT_MODELS.map((entry) => entry.id));
    expect(list.defaultId).toBe(SONNET);
  });

  it("uses the pack's list and its default flag", () => {
    const list = modelList([
      { id: SONNET, use: "a" },
      { id: OPUS, use: "b", default: true },
    ]);
    expect(list.defaultId).toBe(OPUS);
  });

  it("takes the first pack entry as the default when none is marked", () => {
    expect(modelList([{ id: LUNA, use: "a" }]).defaultId).toBe(LUNA);
  });

  it("makes SYM_WORKER_MODEL the default and adds it when missing", () => {
    const listed = modelList(undefined, OPUS);
    expect(listed.defaultId).toBe(OPUS);
    expect(listed.entries).toHaveLength(DEFAULT_MODELS.length);

    const added = modelList(undefined, "fake/fake-model");
    expect(added.defaultId).toBe("fake/fake-model");
    expect(added.entries.at(-1)).toMatchObject({ id: "fake/fake-model" });
  });

  it("picks the list of the worker the project runs on", () => {
    const loaded = pack({
      ...owner,
      workers: [worker([{ id: LUNA, use: "a" }])],
    });
    expect(workerModelList(loaded, "mac").defaultId).toBe(LUNA);
    expect(workerModelList(undefined, undefined).defaultId).toBe(SONNET);
  });
});

describe("splitModelId", () => {
  it("splits at the first slash", () => {
    expect(splitModelId("openrouter/vendor/model")).toEqual({
      providerId: "openrouter",
      model: "vendor/model",
    });
    expect(splitModelId("model")).toBeUndefined();
    expect(splitModelId("a/")).toBeUndefined();
  });
});

describe("chooseModel", () => {
  const list = modelList();

  it("prefers the project's model over the brief's", () => {
    expect(chooseModel(list, { projectModel: OPUS, briefModel: LUNA }).entry.id).toBe(OPUS);
  });

  it("uses the brief's model when it is on the list", () => {
    const choice = chooseModel(list, { briefModel: LUNA });
    expect(choice.entry.id).toBe(LUNA);
    expect(choice.note).toBeUndefined();
  });

  it("uses the default when the brief names none", () => {
    expect(chooseModel(list, {}).entry.id).toBe(SONNET);
  });

  it("falls back to the default for a model off the list and says why", () => {
    const choice = chooseModel(list, { briefModel: "claudeAgent/made-up" });
    expect(choice.entry.id).toBe(SONNET);
    expect(choice.note).toContain("claudeAgent/made-up");
    expect(choice.note).toContain("not on the list");
  });
});

const provider = (id: string, models: string[], options: Record<string, unknown> = {}) => ({
  id,
  name: id,
  models,
  modelOptions: options as never,
  available: true,
});

describe("resolveAvailable", () => {
  const list = modelList();
  const claude = provider("claudeAgent", ["claude-sonnet-5-5", "claude-opus-5-5"], {
    "claude-sonnet-5-5": [{ id: "effort", values: ["low", "medium", "high"] }],
    "claude-opus-5-5": [{ id: "effort", values: ["medium", "high"] }],
  });
  const codex = provider("codex", ["gpt-6-luna"], {
    "gpt-6-luna": [{ id: "reasoningEffort", values: ["low", "medium"] }],
  });
  const caps = (...providers: WorkerCapabilities["providers"]): WorkerCapabilities => ({
    providers,
  });

  it("keeps an available model and maps claudeAgent effort", () => {
    const result = resolveAvailable(list, chooseModel(list, { briefModel: OPUS }), caps(claude));
    expect(result.entry?.id).toBe(OPUS);
    expect(result.selection).toEqual({
      providerId: "claudeAgent",
      model: "claude-opus-5-5",
      options: [{ id: "effort", value: "high" }],
    });
    expect(result.note).toBeUndefined();
  });

  it("maps codex effort to reasoningEffort", () => {
    const result = resolveAvailable(list, chooseModel(list, { briefModel: LUNA }), caps(codex));
    expect(result.selection?.options).toEqual([{ id: "reasoningEffort", value: "low" }]);
  });

  it("accepts the other provider spellings", () => {
    for (const id of ["reasoning_effort", "reasoning"]) {
      const other = provider("codex", ["gpt-6-luna"], {
        "gpt-6-luna": [{ id, values: ["low"] }],
      });
      const result = resolveAvailable(list, chooseModel(list, { briefModel: LUNA }), caps(other));
      expect(result.selection?.options).toEqual([{ id, value: "low" }]);
    }
  });

  it("sends no effort when the model has no matching option or value", () => {
    const noValue = provider("codex", ["gpt-6-luna"], {
      "gpt-6-luna": [{ id: "reasoningEffort", values: ["high"] }],
    });
    const none = provider("codex", ["gpt-6-luna"]);
    for (const p of [noValue, none]) {
      const result = resolveAvailable(list, chooseModel(list, { briefModel: LUNA }), caps(p));
      expect(result.selection).toEqual({ providerId: "codex", model: "gpt-6-luna" });
    }
  });

  it("falls back to the default, then the next available, and says so", () => {
    const result = resolveAvailable(list, chooseModel(list, { briefModel: LUNA }), caps(claude));
    expect(result.entry?.id).toBe(SONNET);
    expect(result.note).toContain("codex/gpt-6-luna is not available");

    const onlyOpus = provider("claudeAgent", ["claude-opus-5-5"]);
    const second = resolveAvailable(list, chooseModel(list, {}), caps(onlyOpus));
    expect(second.entry?.id).toBe(OPUS);
    expect(second.note).toContain(`Used ${OPUS}`);
  });

  it("skips a provider the worker marks unavailable", () => {
    const off = { ...claude, available: false };
    const result = resolveAvailable(list, chooseModel(list, {}), caps(off, codex));
    expect(result.entry?.id).toBe(LUNA);
  });

  it("sends no model when no listed model is available", () => {
    const result = resolveAvailable(list, chooseModel(list, {}), caps(provider("other", ["m"])));
    expect(result.selection).toBeUndefined();
    expect(result.entry).toBeUndefined();
    expect(result.note).toContain("project default");
  });
});

describe("briefModelLine", () => {
  const list = modelList();

  it("shows the default when the brief names no model", () => {
    expect(briefModelLine(list, {})).toBe("Model: claude-sonnet-5-5 (medium) · default");
  });

  it("shows the brief's model and reason", () => {
    expect(briefModelLine(list, { briefModel: OPUS, reason: "touches migrations" })).toBe(
      "Model: claude-opus-5-5 (high) · touches migrations",
    );
  });

  it("shows a pinned project model", () => {
    expect(briefModelLine(list, { projectModel: LUNA, briefModel: OPUS })).toBe(
      "Model: gpt-6-luna (low) · set for this project",
    );
  });

  it("shows the fallback for a model off the list", () => {
    expect(briefModelLine(list, { briefModel: "x/y" })).toContain("not on the list");
  });
});

describe("modelInstructions", () => {
  it("lists each id with its effort and use, and marks the default", () => {
    const text = modelInstructions([{ list: modelList() }]);
    expect(text).toContain(
      "- claudeAgent/claude-sonnet-5-5 (medium) [default]: Normal changes with a clear scope, tests, docs",
    );
    expect(text).toContain("- codex/gpt-6-luna (low): Scheduled checks");
  });

  it("names the worker when there are several", () => {
    const text = modelInstructions([{ worker: "mac", list: modelList() }]);
    expect(text).toContain("Worker mac:");
  });
});
