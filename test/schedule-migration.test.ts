import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { respondAsFixture } from "../lib/brain/fixture.ts";
import { connect, type Sql } from "../lib/db.ts";
import { migrate } from "../lib/ledger/migrate.ts";
import { migrations } from "../lib/ledger/migrations.ts";
import { dispatchMessage } from "../lib/schedules/format.ts";
import { agentSchedulesMigration } from "../lib/schedules/migration.ts";
import { getSchedule } from "../lib/schedules/rows.ts";
import { hasDatabase } from "./helpers/ledger.ts";

// Decision 085: rows written before the migration keep working. An approved brief becomes an
// instruction that still starts Builder without a click; a pending row becomes paused.

const BRIEF = { project: "example-app", title: "On-call check", goal: "g", doneWhen: ["d"] };

describe.skipIf(!hasDatabase)("the agent schedules migration", () => {
  const schema = `test_${randomBytes(6).toString("hex")}`;
  let sql: Sql;
  const ids: Record<string, number> = {};

  beforeAll(async () => {
    const admin = connect();
    await admin.unsafe(`create schema ${schema}`);
    await admin.end();
    sql = connect({ schema });
    await migrate(
      sql,
      migrations.filter((m) => m.version !== agentSchedulesMigration.version),
    );
    const insert = async (name: string, status: string, approved: boolean, packKey?: string) => {
      const [row] = await sql<{ id: string }[]>`
        insert into schedules (
          cron, title, brief, channel, owner, status, approved_by, approved_at, next_fire_at,
          pack_key
        ) values (
          '0 9 * * *', ${name}, ${sql.json(BRIEF)}, 'C1', 'U1', ${status},
          ${approved ? "U1" : null}, ${approved ? new Date() : null},
          ${status === "active" ? new Date("2030-01-01T09:00:00Z") : null}, ${packKey ?? null}
        ) returning id
      `;
      ids[name] = Number(row?.id);
    };
    await insert("active", "active", true);
    await insert("paused", "paused", true);
    await insert("pending", "pending_approval", false, "weekday-check");
    await migrate(sql);
  });

  afterAll(async () => {
    await sql?.end();
    const admin = connect();
    await admin.unsafe(`drop schema if exists ${schema} cascade`);
    await admin.end();
  });

  const row = async (name: string) => {
    const found = await getSchedule(sql, ids[name] ?? 0);
    if (!found) throw new Error(`no ${name} row`);
    return found;
  };

  it("turns an approved brief into an instruction that keeps its click-free start", async () => {
    const active = await row("active");
    expect(active).toMatchObject({ status: "active", builder: "auto", cron: "0 9 * * *" });
    expect(active.instruction).toMatch(/^Start the builder with this brief\.\n\n```brief\n/);
    expect(active).not.toHaveProperty("brief");
    expect(active).not.toHaveProperty("approvedBy");
    expect((await row("paused")).builder).toBe("auto");
  });

  it("pauses a row that waited for approval", async () => {
    expect(await row("pending")).toMatchObject({
      status: "paused",
      builder: "ask",
      nextFireAt: null,
    });
  });

  it("keeps the brief readable, so a run still starts it with the schedule reference", async () => {
    const active = await row("active");
    const text = dispatchMessage(active);
    const response = respondAsFixture({
      messages: [{ role: "user", text }],
      userMessages: [text],
      lastUserMessage: text,
      userMessageCount: 1,
      tools: [],
      toolResults: [],
    });
    expect(response).toEqual({
      toolCalls: [{ name: "worker_job", input: { ...BRIEF, schedule: `S-${active.id}` } }],
    });
  });
});
