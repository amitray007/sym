import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Harness,
  messageText,
  newConversation,
  OWNER,
  startHarness,
  until,
} from "./harness.ts";

// Voice notes end to end (decision 092): a Slack audio clip is downloaded from the fake Slack file
// host with the bot token, transcribed by the fixture route (SYM_MODEL=fixture reads the bytes as
// text), and the transcript reaches the fixture brain, which echoes it.

let h: Harness;

beforeAll(async () => {
  h = await startHarness({ database: "sym_e2e_voice" });
  await h.startEve();
});

afterAll(async () => {
  h?.writeReport();
  await h?.close();
});

describe("voice notes", () => {
  it("gives the brain the transcript of an audio clip", async () => {
    const c = newConversation(h);
    const file = {
      ...h.slack.addFile({
        name: "audio_message.webm",
        mimetype: "audio/webm",
        bytes: new TextEncoder().encode("please check the nightly build"),
      }),
      subtype: "slack_audio",
      duration_ms: 4_000,
    };
    await c.mention("<@UBOT>", OWNER, [file]);
    const reply = await until(
      () => c.botMessages().find((m) => messageText(m).includes("heard a voice note")),
      { label: "the voice note reply" },
    );
    expect(messageText(reply)).toContain(
      "Fixture brain heard a voice note: please check the nightly build",
    );
  });
});
