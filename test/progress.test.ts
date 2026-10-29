import { describe, expect, it } from "vitest";
import { detectEvents, findPullRequestUrl, type ProgressState } from "../lib/jobs/progress.ts";

const MIN = 60_000;
const T0 = 10_000_000;

const running: ProgressState = { status: "running", quietSince: T0 };
const item = (text: string) => ({ type: "message", text });

describe("findPullRequestUrl", () => {
  it.each([
    [
      "Opened https://github.com/example/app/pull/812 for review",
      "https://github.com/example/app/pull/812",
    ],
    [
      "see https://gitlab.com/g/sub/p/-/merge_requests/7.",
      "https://gitlab.com/g/sub/p/-/merge_requests/7",
    ],
    ["https://github.com/example/app/issues/3", undefined],
    ["https://github.com/example/app/pull/", undefined],
    ["no link", undefined],
  ])("%s", (text, expected) => {
    expect(findPullRequestUrl([item(text)])).toBe(expected);
  });
});

describe("detectEvents", () => {
  it("reports the first PR URL once", () => {
    const first = detectEvents(running, {
      status: "running",
      newItems: [item("PR: https://github.com/a/b/pull/5")],
      now: T0 + MIN,
    });
    expect(first.events).toEqual([{ type: "pr_opened", url: "https://github.com/a/b/pull/5" }]);
    expect(first.state.prUrl).toBe("https://github.com/a/b/pull/5");

    const again = detectEvents(first.state, {
      status: "running",
      newItems: [item("also https://github.com/a/b/pull/6")],
      now: T0 + 2 * MIN,
    });
    expect(again.events).toEqual([]);
    expect(again.state.prUrl).toBe("https://github.com/a/b/pull/5");
  });

  it("reports needs_input and needs_permission only on entering the state", () => {
    const enter = (status: "waiting_input" | "waiting_permission") =>
      detectEvents(running, { status, newItems: [], now: T0 + MIN }).events;
    expect(enter("waiting_input")).toEqual([{ type: "needs_input" }]);
    expect(enter("waiting_permission")).toEqual([{ type: "needs_permission" }]);

    const staying = detectEvents(
      { status: "waiting_input", quietSince: T0 },
      { status: "waiting_input", newItems: [], now: T0 + 5 * MIN },
    );
    expect(staying.events).toEqual([]);
  });

  it("reports finished and failed once", () => {
    const done = detectEvents({ status: "checking" }, { status: "done", newItems: [], now: T0 });
    expect(done.events).toEqual([{ type: "finished" }]);
    const failed = detectEvents(running, { status: "failed", newItems: [], now: T0 });
    expect(failed.events).toEqual([{ type: "failed" }]);
    const late = detectEvents({ status: "done" }, { status: "done", newItems: [], now: T0 });
    expect(late.events).toEqual([]);
  });

  it("does not report cancelled", () => {
    expect(detectEvents(running, { status: "cancelled", newItems: [], now: T0 }).events).toEqual(
      [],
    );
  });

  describe("quiet", () => {
    const at = (
      minutes: number,
      prev: ProgressState = running,
      items = [] as ReturnType<typeof item>[],
    ) => detectEvents(prev, { status: "running", newItems: items, now: T0 + minutes * MIN });

    it("waits for 45 minutes without items", () => {
      expect(at(44).events).toEqual([]);
      expect(at(45).events).toEqual([{ type: "quiet" }]);
    });

    it("resets on new items", () => {
      const active = at(19, running, [item("edit")]);
      expect(active.events).toEqual([]);
      expect(active.state.quietSince).toBe(T0 + 19 * MIN);
      expect(at(30, active.state).events).toEqual([]);
      expect(at(64, active.state).events).toEqual([{ type: "quiet" }]);
    });

    it("posts once per job", () => {
      const first = at(45);
      expect(first.state.lastQuietPostAt).toBe(T0 + 45 * MIN);
      const quiet: ProgressState = { ...first.state, status: "quiet" };
      expect(at(60, quiet).events).toEqual([]);
      expect(at(180, quiet).events).toEqual([]);
    });

    it("starts counting at the first look when quietSince is unknown", () => {
      const first = detectEvents(
        { status: "running" },
        { status: "running", newItems: [], now: T0 },
      );
      expect(first.events).toEqual([]);
      expect(first.state.quietSince).toBe(T0);
    });

    it("stays silent for a waiting job", () => {
      const prev: ProgressState = { status: "waiting_input", quietSince: T0 };
      const result = detectEvents(prev, {
        status: "waiting_input",
        newItems: [],
        now: T0 + 90 * MIN,
      });
      expect(result.events).toEqual([]);
    });
  });

  it("can report several events in a fixed order", () => {
    const result = detectEvents(running, {
      status: "waiting_permission",
      newItems: [item("https://github.com/a/b/pull/9")],
      now: T0 + MIN,
    });
    expect(result.events.map((e) => e.type)).toEqual(["pr_opened", "needs_permission"]);
  });
});
