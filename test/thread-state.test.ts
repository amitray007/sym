import { loadThreadContextMessages } from "eve/channels/slack";
import { describe, expect, it } from "vitest";
import {
  endQuietTurn,
  isLastPostBoundary,
  isQuietTurn,
  markOutboxPosts,
  markQuietTurn,
  markThreadSession,
  threadKey,
} from "../lib/slack/thread-state.ts";

type Messages = Parameters<typeof loadThreadContextMessages>[0]["recentMessages"];

function message(ts: string, isMe = false, threadTs = "1.0") {
  return { ts, threadTs, isMe, text: ts, markdown: ts, user: "U1", botId: undefined, raw: {} };
}

async function contextFor(threadTs: string) {
  const recentMessages = [
    message("1.0", false, threadTs),
    message("1.1", true, threadTs),
    message("1.2", false, threadTs),
    message("1.3", true, threadTs),
    message("1.4", false, threadTs),
    message("1.5", false, threadTs),
  ] as unknown as Messages;
  const thread = { recentMessages, refresh: async () => {} };
  const found = await loadThreadContextMessages(
    thread,
    { threadTs, ts: "1.5" },
    { since: isLastPostBoundary },
  );
  return found.map((m) => m.ts);
}

describe("the thread context boundary", () => {
  it("gives the whole thread when the thread has no session", async () => {
    markThreadSession("1.0", false);
    expect(await contextFor("1.0")).toEqual(["1.0", "1.1", "1.2", "1.3", "1.4"]);
  });

  it("gives only the messages after Sym's last post when the thread has a session", async () => {
    markThreadSession("2.0", true);
    expect(await contextFor("2.0")).toEqual(["1.4"]);
  });

  it("returns to the whole thread once a session ends", async () => {
    markThreadSession("3.0", true);
    markThreadSession("3.0", false);
    expect(await contextFor("3.0")).toHaveLength(5);
  });

  it("ignores a post that Sym did not write", () => {
    markThreadSession("4.0", true);
    expect(isLastPostBoundary({ isMe: false, threadTs: "4.0", ts: "4.1" })).toBe(false);
  });

  it("skips Sym's outbox posts, which the session never saw", async () => {
    markThreadSession("6.0", true);
    markOutboxPosts(["1.3"]);
    // 1.3 is an outbox post, so the boundary is 1.1 and the context keeps the result.
    expect(await contextFor("6.0")).toEqual(["1.2", "1.3", "1.4"]);
    markOutboxPosts(["1.1"]);
    expect(await contextFor("6.0")).toEqual(["1.0", "1.1", "1.2", "1.3", "1.4"]);
  });
});

describe("quiet turns", () => {
  it("stay quiet until real work ends them", () => {
    const key = threadKey("C1", "1.0", "U1");
    expect(isQuietTurn(key)).toBe(false);
    markQuietTurn(key);
    expect(isQuietTurn(key)).toBe(true);
    expect(isQuietTurn(threadKey("C1", "1.0", "U2"))).toBe(false);
    // Another person's turn in the same thread is not affected.
    endQuietTurn(threadKey("C1", "1.0", "U2"));
    expect(isQuietTurn(key)).toBe(true);
    endQuietTurn(key);
    expect(isQuietTurn(key)).toBe(false);
    expect(isQuietTurn(undefined)).toBe(false);
  });
});
