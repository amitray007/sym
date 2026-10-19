import type { Sql } from "../db.ts";
import type { Pack } from "../pack/load.ts";

// Quiet mode (docs/display.md). Two things make Sym quiet: the owner's `/sym quiet`, saved in
// the ledger, and the pack's quiet hours. chooseDisplay still posts actions and failures.
// This module runs inside the workflow bundle, so it imports no Node.js builtins and reads the
// Pack type only.

const QUIET_KEY = "quiet_until";

export const DEFAULT_QUIET_MINUTES = 60;
export const MAX_QUIET_MINUTES = 7 * 24 * 60;

export type QuietArg = { kind: "off" } | { kind: "minutes"; minutes: number };

// Reads "", "90", "90m", "2h", "1.5h", or "off". Returns undefined for anything else.
export function parseQuietArg(text: string): QuietArg | undefined {
  const arg = text.trim().toLowerCase();
  if (arg === "") return { kind: "minutes", minutes: DEFAULT_QUIET_MINUTES };
  if (arg === "off" || arg === "end" || arg === "stop") return { kind: "off" };
  const match = /^(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hr|hrs|hours?)?$/.exec(arg);
  if (!match?.[1]) return undefined;
  const unit = match[2] ?? "m";
  const minutes = Math.round(Number(match[1]) * (unit.startsWith("h") ? 60 : 1));
  if (minutes <= 0) return { kind: "off" };
  return { kind: "minutes", minutes: Math.min(minutes, MAX_QUIET_MINUTES) };
}

function minutesOfClock(clock: string): number {
  const [hours = "0", minutes = "0"] = clock.split(":");
  return Number(hours) * 60 + Number(minutes);
}

// The minute of the day (0 to 1439) at `at` in a time zone. An unknown zone falls back to UTC.
export function minuteOfDay(at: Date, timeZone?: string): number {
  const read = (zone: string | undefined) => {
    const parts = new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      ...(zone ? { timeZone: zone } : {}),
    }).formatToParts(at);
    const part = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
    return part("hour") * 60 + part("minute");
  };
  try {
    return read(timeZone ?? "UTC");
  } catch {
    return read("UTC");
  }
}

// True when the clock in `timeZone` is inside the window. The window includes `from` and
// excludes `to`, and it may cross midnight, for example 22:00 to 07:00.
export function inQuietHours(
  at: Date,
  hours: { from: string; to: string } | undefined,
  timeZone?: string,
): boolean {
  if (!hours) return false;
  const from = minutesOfClock(hours.from);
  const to = minutesOfClock(hours.to);
  if (from === to) return false;
  const now = minuteOfDay(at, timeZone);
  return from < to ? now >= from && now < to : now >= from || now < to;
}

export async function getQuietUntil(sql: Sql): Promise<Date | null> {
  const [row] = await sql<{ value: string }[]>`select value from settings where key = ${QUIET_KEY}`;
  if (!row) return null;
  const until = new Date(row.value);
  return Number.isNaN(until.getTime()) ? null : until;
}

// Turns quiet mode on until `until`, or off with null.
export async function setQuietUntil(sql: Sql, until: Date | null): Promise<void> {
  if (until === null) {
    await sql`delete from settings where key = ${QUIET_KEY}`;
    return;
  }
  await sql`
    insert into settings (key, value) values (${QUIET_KEY}, ${until.toISOString()})
    on conflict (key) do update set value = excluded.value, updated_at = now()
  `;
}

export async function isQuiet(sql: Sql, pack: Pack | undefined, now: Date): Promise<boolean> {
  const until = await getQuietUntil(sql);
  if (until && until.getTime() > now.getTime()) return true;
  return inQuietHours(now, pack?.config.quietHours, pack?.config.timeZone);
}

// "14:30 UTC" or "14:30 Europe/Berlin", for confirmations.
export function formatClock(at: Date, timeZone?: string): string {
  const zone = timeZone ?? "UTC";
  const minute = minuteOfDay(at, zone);
  const clock = `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
    return `${clock} ${zone}`;
  } catch {
    return `${clock} UTC`;
  }
}
