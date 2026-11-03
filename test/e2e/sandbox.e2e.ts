import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Conversation,
  type Harness,
  messageText,
  newConversation,
  startHarness,
  until,
} from "./harness.ts";

// The sandbox end to end (decision 089). `eve dev` uses just-bash, so this needs no Docker. The
// fixture brain runs "fixture-bash <command>" with the `bash` tool and repeats its output.

let h: Harness;

beforeAll(async () => {
  h = await startHarness({ database: "sym_e2e_sandbox", env: { SYM_SANDBOX: "on" } });
  await h.startEve();
});

afterAll(async () => {
  h?.writeReport();
  await h?.close();
});

const reply = (c: Conversation, match: RegExp) =>
  until(() => c.botMessages().find((m) => match.test(messageText(m))), { label: String(match) });

describe("sandbox", () => {
  it("runs a command in the session's sandbox and keeps its files for the next turn", async () => {
    const c = newConversation(h);
    await c.mention("<@UBOT> fixture-bash echo 6 7 > numbers.txt && wc -w < numbers.txt");
    await reply(c, /Sandbox output: 2\b/);

    await c.reply("<@UBOT> fixture-bash cat numbers.txt");
    await reply(c, /Sandbox output: 6 7/);
  });

  it("stages a file shared in Slack in the sandbox, where read_file opens it", async () => {
    const c = newConversation(h);
    const file = h.slack.addFile({
      name: "totals.csv",
      mimetype: "text/csv",
      bytes: new TextEncoder().encode("region,total\nnorth,42\n"),
    });
    await c.mention("<@UBOT> fixture-read-attachment", undefined, [file]);
    const answer = await reply(c, /Sandbox file:/);
    expect(messageText(answer)).toContain("north,42");
  });

  it("refuses a command that carries one of Sym's secrets", async () => {
    const c = newConversation(h);
    // The harness's fake bot token.
    await c.mention("<@UBOT> fixture-bash echo xoxb-e2e-fake");
    const error = await reply(c, /Sandbox error:/);
    expect(messageText(error)).toContain("secrets never enter the sandbox");
  });
});
