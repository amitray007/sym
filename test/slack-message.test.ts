import { describe, expect, it } from "vitest";
import { messageText } from "../lib/slack/message.ts";

describe("messageText", () => {
  it("keeps a plain message's own text", () => {
    expect(messageText({ text: " hello " })).toBe("hello");
  });

  it("reads a forward's original text and author", () => {
    expect(
      messageText({
        text: "",
        attachments: [{ is_share: true, author_id: "U1", text: "the bug" }],
      }),
    ).toBe("Forwarded from <@U1>: the bug");
  });

  it("keeps a comment added to a forward, then the forward", () => {
    expect(
      messageText({
        text: "look",
        attachments: [{ is_msg_unfurl: true, author_name: "Ana", fallback: "the bug" }],
      }),
    ).toBe("look\nForwarded from Ana: the bug");
  });

  it("skips a link preview when the message has text of its own", () => {
    expect(messageText({ text: "see https://x.dev", attachments: [{ text: "X - a site" }] })).toBe(
      "see https://x.dev",
    );
  });

  it("lists file names", () => {
    expect(messageText({ files: [{ title: "Screenshot" }, { name: "a.log" }, {}] })).toBe(
      "File: Screenshot\nFile: a.log",
    );
  });
});
