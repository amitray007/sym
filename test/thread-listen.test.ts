import { describe, expect, it } from "vitest";
import { getListenMode, setListenMode } from "../lib/ledger/listen.ts";
import { enqueuePost, markPostSent, sentPostTimestamps } from "../lib/ledger/outbox.ts";
import { lastTurnUser, recordSessionThread } from "../lib/ledger/threads.ts";
import { changeListenMode, LISTEN_DM, LISTEN_NO_THREAD } from "../lib/slack/listen-setting.ts";
import { hasDatabase, useLedger } from "./helpers/ledger.ts";

describe.skipIf(!hasDatabase)("thread listen mode", () => {
  const ledger = useLedger();

  it("defaults to all and keeps one mode per thread", async () => {
    const sql = ledger.sql();
    expect(await getListenMode(sql, "C1", "1.0")).toBe("all");
    await setListenMode(sql, {
      channelId: "C1",
      threadTs: "1.0",
      mode: "mention-only",
      updatedBy: "U1",
    });
    expect(await getListenMode(sql, "C1", "1.0")).toBe("mention-only");
    expect(await getListenMode(sql, "C1", "2.0")).toBe("all");
    expect(await getListenMode(sql, "C2", "1.0")).toBe("all");
    await setListenMode(sql, { channelId: "C1", threadTs: "1.0", mode: "all", updatedBy: "U2" });
    expect(await getListenMode(sql, "C1", "1.0")).toBe("all");
    const rows = await sql`select updated_by from thread_listen where channel_id = 'C1'`;
    expect(rows).toEqual([{ updatedBy: "U2" }]);
  });

  it("rejects a mode outside the two", async () => {
    await expect(
      ledger.sql()`insert into thread_listen (channel_id, thread_ts, mode) values ('C9', '1.0', 'loud')`,
    ).rejects.toThrow();
  });

  it("changes the mode of the session's thread for any allowed person", async () => {
    const sql = ledger.sql();
    const thread = {
      sessionId: "s1",
      teamId: "T1",
      channelId: "C3",
      threadTs: "5.0",
      userId: "U1",
    };
    const answer = await changeListenMode({ sql, thread, mode: "mention-only", userId: "U7" });
    expect(answer).toContain("only when tagged");
    expect(await getListenMode(sql, "C3", "5.0")).toBe("mention-only");
    expect(await changeListenMode({ sql, thread, mode: "all", userId: "U7" })).toContain(
      "as before",
    );
    expect(await getListenMode(sql, "C3", "5.0")).toBe("all");
  });

  it("refuses in a direct message and without a thread", async () => {
    const sql = ledger.sql();
    const dm = { sessionId: "s2", teamId: "T1", channelId: "D1", threadTs: "6.0", userId: "U1" };
    expect(await changeListenMode({ sql, thread: dm, mode: "mention-only", userId: "U1" })).toBe(
      LISTEN_DM,
    );
    expect(
      await changeListenMode({ sql, thread: { ...dm, threadTs: null }, mode: "all", userId: "U1" }),
    ).toBe(LISTEN_NO_THREAD);
    expect(await changeListenMode({ sql, thread: undefined, mode: "all", userId: "U1" })).toBe(
      LISTEN_NO_THREAD,
    );
    expect(await getListenMode(sql, "D1", "6.0")).toBe("all");
  });
});

describe.skipIf(!hasDatabase)("lastTurnUser", () => {
  const ledger = useLedger();

  it("returns the user of the thread's latest turn", async () => {
    const sql = ledger.sql();
    expect(await lastTurnUser(sql, "C1", "1.0")).toBeUndefined();
    const base = { teamId: "T1", channelId: "C1", threadTs: "1.0" };
    await recordSessionThread(sql, { ...base, sessionId: "a", userId: "U1" });
    expect(await lastTurnUser(sql, "C1", "1.0")).toBe("U1");
    await recordSessionThread(sql, { ...base, sessionId: "b", userId: "U2" });
    expect(await lastTurnUser(sql, "C1", "1.0")).toBe("U2");
    // A quiet turn records no user, so the partner stays.
    await recordSessionThread(sql, { ...base, sessionId: "b", userId: null });
    expect(await lastTurnUser(sql, "C1", "1.0")).toBe("U2");
    expect(await lastTurnUser(sql, "C1", "9.0")).toBeUndefined();
  });
});

describe.skipIf(!hasDatabase)("sentPostTimestamps", () => {
  const ledger = useLedger();
  const display = { level: 3, target: "thread", reason: "test" } as const;

  it("lists the sent outbox posts of one thread only", async () => {
    const sql = ledger.sql();
    const post = async (key: string, payload: object, sent: string | null) => {
      const row = await enqueuePost(sql, {
        idempotencyKey: key,
        method: "chat.postMessage",
        payload,
        display,
      });
      if (sent) await markPostSent(sql, row.id, sent);
    };
    await post("a", { channel: "C1", thread_ts: "1.0", text: "card" }, "1.1");
    await post("b", { channel: "C1", thread_ts: "1.0", text: "result" }, "1.2");
    await post("c", { channel: "C1", thread_ts: "1.0", text: "pending" }, null);
    await post("d", { channel: "C1", thread_ts: "9.0", text: "other thread" }, "9.1");
    await post("e", { channel: "C2", thread_ts: "1.0", text: "other channel" }, "1.5");
    expect((await sentPostTimestamps(sql, "C1", "1.0")).sort()).toEqual(["1.1", "1.2"]);
    expect(await sentPostTimestamps(sql, "C3", "1.0")).toEqual([]);
  });
});
