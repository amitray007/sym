import { afterEach, beforeEach, describe, expect, it } from "vitest";
import playbookPropose from "../agent/tools/playbook_propose.ts";
import playbookRetire from "../agent/tools/playbook_retire.ts";
import playbookReview from "../agent/tools/playbook_review.ts";
import {
  isApprovalAction,
  mayDecideAsOwner,
  OWNER_ONLY,
  ownerResponse,
  ownerUserId,
  slackUserOfPrincipal,
} from "../lib/owner.ts";

describe("owner helper", () => {
  it("reads the owner from the environment", () => {
    expect(ownerUserId(undefined, {})).toBeUndefined();
    expect(ownerUserId(undefined, { SYM_OWNER_SLACK_USER: " U1 " })).toBe("U1");
  });

  it("reads the user from a Slack principal only", () => {
    expect(slackUserOfPrincipal("slack:T1:U2")).toBe("U2");
    expect(slackUserOfPrincipal("sym-worker")).toBeUndefined();
    expect(slackUserOfPrincipal(undefined)).toBeUndefined();
  });

  it("lets only the owner decide, and anyone when no owner is set", () => {
    const env = { SYM_OWNER_SLACK_USER: "U1" };
    expect(mayDecideAsOwner("U1", undefined, env)).toBe(true);
    expect(mayDecideAsOwner("U2", undefined, env)).toBe(false);
    expect(mayDecideAsOwner(undefined, undefined, env)).toBe(false);
    expect(mayDecideAsOwner("U2", undefined, {})).toBe(true);
  });

  it("tells approval buttons from question buttons", () => {
    expect(isApprovalAction("eve_input:tool-approval:req1:button:0")).toBe(true);
    expect(isApprovalAction("eve_input:route:C1:1700.1:tool-approval:req1:button:1")).toBe(true);
    expect(isApprovalAction("eve_input:code:C1:tool-approval:req1:button:0")).toBe(true);
    expect(isApprovalAction("eve_input:code:C1:req1:button:0")).toBe(false);
    expect(isApprovalAction("eve_input:req1:button:0")).toBe(false);
    expect(isApprovalAction("eve_input_freeform:req1")).toBe(false);
    expect(isApprovalAction("sym_stop")).toBe(false);
  });
});

describe("playbook tools refuse a non-owner", () => {
  const saved = process.env.SYM_OWNER_SLACK_USER;
  const savedPack = process.env.SYM_PACK_DIR;
  beforeEach(() => {
    process.env.SYM_OWNER_SLACK_USER = "U0OWNER";
    delete process.env.SYM_PACK_DIR;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.SYM_OWNER_SLACK_USER;
    else process.env.SYM_OWNER_SLACK_USER = saved;
    if (savedPack !== undefined) process.env.SYM_PACK_DIR = savedPack;
  });

  const as = (principalId: string) => ({
    session: { id: "s1", auth: { current: { principalId } } },
  });
  // biome-ignore lint/suspicious/noExplicitAny: a test context with only the fields the tools read
  const run = (tool: any, input: unknown, principalId: string) =>
    tool.execute(input, as(principalId));

  it("refuses propose, review, and retire from an allowed user who is not the owner", async () => {
    const other = "slack:T1:U0OTHER";
    expect(await run(playbookPropose, { name: "x", kind: "rule", body: "y" }, other)).toBe(
      OWNER_ONLY,
    );
    expect(await run(playbookReview, { id: 1, body: "y" }, other)).toBe(OWNER_ONLY);
    expect(await run(playbookRetire, { id: 1 }, other)).toBe(OWNER_ONLY);
  });
});

describe("ownerResponse", () => {
  const owned = () =>
    ({ config: { owner: { slackUserId: "UOWNER" } } }) as unknown as Parameters<
      typeof ownerResponse
    >[0] extends () => infer P
      ? P
      : never;
  const answer = (decision: string, principalId: string) =>
    ownerResponse(owned)({ response: { decision, principal: { principalId } } });

  it("lets the owner approve", () => {
    expect(answer("approve", "slack:T1:UOWNER")).toEqual({ status: "allowed" });
  });

  it("refuses an approval from anyone else, typed or clicked", () => {
    expect(answer("approve", "slack:T1:UOTHER")).toEqual({
      status: "rejected",
      reason: "Only the owner can decide this.",
    });
    expect(answer("approve", "sym-worker").status).toBe("rejected");
  });

  it("lets anyone allowed cancel", () => {
    expect(answer("cancel", "slack:T1:UOTHER")).toEqual({ status: "allowed" });
  });
});
