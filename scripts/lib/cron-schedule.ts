/**
 * Minimal 5-field cron matcher for `scripts/cron.ts --watch` (UTC, like Vercel Cron).
 * Supports `*`, `*` + `/n`, numbers, `a-b`, `a-b/n` and comma lists. Day-of-week 0–6 (0 = Sunday,
 * 7 is accepted as Sunday). When both day fields are restricted, either may match (POSIX cron).
 */
const FIELDS = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12 },
  { min: 0, max: 7 },
] as const;

export interface CronField {
  any: boolean;
  values: Set<number>;
}

function parseField(text: string, min: number, max: number): CronField {
  const values = new Set<number>();
  const any = text === "*";
  for (const part of text.split(",")) {
    const [range, stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1)
      throw new Error(`bad step in "${text}"`);
    let lo: number;
    let hi: number;
    if (range === "*") {
      lo = min;
      hi = max;
    } else if (range?.includes("-")) {
      const [a, b] = range.split("-");
      lo = Number(a);
      hi = Number(b);
    } else {
      lo = Number(range);
      hi = stepText === undefined ? lo : max;
    }
    if (
      !Number.isInteger(lo) ||
      !Number.isInteger(hi) ||
      lo < min ||
      hi > max ||
      lo > hi
    ) {
      throw new Error(`bad range in "${text}"`);
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return { any, values };
}

export interface CronSchedule {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

export function parseCron(expression: string): CronSchedule {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`expected 5 fields: "${expression}"`);
  const [minute, hour, dom, month, dow] = parts.map((p, i) => {
    const f = FIELDS[i];
    if (!f) throw new Error("unreachable");
    return parseField(p, f.min, f.max);
  }) as [CronField, CronField, CronField, CronField, CronField];
  if (dow.values.has(7)) dow.values.add(0);
  return { minute, hour, dayOfMonth: dom, month, dayOfWeek: dow };
}

/** True when `date` (UTC, minute precision) is a firing time of `schedule`. */
export function cronMatches(schedule: CronSchedule, date: Date): boolean {
  if (!schedule.minute.values.has(date.getUTCMinutes())) return false;
  if (!schedule.hour.values.has(date.getUTCHours())) return false;
  if (!schedule.month.values.has(date.getUTCMonth() + 1)) return false;
  const domOk = schedule.dayOfMonth.values.has(date.getUTCDate());
  const dowOk = schedule.dayOfWeek.values.has(date.getUTCDay());
  if (schedule.dayOfMonth.any && schedule.dayOfWeek.any) return true;
  if (schedule.dayOfMonth.any) return dowOk;
  if (schedule.dayOfWeek.any) return domOk;
  return domOk || dowOk;
}
