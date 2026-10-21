import { describe, expect, it, vi } from "vitest";
import { stepModel } from "../lib/brain/model.ts";

const fixture = () => {
  throw new Error("a gateway model must not build the fixture");
};

describe("stepModel", () => {
  it("uses the default model and the caller's reasoning", () => {
    expect(stepModel(fixture, "medium", {})).toEqual({
      model: "anthropic/claude-sonnet-5.5",
      reasoning: "medium",
    });
  });

  it("takes the model from SYM_MODEL", () => {
    expect(stepModel(fixture, "low", { SYM_MODEL: " openai/gpt-5-mini " })).toEqual({
      model: "openai/gpt-5-mini",
      reasoning: "low",
    });
  });

  // Decision 064: some providers reject any reasoning level for a model without reasoning.
  it("lets SYM_REASONING replace the reasoning level", () => {
    expect(
      stepModel(fixture, "medium", {
        SYM_MODEL: "moonshotai/kimi-k2",
        SYM_REASONING: "Provider-Default",
      }),
    ).toEqual({ model: "moonshotai/kimi-k2", reasoning: "provider-default" });
  });

  it("ignores an unknown SYM_REASONING with one warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const env = { SYM_REASONING: "maximum" };
    expect(stepModel(fixture, "low", env).reasoning).toBe("low");
    expect(stepModel(fixture, "low", env).reasoning).toBe("low");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("builds the fixture model for SYM_MODEL=fixture", () => {
    const model = { modelId: "fixture" } as never;
    expect(stepModel(() => model, "medium", { SYM_MODEL: "fixture" })).toEqual({
      model,
      modelContextWindowTokens: 1_000_000,
    });
  });
});
