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
  it("leads with the status and the gist, and lists the facts", () => {
    expect(resultMessage(job, contract)).toBe(
      [
        "✅ *J-142 · Billing sync retry* · 14m",
        "*tl;dr* Added retry with backoff.",
        "",
        "*open questions*",
        "☐ Cap at 5 tries?",
        "",
        "🔗 <https://github.com/o/r/pull/812|PR #812> · tests: 12 passed · 3 files changed",
      ].join("\n"),
    );
  });

  it("skips empty parts and uses the singular", () => {
    const text = resultMessage(
      { ref: "J-1", title: "T" },
      { ...contract, prUrl: null, tests: "", filesChanged: ["a.ts"], openQuestions: [] },
    );
    expect(text).toBe("✅ *J-1 · T*\n*tl;dr* Added retry with backoff.\n\n1 file changed");
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

  it("numbers the concerns under a header that carries the verdict", () => {
    const text = resultMessage(
      job,
      { ...contract, openQuestions: [] },
      ["No test covers <the> limit.", "CI was not checked."],
      "*⚠️ check before merge* (70% sure)",
    );
    expect(text).toContain("⚠️ *J-142 · Billing sync retry* · 14m");
    expect(text).toContain(
      "*⚠️ check before merge* (70% sure)\n1. No test covers &lt;the&gt; limit.\n2. CI was not checked.",
    );
  });

  it("uses the plain header when there are concerns and no model verdict", () => {
    const text = resultMessage(job, contract, ["Something is off."]);
    expect(text).toContain("*⚠️ check before merge*\n1. Something is off.");
  });

  it("shows a clean verdict as one line under the gist", () => {
    const text = resultMessage(job, contract, [], "✅ verifier: matches the brief (90% sure)");
    expect(text).toContain("*tl;dr* Added retry with backoff.\n✅ verifier: matches the brief");
  });

  it("drops an open question that a concern already covers", () => {
    const text = resultMessage(
      job,
      {
        ...contract,
        openQuestions: ["CI status for head 271896a was not checked", "Cap at 5 tries?"],
      },
      ["CI status for head 271896a was not checked before recommending merge."],
    );
    expect(text).not.toContain("CI status for head 271896a was not checked\n");
    expect(text).toContain("☐ Cap at 5 tries?");
    expect(text.match(/271896a/g)).toHaveLength(1);
  });

  it("does not show the raw worker thread line on a normal result", () => {
    expect(resultMessage(job, contract)).not.toContain("thr_8f2c");
  });

  it("explains a missing contract and keeps the thread pointer", () => {
    const text = resultMessage(job, null);
    expect(text).toContain("⚠️ *J-142 · Billing sync retry* · 14m");
    expect(text).toContain("no result summary");
    expect(text).toContain("`thr_8f2c`");
  });

  it("keeps only the first clause of a long tests note", () => {
    const text = resultMessage(job, {
      ...contract,
      tests: "not run; read-only review, test logic verified by reading",
    });
    expect(text).toContain("tests: not run ·");
    expect(text).not.toContain("read-only review");
  });

  it("renders the owner's example", () => {
    const text = resultMessage(
      { ref: "J-3", title: "Review PR #7698 billing_core data:null fix", durationMs: 60_000 },
      {
        summary:
          "Merge PR #7698: the one-line fix is correct. All callers I checked handle a null-data response, and the new test fails on the old code. Only low-severity follow-ups remain.",
        prUrl: "https://github.com/o/r/pull/7698",
        tests: "not run; read-only review, test logic verified by reading",
        filesChanged: [],
        openQuestions: [
          "CI status for head 271896a was not checked",
          "Should the other .get('data', {}) sites in api_functions.py get a follow-up issue?",
        ],
      },
      [
        "worker opened a PR the job didn't allow.",
        "Tests were not run, so fail-before / pass-after is unverified.",
        "CI status for head 271896a was not checked before recommending merge.",
      ],
      "*⚠️ check before merge* (75% sure)",
    );
    expect(text).toBe(
      [
        "⚠️ *J-3 · Review PR #7698 billing_core data:null fix* · 1m",
        "*tl;dr* Merge PR #7698: the one-line fix is correct.",
        "",
        "*⚠️ check before merge* (75% sure)",
        "1. worker opened a PR the job didn't allow.",
        "2. Tests were not run, so fail-before / pass-after is unverified.",
        "3. CI status for head 271896a was not checked before recommending merge.",
        "",
        "*open questions*",
        "☐ Should the other .get('data', {}) sites in api_functions.py get a follow-up issue?",
        "",
        "🔗 <https://github.com/o/r/pull/7698|PR #7698> · tests: not run",
      ].join("\n"),
    );
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
  it("formats a failure with and without a reason", () => {
    expect(failureMessage(job, "Build <broke>")).toBe(
      "❌ *J-142 · Billing sync retry* · failed in 14m\nBuild &lt;broke&gt;\nWorker thread: `thr_8f2c`",
    );
    expect(failureMessage({ ref: "J-2", title: "X" })).toBe(
      "❌ *J-2 · X* · failed\nthe worker stopped before it finished.",
    );
  });

  it("words the permission DM", () => {
    expect(permissionBlockMessage("J-142")).toBe(
      "🔒 J-142 is waiting for a permission prompt on the worker. Approve it in the worker.",
    );
  });

  it("words the quiet notice", () => {
    expect(quietNotice(job, 25 * 60_000)).toBe(
      "⏳ J-142 has had no new activity for 25m. still running.\nWorker thread: `thr_8f2c`",
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

  it("shows only the title, project, and delivery", () => {
    expect(briefPrompt(brief, "J-142")).toBe(
      [
        "📋 *J-142 · Billing sync retry*",
        "*project* sync-service · *delivery* push the branch and open a draft PR",
        "press *Start* to run it, *Edit* to change it, or *Cancel*.",
      ].join("\n"),
    );
  });

  it("puts the goal, constraints, and done-when list in the full brief", () => {
    expect(fullBrief(brief, "J-142")).toBe(
      [
        "📋 *J-142 · Billing sync retry*",
        "*project* sync-service",
        "*goal* Retry failed syncs &amp; log them.",
        "*constraints*\n• No schema changes",
        "*done when*\n☐ Tests pass\n☐ Retries are capped",
        "*delivery* push the branch and open a draft PR",
      ].join("\n"),
    );
  });

  it("omits empty constraints and the ref", () => {
    const text = fullBrief({ ...brief, constraints: [], openPullRequest: false });
    expect(text).not.toContain("constraints");
    expect(text.startsWith("📋 *Billing sync retry*")).toBe(true);
    expect(text).toContain("no push, no PR");
  });
});
