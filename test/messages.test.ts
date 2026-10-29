import { describe, expect, it } from "vitest";
import { Brief } from "../lib/jobs/brief.ts";
import type { OutputContract } from "../lib/jobs/contract.ts";
import {
  briefPrompt,
  escapeMrkdwn,
  failureMessage,
  fullBrief,
  permissionBlockMessage,
  quietNotice,
  resultMessage,
  tldr,
} from "../lib/jobs/messages.ts";

const job = {
  ref: "J-142",
  title: "Billing sync retry",
  workerThreadId: "thr_8f2c",
  durationMs: 14 * 60_000,
};

const contract: OutputContract = {
  summary: "Added retry with backoff.",
  prUrl: "https://github.com/o/r/pull/812",
  tests: "12 passed",
  filesChanged: ["a.ts", "b.ts", "c.ts"],
  openQuestions: ["Cap at 5 tries?"],
};

describe("escapeMrkdwn", () => {
  it("escapes & < >", () => {
    expect(escapeMrkdwn("a & b <!channel> <http://x|y>")).toBe(
      "a &amp; b &lt;!channel&gt; &lt;http://x|y&gt;",
    );
  });
});

describe("resultMessage", () => {
  it("shows a short result, every concern and decision, and full facts", () => {
    const text = resultMessage(job, contract, ["No test covers <the> limit."]);
    expect(text).toContain("J-142 is done. Added retry with backoff.");
    expect(text).toContain("No test covers &lt;the&gt; limit.");
    expect(text).toContain("Cap at 5 tries?");
    expect(text).toContain("Tests passed. Reported: 12 passed");
    expect(text).toContain("PR #812");
    expect(text).not.toMatch(/tl;dr|check before merge|☐|% sure/);
  });
  it.each([
    ["12 passed", "Tests passed."],
    ["1 failed", "Tests failed."],
    ["not run; read-only", "Tests did not run."],
    ["4 new tests", "I don't know whether tests ran."],
    ["none", "no tests apply"],
  ])("preserves test truth for %s", (tests, truth) => {
    expect(resultMessage(job, { ...contract, tests })).toContain(truth);
  });
  it("does not discard warnings in the second clause of a test report", () => {
    expect(
      resultMessage(job, { ...contract, tests: "12 passed; integration tests not run" }),
    ).toContain("integration tests not run");
  });
  it("explains a missing report and keeps the worker pointer", () => {
    expect(resultMessage(job, null)).toContain("can't say what changed");
    expect(resultMessage(job, null)).toContain("thr_8f2c");
  });
});

describe("tldr", () => {
  it("keeps a short summary whole", () => {
    expect(tldr("Fixed it. Tests pass.")).toBe("Fixed it. Tests pass.");
  });

  it("takes the first sentence of a long summary", () => {
    const long = `Fixed the retry loop. ${"More detail follows here. ".repeat(10)}`;
    expect(tldr(long)).toBe("Fixed the retry loop.");
  });

  it("caps a long first sentence at a word boundary", () => {
    const out = tldr(`${"word ".repeat(80)}end.`);
    expect(out.length).toBeLessThanOrEqual(160);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toMatch(/wor…$/);
  });

  it("flattens whitespace", () => {
    expect(tldr("a\n\n b")).toBe("a b");
  });
});

describe("other messages", () => {
  it("keeps failures and blockers plain", () => {
    expect(failureMessage(job, "Build <broke>")).toContain(
      "J-142 stopped before finishing. Build &lt;broke&gt;",
    );
    expect(permissionBlockMessage("J-142")).toContain("needs permission");
    expect(quietNotice(job, 45 * 60_000)).toContain("for 45m. Want me to stop it?");
  });
});

describe("briefPrompt", () => {
  const brief = Brief.parse({
    project: "sync-service",
    title: "Billing retry",
    goal: "add retries",
    constraints: ["Leave webhooks alone."],
    doneWhen: ["Tests pass"],
    openPullRequest: true,
  });
  it("asks a short question with scope and boundaries", () => {
    const text = briefPrompt(brief, "J-142", "default model");
    expect(text).toContain("I'll add retries in sync-service");
    expect(text).toContain("open a draft PR");
    expect(text).toContain("Leave webhooks alone.");
    expect(text).toContain("production and customer data read-only");
    expect(text).toContain("Want me to start?");
    expect(text).not.toMatch(/Full brief|Edit|default model/);
  });
  it("explains trusted starts and gives full details on request", () => {
    expect(briefPrompt(brief, "J-142", undefined, { name: "retry", trusted: true })).toContain(
      "trusted playbook retry",
    );
    const text = fullBrief(brief, "J-142");
    expect(text).toContain("J-142: add retries");
    expect(text).toContain("I'll check: Tests pass");
    expect(text).not.toContain("☐");
  });
});
