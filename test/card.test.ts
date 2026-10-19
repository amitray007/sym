import { describe, expect, it } from "vitest";
import {
  formatDuration,
  type JobCardInput,
  jobCardSteps,
  renderCollapsedCard,
  renderJobCard,
} from "../lib/jobs/card.ts";

const base: JobCardInput = {
  status: "running",
  threadStarted: true,
  doneWhen: ["Tests pass", "No lint errors"],
};

const states = (input: JobCardInput) => jobCardSteps(input).map((step) => step.status);
const text = (rt?: { elements: { elements: { text: string }[] }[] }) =>
  rt?.elements[0]?.elements[0]?.text;

describe("formatDuration", () => {
  it.each([
    [0, "0s"],
    [-5000, "0s"],
    [45_000, "45s"],
    [60_000, "1m"],
    [14 * 60_000 + 59_000, "14m"],
    [60 * 60_000, "1h"],
    [65 * 60_000, "1h 5m"],
    [25 * 3_600_000 + 60_000, "25h 1m"],
  ])("%d ms -> %s", (value, expected) => {
    expect(formatDuration(value)).toBe(expected);
  });
});

describe("jobCardSteps", () => {
  it("lists approved, thread, working, each done-when item, and the check", () => {
    const steps = jobCardSteps(base);
    expect(steps.map((s) => s.title)).toEqual([
      "Brief approved",
      "Worker thread started",
      "Working",
      "Tests pass",
      "No lint errors",
      "Check result",
    ]);
    expect(states(base)).toEqual([
      "complete",
      "complete",
      "in_progress",
      "pending",
      "pending",
      "pending",
    ]);
  });

  it("uses unique task IDs", () => {
    const ids = jobCardSteps(base).map((s) => s.task_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("shows the thread row in progress while launching", () => {
    expect(states({ ...base, status: "launching", threadStarted: false }).slice(0, 3)).toEqual([
      "complete",
      "in_progress",
      "pending",
    ]);
  });

  it("puts the latest summary on the working row", () => {
    const steps = jobCardSteps({ ...base, latestSummary: "Edited   3 files\nso far" });
    expect(text(steps[2]?.output)).toBe("Edited 3 files so far");
  });

  it("checks the result after the work completes", () => {
    expect(states({ ...base, status: "checking" })).toEqual([
      "complete",
      "complete",
      "complete",
      "pending",
      "pending",
      "in_progress",
    ]);
  });

  it("completes every row when done", () => {
    expect(new Set(states({ ...base, status: "done" }))).toEqual(new Set(["complete"]));
  });

  it("marks the working row as error on failure", () => {
    expect(states({ ...base, status: "failed" }).slice(0, 3)).toEqual([
      "complete",
      "complete",
      "error",
    ]);
  });

  it("marks the thread row as error when the job fails before launch", () => {
    const s = states({ ...base, status: "failed", threadStarted: false });
    expect(s.slice(0, 3)).toEqual(["complete", "error", "pending"]);
  });

  it("shows a waiting note for input and permission", () => {
    const input = jobCardSteps({ ...base, status: "waiting_input" })[2];
    const perm = jobCardSteps({ ...base, status: "waiting_permission" })[2];
    expect(input?.status).toBe("in_progress");
    expect(text(input?.details)).toMatch(/^Waiting for you/);
    expect(text(perm?.details)).toMatch(/^Waiting for you.*permission/);
  });

  it("keeps a running job free of notes", () => {
    expect(jobCardSteps(base)[2]?.details).toBeUndefined();
  });

  it("stays within 50 tasks", () => {
    const doneWhen = Array.from({ length: 80 }, (_, i) => `item ${i}`);
    const steps = jobCardSteps({ ...base, doneWhen });
    expect(steps).toHaveLength(50);
    expect(steps[48]?.title).toContain("(+34 more)");
    expect(steps[49]?.title).toBe("Check result");
  });
});

describe("renderJobCard", () => {
  const start = Date.UTC(2026, 0, 1, 12, 0, 0);
  const input = {
    ref: "J-142",
    title: "Billing sync retry",
    status: "running" as const,
    steps: jobCardSteps(base),
    startedAt: start,
    now: start + 14 * 60_000 + 20_000,
    footer: { worker: "Codex", threadId: "8f2c1d", updatedAt: start + 13 * 60_000 },
    version: 3,
  };

  it("builds a plan block and a context footer", () => {
    const { blocks, text: fallback } = renderJobCard(input);
    expect(fallback).toBe("[J-142] Billing sync retry · running 14m");
    expect(blocks[0]).toMatchObject({
      type: "plan",
      block_id: "job-J-142-v3",
      title: "[J-142] Billing sync retry · running 14m",
    });
    expect(blocks[1]).toEqual({
      type: "context",
      elements: [{ type: "mrkdwn", text: "Codex · thread 8f2c1d · updated 1 min ago" }],
    });
  });

  it("changes block_id with the version", () => {
    const next = renderJobCard({ ...input, version: 4 }).blocks[0];
    expect(next).toMatchObject({ block_id: "job-J-142-v4" });
  });

  it("says just now when the update is fresh and omits a missing thread", () => {
    const { blocks } = renderJobCard({
      ...input,
      footer: { worker: "Codex" },
    });
    expect(blocks[1]).toMatchObject({ elements: [{ text: "Codex · updated just now" }] });
  });

  it("names a waiting job in the title", () => {
    expect(renderJobCard({ ...input, status: "waiting_permission" }).text).toContain(
      "waiting for you 14m",
    );
  });

  it("escapes control characters in the footer", () => {
    const { blocks } = renderJobCard({ ...input, footer: { worker: "A<b>&", threadId: "t<1>" } });
    expect(blocks[1]).toMatchObject({
      elements: [{ text: expect.stringContaining("A&lt;b&gt;&amp; · thread t&lt;1&gt;") }],
    });
  });
});

describe("renderCollapsedCard", () => {
  const start = 1_000_000;
  const common = {
    ref: "J-142",
    title: "Billing sync retry",
    startedAt: start,
    now: start + 840_000,
  };

  it("collapses a done job to one line with the PR number", () => {
    const card = renderCollapsedCard({
      ...common,
      status: "done",
      prUrl: "https://github.com/o/r/pull/812",
    });
    expect(card.text).toBe("[J-142] Billing sync retry · Done in 14m · PR #812");
    expect(card.blocks).toEqual([{ type: "section", text: { type: "mrkdwn", text: card.text } }]);
  });

  it("omits the PR when there is none or the URL has no number", () => {
    expect(renderCollapsedCard({ ...common, status: "done" }).text).toBe(
      "[J-142] Billing sync retry · Done in 14m",
    );
    expect(renderCollapsedCard({ ...common, status: "done", prUrl: "https://x.test/y" }).text).toBe(
      "[J-142] Billing sync retry · Done in 14m",
    );
  });

  it("reads a GitLab merge request", () => {
    const text = renderCollapsedCard({
      ...common,
      status: "done",
      prUrl: "https://gitlab.com/g/p/-/merge_requests/7",
    }).text;
    expect(text).toMatch(/PR #7$/);
  });

  it("words failed and cancelled ends", () => {
    expect(renderCollapsedCard({ ...common, status: "failed" }).text).toContain("Failed after 14m");
    expect(renderCollapsedCard({ ...common, status: "cancelled" }).text).toContain(
      "Cancelled after 14m",
    );
  });
});
