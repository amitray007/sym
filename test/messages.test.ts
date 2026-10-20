import { describe, expect, it } from "vitest";
import { Brief } from "../lib/jobs/brief.ts";
import type { OutputContract } from "../lib/jobs/contract.ts";
import {
  briefPrompt,
  escapeMrkdwn,
  failureMessage,
  permissionBlockMessage,
  quietNotice,
  resultMessage,
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
  it("leads with the verdict and lists the facts", () => {
    expect(resultMessage(job, contract)).toBe(
      [
        "*J-142 done in 14m:* Billing sync retry",
        "Added retry with backoff.",
        "Draft PR: <https://github.com/o/r/pull/812|PR #812>",
        "Tests: 12 passed",
        "3 files changed",
        "Open questions:",
        "• Cap at 5 tries?",
        "Worker thread: `thr_8f2c`",
      ].join("\n"),
    );
  });

  it("skips empty parts and uses the singular", () => {
    const text = resultMessage(
      { ref: "J-1", title: "T" },
      { ...contract, prUrl: null, tests: "", filesChanged: ["a.ts"], openQuestions: [] },
    );
    expect(text).toBe("*J-1 done:* T\nAdded retry with backoff.\n1 file changed");
  });

  it("escapes worker text so it cannot ping or link", () => {
    const text = resultMessage(job, { ...contract, summary: "<!channel> & <@U1>" });
    expect(text).toContain("&lt;!channel&gt; &amp; &lt;@U1&gt;");
    expect(text).not.toContain("<!channel>");
  });

  it("strips characters that break a link", () => {
    const text = resultMessage(job, { ...contract, prUrl: "https://x.test/pull/1>|evil" });
    expect(text).toContain("<https://x.test/pull/1evil|PR #1>");
  });

  it("puts the verdict line above the concerns", () => {
    const text = resultMessage(
      job,
      { ...contract, openQuestions: [] },
      ["No test covers <the> limit."],
      "Verdict: check the concerns below (70% confidence).",
    );
    expect(text).toContain(
      "Verdict: check the concerns below (70% confidence).\nCheck before you merge:\n• No test covers &lt;the&gt; limit.",
    );
  });

  it("explains a missing contract", () => {
    const text = resultMessage(job, null);
    expect(text).toContain("no result summary");
    expect(text).toContain("`thr_8f2c`");
  });
});

describe("other messages", () => {
  it("formats a failure with and without a reason", () => {
    expect(failureMessage(job, "Build <broke>")).toBe(
      "*J-142 failed in 14m:* Billing sync retry\nBuild &lt;broke&gt;\nWorker thread: `thr_8f2c`",
    );
    expect(failureMessage({ ref: "J-2", title: "X" })).toBe(
      "*J-2 failed:* X\nThe worker stopped before it finished.",
    );
  });

  it("words the permission DM", () => {
    expect(permissionBlockMessage("J-142")).toBe(
      "J-142 is waiting for a permission prompt on the worker. Approve it in the worker.",
    );
  });

  it("words the quiet notice", () => {
    expect(quietNotice(job, 25 * 60_000)).toBe(
      "J-142 has had no new activity for 25m. It is still running.\nWorker thread: `thr_8f2c`",
    );
  });
});

describe("briefPrompt", () => {
  const brief = Brief.parse({
    project: "sync-service",
    title: "Billing sync retry",
    goal: "Retry failed syncs & log them.",
    constraints: ["No schema changes"],
    doneWhen: ["Tests pass", "Retries are capped"],
    openPullRequest: true,
  });

  it("shows title, project, goal, constraints, done-when, and delivery", () => {
    expect(briefPrompt(brief, "J-142")).toBe(
      [
        "*J-142: Billing sync retry*",
        "Project: sync-service",
        "Goal: Retry failed syncs &amp; log them.",
        "Constraints:\n• No schema changes",
        "Done when:\n• Tests pass\n• Retries are capped",
        "Delivery: Push the branch and open a draft PR.",
        "Press Start below to run it, Edit to change it, or Cancel.",
      ].join("\n"),
    );
  });

  it("omits empty constraints and the ref", () => {
    const text = briefPrompt({ ...brief, constraints: [], openPullRequest: false });
    expect(text).not.toContain("Constraints");
    expect(text.startsWith("*Billing sync retry*")).toBe(true);
    expect(text).toContain("No push, no PR.");
  });
});
