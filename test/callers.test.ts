import { describe, expect, it } from "vitest";
import { isWorkerCaller } from "../lib/callers.ts";

describe("isWorkerCaller", () => {
  it("knows the worker principal from the MCP channel", () => {
    expect(isWorkerCaller({ principalId: "sym-worker" })).toBe(true);
  });

  it.each([
    ["a Slack person", { principalId: "slack:T1:U1" }],
    ["the app principal of a schedule", { principalId: "eve:app" }],
    ["no caller", null],
    ["an unknown caller", undefined],
  ])("refuses %s", (_name, caller) => {
    expect(isWorkerCaller(caller)).toBe(false);
  });
});
