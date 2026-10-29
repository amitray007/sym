import { describe, expect, it } from "vitest";
import { capabilityInstructions } from "../lib/capabilities.ts";

describe("capabilityInstructions", () => {
  it("names the code channel tool only when code channels are on", () => {
    const on = capabilityInstructions({ SYM_CODE_CHANNELS: "on" });
    expect(on).toContain("Code channels are on.");
    expect(on).toContain("`code_channel` tool");
    expect(on).toContain("only when a person explicitly asks");
    expect(on).not.toMatch(/use it[^.]*for multi-step work/i);
    const off = capabilityInstructions({});
    expect(off).toContain("Code channels are off. Sym cannot create Slack channels.");
    expect(off).not.toContain("`code_channel`");
  });

  it("follows each opt-in switch", () => {
    const all = capabilityInstructions({
      SYM_VERIFIER: "on",
      SYM_PR_FOLLOW: "on",
      SYM_DIGEST: "on",
    });
    expect(all).toContain("A model check (the verifier) reviews");
    expect(all).toContain("Sym follows a job's pull request");
    expect(all).toContain("Sym posts a daily digest.");
    const none = capabilityInstructions({});
    expect(none).toContain("the model check (the verifier) is off");
    expect(none).toContain("does not follow pull requests");
    expect(none).toContain("The daily digest is off.");
  });
});
