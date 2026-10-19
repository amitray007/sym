import { describe, expect, it } from "vitest";
import { getSessionThread, recordSessionThread } from "../lib/ledger/threads.ts";
import { hasDatabase, useLedger } from "./helpers/ledger.ts";

describe.skipIf(!hasDatabase)("session threads", () => {
  const ledger = useLedger();

  it("returns nothing for an unknown session", async () => {
    expect(await getSessionThread(ledger.sql(), "nope")).toBeUndefined();
  });

  it("records and reads a thread", async () => {
    const thread = {
      sessionId: "s-insert",
      teamId: "T1",
      channelId: "C1",
      threadTs: "1690000000.000100",
      userId: "U1",
    };
    await recordSessionThread(ledger.sql(), thread);
    expect(await getSessionThread(ledger.sql(), "s-insert")).toEqual(thread);
  });

  it("stores a session without a thread or user", async () => {
    await recordSessionThread(ledger.sql(), {
      sessionId: "s-dm",
      teamId: null,
      channelId: "D1",
      threadTs: null,
      userId: null,
    });
    expect(await getSessionThread(ledger.sql(), "s-dm")).toEqual({
      sessionId: "s-dm",
      teamId: null,
      channelId: "D1",
      threadTs: null,
      userId: null,
    });
  });

  it("keeps the thread and user when an update has none", async () => {
    const sql = ledger.sql();
    await recordSessionThread(sql, {
      sessionId: "s-keep",
      teamId: "T1",
      channelId: "C1",
      threadTs: "1690000000.000100",
      userId: "U1",
    });
    await recordSessionThread(sql, {
      sessionId: "s-keep",
      teamId: "T2",
      channelId: "C2",
      threadTs: null,
      userId: null,
    });
    expect(await getSessionThread(sql, "s-keep")).toEqual({
      sessionId: "s-keep",
      teamId: "T2",
      channelId: "C2",
      threadTs: "1690000000.000100",
      userId: "U1",
    });
  });

  it("replaces the thread and user when an update has new ones", async () => {
    const sql = ledger.sql();
    await recordSessionThread(sql, {
      sessionId: "s-replace",
      teamId: "T1",
      channelId: "C1",
      threadTs: "1690000000.000100",
      userId: "U1",
    });
    await recordSessionThread(sql, {
      sessionId: "s-replace",
      teamId: "T1",
      channelId: "C1",
      threadTs: "1690000000.000999",
      userId: "U2",
    });
    expect(await getSessionThread(sql, "s-replace")).toMatchObject({
      threadTs: "1690000000.000999",
      userId: "U2",
    });
  });
});
