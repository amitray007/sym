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
    expect(stepModel(fixture, "medium", env).reasoning).toBe("medium");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  // Decision 080: a direct provider uses its own API key and native model IDs.
  it("calls Anthropic directly for SYM_MODEL_PROVIDER=anthropic", () => {
    const selection = stepModel(fixture, "medium", {
      SYM_MODEL_PROVIDER: " Anthropic ",
      SYM_MODEL: "claude-opus-5-5",
    });
    expect(selection.model).toMatchObject({
      provider: "anthropic.messages",
      modelId: "claude-opus-5-5",
    });
    expect(selection).toMatchObject({ reasoning: "medium" });
  });

  it("calls OpenAI directly for SYM_MODEL_PROVIDER=openai", () => {
    const selection = stepModel(fixture, "low", {
      SYM_MODEL_PROVIDER: "openai",
      SYM_MODEL: "gpt-6-luna",
    });
    expect(selection.model).toMatchObject({ modelId: "gpt-6-luna" });
    expect((selection.model as { provider: string }).provider).toMatch(/^openai\./);
    expect(selection).toMatchObject({ reasoning: "low" });
  });

  it("uses the direct provider's default model when SYM_MODEL is unset", () => {
    const selection = stepModel(fixture, "medium", { SYM_MODEL_PROVIDER: "anthropic" });
    expect(typeof selection.model).toBe("object");
    expect(selection.model).toMatchObject({ provider: "anthropic.messages" });
  });

  it("falls back to the gateway for an unknown SYM_MODEL_PROVIDER with one warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const env = { SYM_MODEL_PROVIDER: "bedrock", SYM_MODEL: "openai/gpt-5-mini" };
    expect(stepModel(fixture, "low", env).model).toBe("openai/gpt-5-mini");
    expect(stepModel(fixture, "low", env).model).toBe("openai/gpt-5-mini");
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
