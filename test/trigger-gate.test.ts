import { decide } from "eve/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { triggerGate } from "../lib/triggers/gate.ts";
import type { Trigger } from "../lib/triggers/rows.ts";

// Decision 096: a decision-model check drops only the triggers a new message clearly does not
// need, and keeps every trigger when it cannot decide.

type Answer = { type: "boolean"; probability: number } | { type: "refusal" };
type Call = { state: unknown; questions: Record<string, unknown> };

// An AI SDK decision model with scripted answers, so Eve's real `decide` runs with no provider.
function fakeModel(answer: (key: string) => Answer | Error) {
  const calls: Call[] = [];
  const model = {
    specificationVersion: "v4" as const,
    provider: "fake",
    modelId: "fake-decider",
    supportedQuestionTypes: ["boolean"] as const,
    async doDecide(options: Call) {
      calls.push(options);
      const answers: Record<string, Answer> = {};
      for (const key of Object.keys(options.questions)) {
        const result = answer(key);
        if (result instanceof Error) throw result;
        answers[key] = result;
      }
      return { answers, warnings: [] };
    },
  };
  // The gate on the gateway route passes no model; the fake stands in for Eve's default.
  const decideWith: typeof decide = (options) => decide({ ...options, model, maxRetries: 0 });
  return { calls, decideWith };
}

const trigger = (id: number, instruction: string): Trigger =>
  ({ id, title: `Trigger ${id}`, instruction }) as Trigger;

const bugs = trigger(1, "Draft a ticket for each bug report.");
const praise = trigger(2, "Thank people who praise the team.");

describe("the trigger gate route", () => {
  afterEach(() => vi.restoreAllMocks());

  it("has no gate when it is off, on the fixture brain, or on the direct OpenAI route", () => {
    expect(triggerGate({ SYM_TRIGGER_GATE: "off" })).toBeUndefined();
    expect(triggerGate({ SYM_MODEL: "fixture" })).toBeUndefined();
    expect(triggerGate({ SYM_MODEL_PROVIDER: "openai" })).toBeUndefined();
  });

  it("uses Eve's default decision model on the gateway, or the configured one", async () => {
    const seen: unknown[] = [];
    const record: typeof decide = async (options) => {
      seen.push(options.model);
      throw new Error("stop");
    };
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await triggerGate({}, record)?.("text", [bugs]);
    await triggerGate({ SYM_TRIGGER_GATE: "openai/gpt-6-luna" }, record)?.("text", [bugs]);
    expect(seen).toEqual([undefined, "openai/gpt-6-luna"]);
  });

  it("uses a direct Anthropic decision model on the Anthropic route", async () => {
    const seen: unknown[] = [];
    const record: typeof decide = async (options) => {
      seen.push(options.model);
      throw new Error("stop");
    };
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await triggerGate({ SYM_MODEL_PROVIDER: "anthropic" }, record)?.("text", [bugs]);
    await triggerGate(
      { SYM_MODEL_PROVIDER: "anthropic", SYM_TRIGGER_GATE: "anthropic/claude-sonnet-5-5" },
      record,
    )?.("text", [bugs]);
    expect(seen[0]).toMatchObject({ modelId: "claude-haiku-5-5", specificationVersion: "v4" });
    expect(seen[1]).toMatchObject({ modelId: "claude-sonnet-5-5" });
  });
});

describe("the trigger gate", () => {
  afterEach(() => vi.restoreAllMocks());

  it("drops a trigger the model rules out and keeps one it does not", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { calls, decideWith } = fakeModel((key) => ({
      type: "boolean",
      probability: key === "trigger_1" ? 0.9 : 0.05,
    }));
    const gate = triggerGate({}, decideWith);
    expect(await gate?.("Checkout fails with a 500", [bugs, praise])).toEqual([bugs]);
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls[0]?.state)).toContain("Checkout fails with a 500");
    expect(JSON.stringify(calls[0]?.questions.trigger_2)).toContain("Thank people who praise");
  });

  it("drops a trigger below 0.2 and keeps one at 0.2", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { decideWith } = fakeModel((key) => ({
      type: "boolean",
      probability: key === "trigger_1" ? 0.2 : 0.19,
    }));
    const gate = triggerGate({}, decideWith);
    expect(await gate?.("maybe a bug?", [bugs, praise])).toEqual([bugs]);
  });

  it("keeps every trigger when the model refuses to answer", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { decideWith } = fakeModel(() => ({ type: "refusal" }));
    const gate = triggerGate({}, decideWith);
    expect(await gate?.("hmm", [bugs, praise])).toEqual([bugs, praise]);
  });

  it("keeps every trigger for blank text, such as a file with no caption, without a call", async () => {
    const { calls, decideWith } = fakeModel(() => ({ type: "boolean", probability: 0 }));
    const gate = triggerGate({}, decideWith);
    expect(await gate?.("  ", [bugs, praise])).toEqual([bugs, praise]);
    expect(calls).toEqual([]);
  });

  it("keeps every trigger when the model fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { decideWith } = fakeModel(() => new Error("provider down"));
    const gate = triggerGate({}, decideWith);
    expect(await gate?.("Checkout fails", [bugs, praise])).toEqual([bugs, praise]);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0])).not.toContain("provider down");
  });
});
