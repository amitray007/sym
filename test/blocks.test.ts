import { describe, expect, it } from "vitest";
import { feedbackBlocks, feedbackEnabled } from "../lib/feedback/feedback.ts";
import {
  clipText,
  failurePost,
  HEADER_MAX,
  MAX_BLOCKS,
  resultPost,
  SECTION_MAX,
  safeMrkdwn,
} from "../lib/jobs/blocks.ts";
import type { OutputContract } from "../lib/jobs/contract.ts";

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

type B = { type: string; [key: string]: unknown };

// The action IDs of a post's buttons, in order.
const actionIds = (blocks: unknown[]) =>
  (blocks as B[])
    .filter((b) => b.type === "actions")
    .flatMap((b) => (b.elements as { action_id?: string }[]).map((e) => e.action_id));

describe("resultPost", () => {
  const post = resultPost(
    job,
    contract,
    ["worker opened a PR the job didn't allow.", "no test covers <the> limit."],
    "*⚠️ check before merge* (75% sure)",
  );
  const blocks = post.blocks as B[];

  it("lays out header, gist, verdict, concerns, questions, footer, and button", () => {
    expect(blocks.map((b) => b.type)).toEqual([
      "header",
      "section",
      "section",
      "rich_text",
      "section",
      "context",
      "actions",
    ]);
    expect(blocks[0]).toEqual({
      type: "header",
      text: { type: "plain_text", text: "⚠️ J-142 · Billing sync retry · 14m", emoji: true },
    });
    expect(blocks[1]).toMatchObject({ text: { text: "*tl;dr* Added retry with backoff." } });
    expect(blocks[2]).toMatchObject({ text: { text: "*⚠️ check before merge* (75% sure)" } });
  });

  it("lists concerns as an ordered rich text list, as typed", () => {
    expect(blocks[3]).toEqual({
      type: "rich_text",
      elements: [
        {
          type: "rich_text_list",
          style: "ordered",
          elements: [
            {
              type: "rich_text_section",
              elements: [{ type: "text", text: "worker opened a PR the job didn't allow." }],
            },
            {
              type: "rich_text_section",
              elements: [{ type: "text", text: "no test covers <the> limit." }],
            },
          ],
        },
      ],
    });
  });

  it("lists open questions, the footer facts, and an Open PR link button", () => {
    expect(blocks[4]).toMatchObject({ text: { text: "*open questions*\n☐ Cap at 5 tries?" } });
    expect(blocks[5]).toEqual({
      type: "context",
      elements: [
        { type: "mrkdwn", text: "tests: 12 passed" },
        { type: "mrkdwn", text: "3 files changed" },
      ],
    });
    expect(blocks[6]).toMatchObject({
      type: "actions",
      block_id: "job-J-142-result",
      elements: [
        { type: "button", url: "https://github.com/o/r/pull/812", text: { text: "Open PR" } },
        { action_id: "sym_job_ok", value: "J-142", text: { text: "Looks good" } },
        { action_id: "sym_job_fix", value: "J-142", text: { text: "Fix…" } },
        { action_id: "sym_job_close", value: "J-142", text: { text: "Close" } },
      ],
    });
  });

  it("keeps the mrkdwn message as the fallback text", () => {
    expect(post.text).toContain("⚠️ *J-142 · Billing sync retry* · 14m");
    expect(post.text).toContain("1. worker opened a PR the job didn't allow.");
    expect(post.text).toContain("2. no test covers &lt;the&gt; limit.");
  });

  it("adds no button without a PR, and no footer without facts", () => {
    const bare = resultPost(
      { ref: "J-1", title: "T" },
      { ...contract, prUrl: null, tests: "", filesChanged: [], openQuestions: [] },
    );
    expect((bare.blocks as B[]).map((b) => b.type)).toEqual(["header", "section", "actions"]);
    expect(actionIds(bare.blocks)).toEqual(["sym_job_ok", "sym_job_fix", "sym_job_close"]);
    expect(bare.text).toContain("*tl;dr*");
  });

  it("gives no button for a URL that is not http", () => {
    const odd = resultPost(job, { ...contract, prUrl: "ftp://x.test/pull/1" });
    expect(actionIds(odd.blocks)).toEqual(["sym_job_ok", "sym_job_fix", "sym_job_close"]);
  });

  it("shows a clean verdict as its own section", () => {
    const clean = resultPost(job, contract, [], "✅ verifier: matches the brief (90% sure)");
    expect((clean.blocks as B[])[2]).toMatchObject({
      text: { text: "✅ verifier: matches the brief (90% sure)" },
    });
  });

  it("points at the worker thread when there is no result", () => {
    const none = resultPost(job, null);
    const types = (none.blocks as B[]).map((b) => b.type);
    expect(types).toEqual(["header", "section", "context", "actions"]);
    expect(JSON.stringify(none.blocks)).toContain("thr_8f2c");
  });

  it("escapes worker text in sections", () => {
    const evil = resultPost(job, { ...contract, summary: "<!channel> & <@U1>" });
    expect(JSON.stringify(evil.blocks)).toContain("&lt;!channel&gt; &amp; &lt;@U1&gt;");
  });

  it("respects Slack limits and marks cuts with an ellipsis", () => {
    const huge = "x".repeat(10_000);
    const big = resultPost(
      { ref: "J-9", title: huge, durationMs: 60_000 },
      { ...contract, summary: huge, openQuestions: Array.from({ length: 80 }, () => huge) },
      Array.from({ length: 80 }, () => huge),
      "*⚠️ check before merge* (50% sure)",
    );
    const all = big.blocks as B[];
    expect(all.length).toBeLessThanOrEqual(MAX_BLOCKS);
    const header = all[0] as unknown as { text: { text: string } };
    expect(header.text.text.length).toBeLessThanOrEqual(HEADER_MAX);
    expect(header.text.text.endsWith(" · 1m")).toBe(true);
    for (const block of all) {
      const text = (block.text as { text?: string } | undefined)?.text;
      if (block.type === "section" && text) expect(text.length).toBeLessThanOrEqual(SECTION_MAX);
    }
    const rich = all.find((b) => b.type === "rich_text") as unknown as { elements: B[] };
    const list = rich.elements[0] as unknown as { elements: unknown[] };
    expect(list.elements).toHaveLength(11);
    expect(JSON.stringify(list.elements.at(-1))).toContain("…and 70 more");
  });
});

describe("failurePost", () => {
  it("shows header, reason, and the thread", () => {
    const post = failurePost(job, "Build <broke>");
    expect(post.blocks).toEqual([
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "❌ J-142 · Billing sync retry · failed in 14m",
          emoji: true,
        },
      },
      { type: "section", text: { type: "mrkdwn", text: "Build &lt;broke&gt;" } },
      { type: "context", elements: [{ type: "mrkdwn", text: "Worker thread: `thr_8f2c`" }] },
      {
        type: "actions",
        block_id: "job-J-142-result",
        elements: [
          {
            type: "button",
            action_id: "sym_job_fix",
            text: { type: "plain_text", text: "Fix…" },
            value: "J-142",
          },
          {
            type: "button",
            action_id: "sym_job_close",
            text: { type: "plain_text", text: "Close" },
            value: "J-142",
          },
        ],
      },
    ]);
    expect(post.text).toContain("Build &lt;broke&gt;");
  });

  it("has a default reason and no thread line without a thread", () => {
    const post = failurePost({ ref: "J-2", title: "X" });
    expect((post.blocks as B[]).map((b) => b.type)).toEqual(["header", "section", "actions"]);
    expect(JSON.stringify(post.blocks)).toContain("the worker stopped before it finished.");
  });
});

describe("text helpers", () => {
  it("clips with an ellipsis", () => {
    expect(clipText("abcdef", 4)).toBe("abc…");
    expect(clipText("abc", 4)).toBe("abc");
  });

  it("keeps escaped text within the limit without cutting an entity", () => {
    const out = safeMrkdwn("<".repeat(100), 50);
    expect(out.length).toBeLessThanOrEqual(50);
    expect(out).not.toMatch(/&(l|lt|g|gt)?$/);
  });
});

describe("SYM_FEEDBACK", () => {
  it("is on unless set to an off value", () => {
    expect(feedbackEnabled({})).toBe(true);
    expect(feedbackEnabled({ SYM_FEEDBACK: "on" })).toBe(true);
    expect(feedbackEnabled({ SYM_FEEDBACK: "maybe" })).toBe(true);
    expect(feedbackEnabled({ SYM_FEEDBACK: "" })).toBe(true);
    for (const value of ["off", "OFF", "false", "0", "no", " No "]) {
      expect(feedbackEnabled({ SYM_FEEDBACK: value })).toBe(false);
    }
  });

  it("removes the feedback buttons only when off", () => {
    expect(feedbackBlocks({})).toHaveLength(1);
    expect(feedbackBlocks({ SYM_FEEDBACK: "off" })).toEqual([]);
  });

  it("leaves the Open PR button on a result, with no feedback action ids", () => {
    const json = JSON.stringify(resultPost(job, contract).blocks);
    expect(json).toContain('"sym_job_pr"');
    expect(json).not.toContain("sym_feedback");
  });
});
