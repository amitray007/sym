import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import { isQuickReply } from "../evals/conversation.ts";
import { fixtureBrain } from "../lib/brain/fixture.ts";
import { stepModel } from "../lib/brain/model.ts";

// Importing definitions checks discovery/authoring without running eve eval, its database
// setup, or any real-model case. The fixture generation below is entirely in process.
describe("eval loading and fixture wiring", () => {
  it("loads every eval definition without running its test", async () => {
    const root = join(process.cwd(), "evals");
    const cases = (await readdir(root, { recursive: true })).filter((file) =>
      file.endsWith(".eval.ts"),
    );
    expect(cases.length).toBeGreaterThan(0);
    for (const file of cases) {
      const { default: definition } = await import(pathToFileURL(join(root, file)).href);
      for (const item of Array.isArray(definition) ? definition : [definition]) {
        expect(item).toMatchObject({ _tag: "EveEval", test: expect.any(Function) });
      }
    }
  });

  it("runs the actual fixture through the model selected by SYM_MODEL=fixture", async () => {
    const selection = stepModel(fixtureBrain, "medium", { SYM_MODEL: "fixture" });
    expect(typeof selection.model).toBe("object");
    const reply = await generateText({ model: selection.model, prompt: "fixture wiring probe" });
    expect(reply.text).toBe("Fixture brain heard: fixture wiring probe");
  });
});

describe("quick-reply eval assertions", () => {
  it.each([
    "J-12 is running. Nothing needs you.",
    "Tests passed, including 4 new tests.",
    "The wait is uncapped. I haven't changed anything.",
  ])("accepts conversational text: %s", (text) => {
    expect(isQuickReply(text)).toBe(true);
  });

  it.each([
    "",
    "## Status\nJ-12 is running.",
    "**Summary**\nJ-12 is running.",
    "tl;dr: tests passed",
    "- [x] Tests passed",
    "☐ Check the timeout",
    "✅ Tests passed",
  ])("rejects report chrome in a quick reply: %s", (text) => {
    expect(isQuickReply(text)).toBe(false);
  });
});
