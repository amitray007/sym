import { describe, expect, it } from "vitest";
import { callbackFor } from "../lib/jobs/callback.ts";

const HOOK = "http://localhost:3000/.well-known/workflow/v1/webhook/abc123?x=1";

describe("callbackFor", () => {
  it("keeps Eve's URL when no base is set", () => {
    expect(callbackFor(HOOK, undefined)).toBe(HOOK);
    expect(callbackFor(HOOK, "")).toBe(HOOK);
  });

  it("moves the path and token to the base the worker can reach", () => {
    expect(callbackFor(HOOK, "https://sym.example.ts.net")).toBe(
      "https://sym.example.ts.net/.well-known/workflow/v1/webhook/abc123?x=1",
    );
  });

  it("keeps a path prefix on the base and ignores a trailing slash", () => {
    expect(callbackFor(HOOK, "https://example.com/sym/")).toBe(
      "https://example.com/sym/.well-known/workflow/v1/webhook/abc123?x=1",
    );
  });
});
