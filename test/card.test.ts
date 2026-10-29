import { describe, expect, it } from "vitest";
import {
  buttonUrl,
  formatDuration,
  prLabel,
  renderCollapsedCard,
  renderJobCard,
} from "../lib/jobs/card.ts";

const input = {
  ref: "J-142",
  title: "Retry",
  status: "running" as const,
  latestSummary: "Found the retry loop. Adding backoff.",
  skipping: "the webhook path",
  startedAt: 0,
  lastActivityAt: 480_000,
  now: 540_000,
  worker: "Builder",
  version: 4,
};
describe("working note", () => {
  it("shows explicit worker progress and a muted factual meta line", () => {
    const post = renderJobCard({ ...input, prUrl: "https://github.com/o/r/pull/812" });
    expect(post.text).toContain(
      "Found the retry loop. Adding backoff. I'm leaving the webhook path alone.",
    );
    expect(post.text).toContain("J-142 · 9m · Builder · PR #812");
    expect(post.blocks.map((b) => b.type)).toEqual(["section", "context"]);
    expect(JSON.stringify(post.blocks)).not.toMatch(/plan|actions|Stop|Steer/);
  });
  it("uses the real phase while checking, blocked, or offline", () => {
    expect(renderJobCard({ ...input, status: "checking" }).text).toContain(
      "I'm checking the result.",
    );
    expect(renderJobCard({ ...input, status: "worker_offline" }).text).toContain("can't reach");
    expect(renderJobCard({ ...input, status: "waiting_input" }).text).toContain(
      "waiting for your answer",
    );
  });
  it("does not invent a work step without explicit progress", () => {
    expect(renderJobCard({ ...input, latestSummary: null }).text).toContain(
      "waiting for an update",
    );
    expect(renderJobCard({ ...input, now: 25 * 60_000, lastActivityAt: 0 }).text).toContain(
      "for 25m",
    );
  });
  it("escapes worker text and has no controls on a finished note", () => {
    expect(renderJobCard({ ...input, latestSummary: "<!channel> & <@U1>" }).text).toContain(
      "&lt;!channel&gt;",
    );
    const end = renderCollapsedCard({
      ...input,
      status: "done",
      prUrl: "https://github.com/o/r/pull/812",
    });
    expect(end.blocks.map((b) => b.type)).toEqual(["context"]);
    expect(end.text).toContain("PR #812");
  });
});
describe("fact helpers", () => {
  it("formats durations and PR labels", () => {
    expect(formatDuration(65 * 60_000)).toBe("1h 5m");
    expect(formatDuration(45_000)).toBe("45s");
    expect(prLabel("https://example.com/x/pull/812")).toBe("PR #812");
  });
  it("rejects non-web button targets", () => {
    expect(buttonUrl("ftp://example.com/file")).toBeNull();
    expect(buttonUrl(null)).toBeNull();
  });
});
