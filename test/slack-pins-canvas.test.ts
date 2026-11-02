import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { writeChannelCanvas } from "../lib/slack/canvas.ts";
import { slackApiFromEnv } from "../lib/slack/eve-api.ts";
import { addBookmark, pinMessage } from "../lib/slack/pins.ts";
import { UNREACHABLE } from "../lib/slack/reach.ts";
import { type FakeSlack, startFakeSlack } from "./fakes/slack-server.ts";
import { hasDatabase, useLedger } from "./helpers/ledger.ts";

// Decision 084: pins, bookmarks, and channel canvases on request, for members only.
describe("pins and bookmarks", () => {
  let slack: FakeSlack;
  beforeAll(async () => {
    slack = await startFakeSlack({
      channels: { C0OPS: { name: "ops" }, C0SECRET: { name: "secret" } },
      members: { C0OPS: ["UASKER"], C0SECRET: [] },
    });
  });
  afterAll(async () => slack.close());
  const deps = () => ({
    slack: slackApiFromEnv({
      SLACK_BOT_TOKEN: "xoxb-fake-token",
      SLACK_API_BASE_URL: slack.apiBaseUrl,
    }),
    usersEnv: "UASKER",
  });
  const link = (channel: string, ts: string) =>
    `https://acme.slack.com/archives/${channel}/p${ts.replace(".", "")}`;

  it("pins and unpins a linked message for a member", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const message = slack.addMessage({ channel: "C0OPS", user: "UASKER", text: "runbook" });
    const pin = (add: boolean) => pinMessage(deps(), "UASKER", link("C0OPS", message.ts), add);
    expect(await pin(true)).toBe("Pinned.");
    expect(await pin(true)).toBe("It's already pinned.");
    expect(await pin(false)).toBe("Unpinned.");
    expect(await pin(false)).toBe("It isn't pinned.");
    const secret = slack.addMessage({ channel: "C0SECRET", user: "UOTHER", text: "x" });
    expect(await pinMessage(deps(), "UASKER", link("C0SECRET", secret.ts), true)).toBe(UNREACHABLE);
    vi.restoreAllMocks();
  });

  it("bookmarks an https link in a member's channel", async () => {
    const add = (target: string, url: string) =>
      addBookmark(deps(), "UASKER", { target, title: "Runbook", url });
    expect(await add("#ops", "https://example.com/runbook")).toBe("Bookmarked.");
    expect(slack.callsTo("bookmarks.add").at(-1)?.body).toMatchObject({
      channel_id: "C0OPS",
      title: "Runbook",
      type: "link",
      link: "https://example.com/runbook",
    });
    expect(await add("#ops", "javascript:alert(1)")).toBe("Give me an https link to bookmark.");
    expect(await add("#secret", "https://example.com")).toBe(UNREACHABLE);
  });
});

describe.skipIf(!hasDatabase)("channel canvases", () => {
  const ledger = useLedger();
  let slack: FakeSlack;
  beforeAll(async () => {
    slack = await startFakeSlack({
      channels: { C0OPS: { name: "ops" }, C0SECRET: { name: "secret" } },
      members: { C0OPS: ["UASKER"], C0SECRET: [] },
    });
  });
  afterAll(async () => slack.close());
  const write = (callId: string, target = "#ops") =>
    writeChannelCanvas(
      {
        sql: ledger.sql(),
        slack: slackApiFromEnv({
          SLACK_BOT_TOKEN: "xoxb-fake-token",
          SLACK_API_BASE_URL: slack.apiBaseUrl,
        }),
        usersEnv: "UASKER",
      },
      {
        sessionId: "s-1",
        callId,
        requester: "UASKER",
        target,
        markdown: "## Runbook",
        title: "Ops",
      },
    );

  it("creates the canvas once, then adds to its end without replacing", async () => {
    expect(await write("c-1")).toBe("Created the channel canvas.");
    expect(slack.callsTo("conversations.canvases.create").at(-1)?.body).toMatchObject({
      channel_id: "C0OPS",
      title: "Ops",
    });
    expect(await write("c-2")).toBe("Added to the channel canvas.");
    const changes = slack.callsTo("canvases.edit").at(-1)?.body.changes as
      | { operation: string }[]
      | undefined;
    expect(changes?.[0]?.operation).toBe("insert_at_end");
  });

  it("refuses a channel the requester is not in", async () => {
    expect(await write("c-3", "#secret")).toBe(UNREACHABLE);
  });
});
