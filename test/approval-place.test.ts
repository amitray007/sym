import { describe, expect, it, vi } from "vitest";
import type { RequesterDeps } from "../lib/requester.ts";

const requester = vi.hoisted(() => ({ id: "UCREATOR" as string | undefined }));
vi.mock("../lib/requester.ts", async (original) => ({
  ...(await original<object>()),
  requesterOf: async () => requester.id,
}));

import { approvalPlace } from "../lib/slack/approval-place.ts";
import { APP_AUTH } from "../lib/triggers/fire.ts";

// Decision 102: a Slack write that only its requester approves asks in that person's DM.
describe("approvalPlace", () => {
  const person = { id: "s-chat", auth: { current: { principalId: "slack:T1:UASKER" } } };
  const run = { id: "s-run", auth: { current: APP_AUTH } };
  const deps = () => ({}) as RequesterDeps;
  const approval = (name: string) => ({ request: { kind: "approval" }, call: { name } });
  const state = (channelId = "C0ALERTS") => ({ channelId, triggeringUserId: "UALERTBOT" });

  it("sends a requester-approved Slack write to the DM", async () => {
    for (const tool of ["slack_post", "slack_dm", "slack_edit", "main_thread_post"]) {
      expect(await approvalPlace(approval(tool), person, state(), deps)).toBe("direct-message");
    }
  });

  it("keeps owner approvals, questions, and DM sessions in the thread", async () => {
    expect(await approvalPlace(approval("connection_approve"), person, state(), deps)).toBe(
      "thread",
    );
    expect(await approvalPlace({ request: { kind: "question" } }, person, state(), deps)).toBe(
      "thread",
    );
    expect(await approvalPlace(approval("slack_post"), person, state("DUASKER"), deps)).toBe(
      "thread",
    );
    expect(await approvalPlace(approval("slack_post"), person, undefined, deps)).toBe("thread");
  });

  it("points a run's DM card at the run's requester, not the event's author", async () => {
    const runState = state();
    expect(await approvalPlace(approval("slack_post"), run, runState, deps)).toBe("direct-message");
    expect(runState.triggeringUserId).toBe("UCREATOR");
  });

  it("keeps a run's card in the thread when nobody may approve it", async () => {
    requester.id = undefined;
    const runState = state();
    expect(await approvalPlace(approval("slack_post"), run, runState, deps)).toBe("thread");
    expect(runState.triggeringUserId).toBe("UALERTBOT");
    requester.id = "UCREATOR";
  });
});
