import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Job } from "../lib/ledger/jobs.ts";
import type { Pack } from "../lib/pack/load.ts";
import { inviteToCodeChannel } from "../lib/slack/code-channel-invite.ts";
import { slackApiFromEnv } from "../lib/slack/eve-api.ts";
import { type FakeSlack, startFakeSlack } from "./fakes/slack-server.ts";

// Real HTTP and stateful fake Slack; the invite function never needs a ledger write.
describe("code channel invitations", () => {
  let slack: FakeSlack;
  let api: ReturnType<typeof slackApiFromEnv>;
  let next = 0;
  beforeAll(async () => {
    slack = await startFakeSlack();
    api = slackApiFromEnv({
      SLACK_BOT_TOKEN: "xoxb-fake-token",
      SLACK_API_BASE_URL: slack.apiBaseUrl,
    });
  });
  afterAll(async () => slack.close());
  afterEach(() => vi.restoreAllMocks());
  const deps = () => ({ slack: api, usersEnv: "UREQUESTER" });
  async function job(isPrivate = false): Promise<Job> {
    next += 1;
    const created = await api.call("agents.conversations.create", {
      name: `Retry work ${next}`,
      is_private: isPrivate,
    });
    return {
      id: next,
      title: "Retry work",
      codeChannel: true,
      slackChannel: created.channel_id,
      originChannel: "CORIGIN",
      closedAt: null,
      archiveState: "none",
    } as Job;
  }
  const invite = (work: Job | undefined, people = ["UTEAMMATE"], requester = "UREQUESTER") =>
    inviteToCodeChannel(deps(), work, people, requester);

  it("invites a person and names the work without a reference", async () => {
    const work = await job();
    expect(await invite(work)).toEqual({
      work: "Retry work",
      results: [{ person: "<@UTEAMMATE>", status: "invited" }],
    });
    expect(slack.members[work.slackChannel ?? ""]).toEqual(["UTEAMMATE"]);
  });

  it("reports someone already there", async () => {
    const work = await job();
    await invite(work);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await invite(work)).toMatchObject({
      results: [{ person: "<@UTEAMMATE>", status: "already there" }],
    });
  });

  it("normalizes mentions, raw IDs, whitespace, and duplicate people", async () => {
    const work = await job();
    expect(await invite(work, [" <@UTEAMMATE> ", "UTEAMMATE", "WOTHER"])).toMatchObject({
      results: [
        { person: "<@UTEAMMATE>", status: "invited" },
        { person: "<@WOTHER>", status: "invited" },
      ],
    });
    expect(slack.members[work.slackChannel ?? ""]).toEqual(["UTEAMMATE", "WOTHER"]);
  });

  it("refuses a private outsider but invites an origin member found after page one", async () => {
    const work = await job(true);
    slack.members.CORIGIN = [...Array.from({ length: 201 }, (_, n) => `U${n}`), "UTEAMMATE"];
    const before = slack.callsTo("conversations.members").length;
    expect(await invite(work, ["UOUTSIDER", "UTEAMMATE"])).toEqual({
      work: "Retry work",
      results: [
        { person: "<@UOUTSIDER>", status: "refused", reason: "not in the original channel" },
        { person: "<@UTEAMMATE>", status: "invited" },
      ],
    });
    expect(
      slack
        .callsTo("conversations.members")
        .slice(before)
        .map((call) => call.body),
    ).toEqual([
      { channel: "CORIGIN", limit: "200" },
      { channel: "CORIGIN", limit: "200", cursor: "200" },
    ]);
    expect(slack.members[work.slackChannel ?? ""]).toEqual(["UTEAMMATE"]);
  });

  it("refuses private invitations when there is no origin to check", async () => {
    const work = await job(true);
    work.originChannel = null;
    expect(await invite(work)).toMatchObject({
      results: [{ status: "refused", reason: "not in the original channel" }],
    });
    expect(slack.members[work.slackChannel ?? ""]).toBeUndefined();
  });

  it("refuses all private invitations if origin membership cannot be read", async () => {
    const work = await job(true);
    slack.failNext("conversations.members", "missing_scope");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await invite(work)).toMatchObject({
      results: [{ status: "refused", reason: "missing_scope" }],
    });
    expect(slack.members[work.slackChannel ?? ""]).toBeUndefined();
    expect(warning).toHaveBeenCalledWith(expect.any(String), "missing_scope");
  });

  it("uses the requester's allow-list before any Slack call", async () => {
    const work = await job();
    const before = slack.calls.length;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await invite(work, ["UTEAMMATE"], "UOUTSIDER")).toBe(
      "You are not on Sym's Slack allow-list.",
    );
    expect(slack.calls).toHaveLength(before);
  });

  it("honors the pack allow-list over the environment", async () => {
    const work = await job();
    const pack = {
      config: { owner: { slackUserId: "UPACKOWNER" }, allowList: ["UPACKUSER"] },
    } as Pack;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await inviteToCodeChannel({ ...deps(), pack }, work, ["UTEAMMATE"], "UREQUESTER")).toBe(
      "You are not on Sym's Slack allow-list.",
    );
    expect(
      await inviteToCodeChannel({ ...deps(), pack }, work, ["UTEAMMATE"], "UPACKOWNER"),
    ).toMatchObject({ results: [{ status: "invited" }] });
  });

  it("refuses a missing job or a job without a code channel", async () => {
    expect(await invite(undefined)).toBe("I couldn't find the work for this request.");
    const work = await job();
    expect(await invite({ ...work, codeChannel: false })).toBe(
      "This work has no live code channel.",
    );
    expect(await invite({ ...work, slackChannel: null })).toBe(
      "This work has no live code channel.",
    );
  });

  it("refuses a closed job, an archive in progress, or an archived channel", async () => {
    const work = await job();
    expect(await invite({ ...work, closedAt: new Date() })).toBe("This work is closed.");
    expect(await invite({ ...work, archiveState: "pending" })).toBe("This work is closed.");
    await api.call("agents.conversations.archive", { channel_id: work.slackChannel });
    expect(await invite(work)).toBe("This code channel is archived.");
  });

  it("does not treat finished but open work as closed", async () => {
    expect(await invite({ ...(await job()), status: "done" })).toMatchObject({
      results: [{ status: "invited" }],
    });
  });

  it("keeps going after Slack refuses one person and reports mixed results", async () => {
    const work = await job();
    await invite(work, ["UALREADY"]);
    slack.failNext("conversations.invite", "user_not_found");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await invite(work, ["UMISSING", "UALREADY", "UNEW"])).toEqual({
      work: "Retry work",
      results: [
        { person: "<@UMISSING>", status: "refused", reason: "user_not_found" },
        { person: "<@UALREADY>", status: "already there" },
        { person: "<@UNEW>", status: "invited" },
      ],
    });
  });

  it("caps requests at 10 people and refuses empty requests", async () => {
    const work = await job();
    const before = slack.calls.length;
    expect(
      await invite(
        work,
        Array.from({ length: 11 }, (_, n) => `U${n}`),
      ),
    ).toBe("Ask to invite 1 to 10 people at a time.");
    expect(await invite(work, [])).toBe("Ask to invite 1 to 10 people at a time.");
    expect(slack.calls).toHaveLength(before);
    expect(
      await invite(
        work,
        Array.from({ length: 10 }, (_, n) => `U${n}`),
      ),
    ).toMatchObject({
      results: Array.from({ length: 10 }, (_, n) => ({ person: `<@U${n}>`, status: "invited" })),
    });
  });

  it("refuses names in place of user IDs", async () => {
    expect(await invite(await job(), ["Sam"])).toBe("Use Slack @-mentions or user IDs.");
  });

  it("reports configuration and Slack lookup failures without inviting", async () => {
    const work = await job();
    expect(
      await inviteToCodeChannel({ usersEnv: "UREQUESTER" }, work, ["UTEAMMATE"], "UREQUESTER"),
    ).toBe("Slack is not configured.");
    slack.failNext("conversations.info", "channel_not_found");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await invite(work)).toBe("Slack refused: channel_not_found.");
  });
});
