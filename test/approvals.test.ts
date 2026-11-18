import { describe, expect, it } from "vitest";
import { approvalMode, approvalStatus, needsApproval } from "../lib/approvals.ts";

// Decision 099: one setting per kind of approval click.
describe("approvalMode", () => {
  it("keeps Sym's rules when unset or unknown, so a typo never opens a gate", () => {
    expect(approvalMode("posts", {})).toBe("rules");
    expect(approvalMode("posts", { SYM_APPROVAL_POSTS: "off" })).toBe("rules");
    expect(approvalMode("posts", { SYM_APPROVAL_POSTS: "" })).toBe("rules");
  });

  it("reads each kind from its own variable, in any case", () => {
    const env = { SYM_APPROVAL_DMS: " Never ", SYM_APPROVAL_ADMIN: "ALWAYS" };
    expect(approvalMode("dms", env)).toBe("never");
    expect(approvalMode("admin", env)).toBe("always");
    expect(approvalMode("start", env)).toBe("rules");
  });
});

describe("needsApproval", () => {
  it("follows the rule in rules mode", async () => {
    expect(await needsApproval("posts", () => true, {})).toBe(true);
    expect(await needsApproval("posts", async () => false, {})).toBe(false);
  });

  it("skips the rule's reads in never and always modes", async () => {
    const rule = () => {
      throw new Error("the rule must not run");
    };
    expect(await needsApproval("posts", rule, { SYM_APPROVAL_POSTS: "never" })).toBe(false);
    expect(await needsApproval("posts", rule, { SYM_APPROVAL_POSTS: "always" })).toBe(true);
  });

  it("gives Eve approval statuses", async () => {
    expect(await approvalStatus("dms", () => true, {})).toBe("user-approval");
    expect(await approvalStatus("dms", () => true, { SYM_APPROVAL_DMS: "never" })).toBe(
      "not-applicable",
    );
  });
});
