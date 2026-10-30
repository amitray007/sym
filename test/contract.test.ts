import { describe, expect, it } from "vitest";
import { parseOutputContract } from "../lib/jobs/contract.ts";

const block = (json: string) => `\`\`\`json\n${json}\n\`\`\``;

describe("parseOutputContract", () => {
  it("reads the full contract into camelCase", () => {
    const message = `All done.\n${block(
      '{"summary":"Retry added","pr_url":"https://github.com/o/r/pull/812","tests":"12 passed","files_changed":["a.ts","b.ts"],"open_questions":["Cap at 5?"]}',
    )}`;
    expect(parseOutputContract(message)).toEqual({
      summary: "Retry added",
      prUrl: "https://github.com/o/r/pull/812",
      tests: "12 passed",
      testsStatus: "passed",
      filesChanged: ["a.ts", "b.ts"],
      openQuestions: ["Cap at 5?"],
    });
  });

  it("fills defaults for missing optional fields", () => {
    expect(parseOutputContract(block('{"summary":"ok","pr_url":null}'))).toEqual({
      summary: "ok",
      prUrl: null,
      tests: "",
      testsStatus: "unknown",
      filesChanged: [],
      openQuestions: [],
    });
  });

  it.each([
    ["passed", "12 passed"],
    ["failed", "1 failed"],
    ["not_run", "not run"],
    ["unknown", "4 new tests"],
    ["none", "none"],
  ])("recognizes legacy %s test truth", (status, tests) => {
    expect(
      parseOutputContract(block(JSON.stringify({ summary: "done", tests })))?.testsStatus,
    ).toBe(status);
  });

  it("takes the last json block", () => {
    const message = `${block('{"summary":"example"}')}\ntext\n${block('{"summary":"real"}')}`;
    expect(parseOutputContract(message)?.summary).toBe("real");
  });

  it("does not fall back to an earlier block when the last is broken", () => {
    const message = `${block('{"summary":"example"}')}\n${block("{not json")}`;
    expect(parseOutputContract(message)).toBeNull();
  });

  it("returns null for no message, no block, or a bad shape", () => {
    expect(parseOutputContract(null)).toBeNull();
    expect(parseOutputContract("")).toBeNull();
    expect(parseOutputContract("plain text")).toBeNull();
    expect(parseOutputContract(block('{"tests":"x"}'))).toBeNull();
    expect(parseOutputContract(block('{"summary":"x","files_changed":"a.ts"}'))).toBeNull();
    expect(parseOutputContract(block('{"summary":""}'))).toBeNull();
  });

  it("treats an empty pr_url as none", () => {
    expect(parseOutputContract(block('{"summary":"x","pr_url":""}'))?.prUrl).toBeNull();
  });
});
