// A 5-field cron in UTC: minute hour day-of-month month day-of-week. Fields take `*`, numbers,
// ranges (1-5), lists (1,3), and steps (*/15, 10-30/5). Day-of-week 0 and 7 are Sunday. Names
// such as MON are not supported. Eve and Vercel read the same syntax (docs/eve.md).

export interface Cron {
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  daysOfMonth: ReadonlySet<number>;
  months: ReadonlySet<number>;
  daysOfWeek: ReadonlySet<number>;
  // Standard cron fires on day-of-month OR day-of-week when both fields are restricted.
  domRestricted: boolean;
  dowRestricted: boolean;
}

const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day-of-week", min: 0, max: 7 },
] as const;

export function parseCron(expression: string): Cron {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`A cron needs 5 fields (minute hour day-of-month month day-of-week).`);
  }
  const [minutes, hours, daysOfMonth, months, rawWeek] = parts.map((part, index) => {
    const field = FIELDS[index];
    if (!field) throw new Error("unreachable");
    return parseField(part, field.name, field.min, field.max);
  }) as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
  // 7 is Sunday too.
  const daysOfWeek = new Set([...rawWeek].map((day) => day % 7));
  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    // Like cronie, a field that starts with `*` (including `*/n`) counts as a wildcard.
    domRestricted: !parts[2]?.startsWith("*"),
    dowRestricted: !parts[4]?.startsWith("*"),
  };
}

function parseField(text: string, name: string, min: number, max: number): Set<number> {
  const values = new Set<number>();
  for (const item of text.split(",")) {
    const [range, stepText, extra] = item.split("/");
    if (range === undefined || extra !== undefined) throw bad(name, item);
    let step = 1;
    if (stepText !== undefined) {
      step = integer(stepText, name, item);
      if (step < 1) throw bad(name, item);
    }
    let from: number;
    let to: number;
    if (range === "*") {
      from = min;
      to = name === "day-of-week" ? 6 : max;
    } else if (range.includes("-")) {
      const [a, b, more] = range.split("-");
      if (a === undefined || b === undefined || more !== undefined) throw bad(name, item);
      from = integer(a, name, item);
      to = integer(b, name, item);
    } else {
      from = integer(range, name, item);
      // "5/10" means from 5 to the end, like most cron implementations.
      to = stepText === undefined ? from : max;
    }
    if (from < min || to > max || from > to) throw bad(name, item);
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return values;
}

function integer(text: string, name: string, item: string): number {
  if (!/^\d+$/.test(text)) throw bad(name, item);
  return Number(text);
}

function bad(name: string, item: string): Error {
  return new Error(`Bad cron ${name} field: "${item}".`);
}

export function isValidCron(expression: string): boolean {
  try {
    parseCron(expression);
    return true;
  } catch {
    return false;
  }
}

function dayMatches(cron: Cron, year: number, month: number, day: number): boolean {
  const weekday = new Date(Date.UTC(year, month, day)).getUTCDay();
  const dom = cron.daysOfMonth.has(day);
  const dow = cron.daysOfWeek.has(weekday);
  if (cron.domRestricted && cron.dowRestricted) return dom || dow;
  return dom && dow;
}

// The first fire time strictly after `after`, at minute granularity. Returns undefined when no
// date within 8 years matches, such as "0 0 31 2 *".
export function nextFire(expression: string | Cron, after: Date): Date | undefined {
  const cron = typeof expression === "string" ? parseCron(expression) : expression;
  const start = new Date(after.getTime());
  start.setUTCSeconds(0, 0);
  start.setUTCMinutes(start.getUTCMinutes() + 1);
  const limitYear = start.getUTCFullYear() + 8;

  let year = start.getUTCFullYear();
  let month = start.getUTCMonth();
  let day = start.getUTCDate();
  let hour = start.getUTCHours();
  let minute = start.getUTCMinutes();

  while (year <= limitYear) {
    if (!cron.months.has(month + 1)) {
      [year, month, day, hour, minute] = [
        month === 11 ? year + 1 : year,
        (month + 1) % 12,
        1,
        0,
        0,
      ];
      continue;
    }
    const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    if (day > daysInMonth) {
      [year, month, day, hour, minute] = [
        month === 11 ? year + 1 : year,
        (month + 1) % 12,
        1,
        0,
        0,
      ];
      continue;
    }
    if (!dayMatches(cron, year, month, day)) {
      [day, hour, minute] = [day + 1, 0, 0];
      continue;
    }
    if (!cron.hours.has(hour)) {
      [hour, minute] = [hour + 1, 0];
      if (hour > 23) [day, hour] = [day + 1, 0];
      continue;
    }
    if (!cron.minutes.has(minute)) {
      minute += 1;
      if (minute > 59) {
        [hour, minute] = [hour + 1, 0];
        if (hour > 23) [day, hour] = [day + 1, 0];
      }
      continue;
    }
    return new Date(Date.UTC(year, month, day, hour, minute));
  }
  return undefined;
}
