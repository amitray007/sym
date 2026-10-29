import { describe, expect, it } from "vitest";
import { clipText, failurePost, resultPost, SECTION_MAX, safeMrkdwn } from "../lib/jobs/blocks.ts";
import type { OutputContract } from "../lib/jobs/contract.ts";

const job = {
  ref: "J-142",
  title: "Billing sync retry",
  workerThreadId: "thr_8f2c",
  durationMs: 840_000,
};
const contract: OutputContract = {
  summary: "Added retry with backoff.",
  prUrl: "https://github.com/o/r/pull/812",
  tests: "12 passed",
  filesChanged: ["a.ts"],
  openQuestions: ["Cap at 5 tries?"],
};

describe("conversational results", () => {
  it("keeps concerns, decisions, PR and test truth in both the post and notification", () => {
    const post = resultPost(job, contract, ["No test covers <the> limit."]);
    for (const text of [post.text, JSON.stringify(post.blocks)]) {
      expect(text).toContain("No test covers &lt;the&gt; limit.");
      expect(text).toContain("Cap at 5 tries?");
      expect(text).toContain("tests passed");
      expect(text).toContain("PR #812");
      expect(text).not.toMatch(/tl;dr|check before merge|☐|% sure|open questions/);
    }
    expect(post.blocks.map((b) => b.type)).toEqual([
      "markdown",
      "context",
      "actions",
      "context_actions",
    ]);
    expect(JSON.stringify(post.blocks)).not.toMatch(/sym_job_(ok|fix|close|steer)/);
  });
  it("offers only validated PR and CI links", () => {
    const post = resultPost(job, {
      ...contract,
      ciUrl: "https://example.com/ci/1",
      ciStatus: "failed",
    });
    expect(JSON.stringify(post.blocks)).toContain("CI run");
    expect(post.text).toContain("CI failed");
    expect(
      resultPost(job, { ...contract, prUrl: "ftp://x.test/pull/1" }).blocks.map((b) => b.type),
    ).not.toContain("actions");
  });
  it("gives no action controls on failures or missing results", () => {
    expect(failurePost(job, "Build <broke>").text).toContain("Build &lt;broke&gt;");
    expect(failurePost(job).blocks.map((b) => b.type)).toEqual([
      "markdown",
      "context",
      "context_actions",
    ]);
    expect(resultPost(job, null).text).toContain("can't say what changed");
    expect(resultPost(job, null).text).toContain("thr_8f2c");
  });
  it("escapes mentions copied from worker facts", () => {
    const post = resultPost(job, { ...contract, summary: "<!channel> & <@U1>" });
    expect(post.text).toContain("&lt;!channel&gt; &amp; &lt;@U1&gt;");
  });
  it("keeps required concerns in full when a result needs several sections", () => {
    const concern = "x".repeat(15_000);
    const post = resultPost(job, contract, [concern]);
    expect(post.text).toContain(concern);
    expect(
      post.blocks
        .filter((b) => b.type === "section")
        .every((b) => (b.text as { text: string }).text.length <= SECTION_MAX),
    ).toBe(true);
  });
});

describe("text limits", () => {
  it("clips with an ellipsis", () => {
    expect(clipText("abcdef", 4)).toBe("abc…");
    expect(clipText("abc", 4)).toBe("abc");
  });
  it("does not cut an escape entity", () => {
    const text = safeMrkdwn("<".repeat(100), 50);
    expect(text.length).toBeLessThanOrEqual(50);
    expect(text).not.toMatch(/&(l|lt|g|gt)?$/);
  });
});
