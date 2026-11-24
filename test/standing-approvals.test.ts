import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Sql } from "../lib/db.ts";
import type { LedgerDeps } from "../lib/jobs/run.ts";
import { recordSessionThread } from "../lib/ledger/threads.ts";
import type { SlackApi } from "../lib/slack/api.ts";
import { slackApiFromEnv } from "../lib/slack/eve-api.ts";
import { UNREACHABLE } from "../lib/slack/reach.ts";
import {
  listStandingApprovals,
  OWN_TURN_ONLY,
  parsePing,
  pingsIn,
} from "../lib/slack/standing-approvals.ts";
import { type FakeSlack, startFakeSlack } from "./fakes/slack-server.ts";
import { hasDatabase, useLedger } from "./helpers/ledger.ts";

const runtime = vi.hoisted(() => ({
  sql: undefined as Sql | undefined,
  slack: undefined as SlackApi | undefined,
}));
vi.mock("../lib/runtime.ts", async (original) => ({
  ...(await original<object>()),
  ledger: () => runtime.sql,
  ledgerDeps: (): LedgerDeps =>
    ({ sql: runtime.sql, allowedProjects: [], slack: runtime.slack }) as LedgerDeps,
  pack: () => undefined,
}));

import slackPost from "../agent/tools/slack_post.ts";
import standingApprovalAdd from "../agent/tools/standing_approval_add.ts";
import standingApprovalList from "../agent/tools/standing_approval_list.ts";
import standingApprovalRemove from "../agent/tools/standing_approval_remove.ts";

describe("group pings", () => {
  it("reads every ping form in a message once", () => {
    expect(
      pingsIn("<!subteam^S0ONCALL|@on-call> and <!here> and @channel, again <!subteam^S0ONCALL>"),
    ).toEqual([
      { mention: "S0ONCALL", label: "on-call" },
      { mention: "here", label: "here" },
      { mention: "channel", label: "channel" },
    ]);
    expect(pingsIn("<!group> mail me at a@here.com")).toEqual([
      { mention: "channel", label: "channel" },
    ]);
  });

  it("reads a ping a person names, and refuses a bare group name", () => {
    expect(parsePing("<!subteam^S0ONCALL>")).toEqual({ mention: "S0ONCALL", label: "S0ONCALL" });
    expect(parsePing("S0ONCALL")).toEqual({ mention: "S0ONCALL", label: "S0ONCALL" });
    expect(parsePing("@Here")).toEqual({ mention: "here", label: "here" });
    expect(parsePing("@on-call")).toBeUndefined();
  });
});

// Decision 105: a standing approval skips the slack_post click for one person and one channel,
// and only for the pings that person named.
describe.skipIf(!hasDatabase)("standing approvals", () => {
  const ledger = useLedger();
  let slack: FakeSlack;
  beforeAll(async () => {
    slack = await startFakeSlack({
      channels: {
        C0SOURCE: { name: "general" },
        C0ALERTS: { name: "alerts" },
        C0SHARED: { name: "partner", is_ext_shared: true },
      },
      members: {
        C0SOURCE: ["UASKER", "UOTHER"],
        C0ALERTS: ["UASKER", "UOTHER"],
        C0SHARED: ["UASKER"],
      },
    });
  });
  afterAll(async () => slack.close());

  const ASKER = "slack:T1:UASKER";
  // The principal a scheduled or trigger run starts as (decisions 085 and 088).
  const RUN = "eve:app";
  const use = () => {
    runtime.sql = ledger.sql();
    runtime.slack = slackApiFromEnv({
      SLACK_BOT_TOKEN: "xoxb-fake-token",
      SLACK_API_BASE_URL: slack.apiBaseUrl,
    });
    vi.stubEnv("SYM_SLACK_USERS", "UASKER,UOTHER");
  };
  const session = (principalId: string, id = "s-chat") => ({
    id,
    auth: {
      current:
        principalId === RUN
          ? { authenticator: "app", principalId, principalType: "runtime" }
          : { principalId },
    },
  });
  // biome-ignore lint/suspicious/noExplicitAny: a test context with only the fields the tools read
  const run = (tool: any, input: unknown, principalId = ASKER) =>
    tool.execute(input, { session: session(principalId), callId: "call-1" }) as Promise<string>;
  const postApproval = (text: string, target = "#alerts", principalId = ASKER) =>
    (slackPost.approval as { request: (ctx: unknown) => Promise<string> }).request({
      session: session(principalId),
      toolInput: { target, text },
    });

  it("stops asking for the named channel and pings, and asks again once removed", async () => {
    use();
    await recordSessionThread(ledger.sql(), {
      sessionId: "s-chat",
      teamId: "T1",
      channelId: "C0SOURCE",
      threadTs: null,
      userId: "UASKER",
    });
    const onCall = "<!subteam^S0ONCALL|@on-call> backlog is growing";
    expect(await postApproval(onCall)).toBe("user-approval");

    expect(
      await run(standingApprovalAdd, {
        channel: "#alerts",
        pings: ["<!subteam^S0ONCALL|@on-call>"],
      }),
    ).toBe("Saved. I won't ask before posting in <#C0ALERTS>, with pings to on-call.");
    expect(await postApproval(onCall)).toBe("not-applicable");
    expect(await postApproval("backlog is growing")).toBe("not-applicable");
    expect(await postApproval("<!here> backlog is growing")).toBe("user-approval");
    expect(await postApproval(`${onCall} <!subteam^S0OTHER>`)).toBe("user-approval");
    expect(await postApproval(onCall, "#alerts", "slack:T1:UOTHER")).toBe("user-approval");
    expect(await postApproval(onCall, "#general")).toBe("user-approval");

    expect(await run(standingApprovalList, {})).toBe("<#C0ALERTS>: posts, with pings to on-call");
    expect(
      await run(standingApprovalRemove, { channel: "#alerts", ping: "<!subteam^S0ONCALL>" }),
    ).toBe("Removed. I'll ask again before pinging S0ONCALL in <#C0ALERTS>.");
    expect(await postApproval(onCall)).toBe("user-approval");
    expect(await run(standingApprovalRemove, { channel: "#alerts" })).toMatch(/^Removed\./);
    expect(await listStandingApprovals(ledger.sql(), "UASKER")).toEqual([]);
    vi.unstubAllEnvs();
  });

  it("never covers a Slack Connect channel", async () => {
    use();
    await run(standingApprovalAdd, { channel: "C0SHARED", pings: [] });
    expect(await postApproval("v2.4 is out", "C0SHARED")).toBe("user-approval");
    vi.unstubAllEnvs();
  });

  it("saves only on the person's own turn, in a channel they can reach", async () => {
    use();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await run(standingApprovalAdd, { channel: "#alerts", pings: [] }, RUN)).toBe(
      OWN_TURN_ONLY,
    );
    expect(
      await run(standingApprovalAdd, { channel: "#alerts", pings: [] }, "slack:T1:USTRANGER"),
    ).toBe(UNREACHABLE);
    expect(await run(standingApprovalAdd, { channel: "#alerts", pings: ["@on-call"] })).toMatch(
      /can't read "@on-call"/,
    );
    expect(await listStandingApprovals(ledger.sql(), "USTRANGER")).toEqual([]);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("asks the person to confirm a new standing approval, but never a run", async () => {
    const request = (standingApprovalAdd.approval as { request: (ctx: unknown) => unknown })
      .request;
    expect(await request({ session: session(ASKER) })).toBe("user-approval");
    expect(await request({ session: session(RUN) })).toBe("not-applicable");
  });
});
