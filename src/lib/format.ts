/**
 * Date, time and number formatting (spec §2.5, §6.4): server Intl with `he-IL` / `en-IL` and the
 * Asia/Jerusalem time zone. Legal deadlines use Israeli calendar days, so this module also has
 * DST-safe calendar arithmetic in that zone (no date library).
 */
export const TIME_ZONE = "Asia/Jerusalem";
export type FormatLocale = "he" | "en";

const INTL: Record<FormatLocale, string> = { he: "he-IL", en: "en-IL" };

export function intlLocale(locale: FormatLocale): "he-IL" | "en-IL" {
  return INTL[locale] as "he-IL" | "en-IL";
}

/** Removes RLM/LRM/ALM marks and turns NBSP/NNBSP into spaces (used by tests and plain text). */
export function stripBidi(text: string): string {
  return text
    .replace(/[\u200E\u200F\u061C\u2066-\u2069]/g, "")
    .replace(/[\u00A0\u202F]/g, " ");
}

function toDate(value: Date | string | number): Date {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) throw new RangeError("invalid date");
  return d;
}

/** `1 October 2026` / `1 באוקטובר 2026` (long) or `01/10/2026` (short). */
export function formatDate(
  value: Date | string | number,
  locale: FormatLocale,
  style: "long" | "short" = "long",
): string {
  return new Intl.DateTimeFormat(INTL[locale], {
    timeZone: TIME_ZONE,
    ...(style === "long"
      ? { day: "numeric", month: "long", year: "numeric" }
      : { day: "2-digit", month: "2-digit", year: "numeric" }),
  }).format(toDate(value));
}

/** 24-hour `HH:MM` in Jerusalem. */
export function formatTime(
  value: Date | string | number,
  locale: FormatLocale,
): string {
  return new Intl.DateTimeFormat(INTL[locale], {
    timeZone: TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(toDate(value));
}

export function formatDateTime(
  value: Date | string | number,
  locale: FormatLocale,
): string {
  return `${formatDate(value, locale)}, ${formatTime(value, locale)}`;
}

export function formatNumber(
  n: number,
  locale: FormatLocale,
  opts: Intl.NumberFormatOptions = {},
): string {
  return new Intl.NumberFormat(INTL[locale], opts).format(n);
}

// ---------------------------------------------------------------- Jerusalem calendar

export interface WallClock {
  year: number;
  month: number; // 1–12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const partsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** Wall-clock time in Jerusalem for an instant. */
export function jerusalemWallClock(value: Date | string | number): WallClock {
  const parts = Object.fromEntries(
    partsFormatter
      .formatToParts(toDate(value))
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, Number(p.value)]),
  ) as Record<string, number>;
  return {
    year: parts.year ?? 0,
    month: parts.month ?? 0,
    day: parts.day ?? 0,
    hour: parts.hour ?? 0,
    minute: parts.minute ?? 0,
    second: parts.second ?? 0,
  };
}

/** The Israeli calendar day of an instant, `YYYY-MM-DD` (alert dedupe keys, VAT dates). */
export function jerusalemDateKey(value: Date | string | number): string {
  const w = jerusalemWallClock(value);
  return `${w.year}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")}`;
}

/** Offset of Jerusalem from UTC at an instant, in minutes (+120 or +180). */
export function jerusalemOffsetMinutes(value: Date | string | number): number {
  const d = toDate(value);
  const w = jerusalemWallClock(d);
  const asUtc = Date.UTC(
    w.year,
    w.month - 1,
    w.day,
    w.hour,
    w.minute,
    w.second,
  );
  return Math.round((asUtc - Math.floor(d.getTime() / 1000) * 1000) / 60_000);
}

/**
 * The instant at which Jerusalem's wall clock shows `w`. A time skipped by the spring-forward
 * gap resolves to the instant just after the gap (02:30 → 03:30 summer time); an ambiguous
 * autumn time resolves to the earlier instant.
 */
export function fromJerusalemWallClock(w: WallClock): Date {
  const naive = Date.UTC(
    w.year,
    w.month - 1,
    w.day,
    w.hour,
    w.minute,
    w.second,
  );
  // The offsets in force a day before and a day after cover any single DST transition.
  const before = jerusalemOffsetMinutes(naive - 86_400_000);
  const after = jerusalemOffsetMinutes(naive + 86_400_000);
  const matches = [...new Set([before, after])]
    .map((offset) => naive - offset * 60_000)
    .filter((t) => {
      const c = jerusalemWallClock(t);
      return (
        c.year === w.year &&
        c.month === w.month &&
        c.day === w.day &&
        c.hour === w.hour &&
        c.minute === w.minute &&
        c.second === w.second
      );
    })
    .sort((a, b) => a - b);
  // In the gap no instant matches; the pre-transition offset lands just after the gap.
  return new Date(matches[0] ?? naive - before * 60_000);
}

/** Same Jerusalem wall-clock time `days` calendar days later (DST-safe). */
export function addJerusalemDays(
  value: Date | string | number,
  days: number,
): Date {
  const w = jerusalemWallClock(value);
  const shifted = new Date(Date.UTC(w.year, w.month - 1, w.day + days));
  return fromJerusalemWallClock({
    ...w,
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  });
}

/**
 * Same Jerusalem wall-clock time `months` later; the day is clamped to the target month's length
 * (31 January + 1 month → 28/29 February).
 */
export function addJerusalemMonths(
  value: Date | string | number,
  months: number,
): Date {
  const w = jerusalemWallClock(value);
  const firstOfTarget = new Date(Date.UTC(w.year, w.month - 1 + months, 1));
  const year = firstOfTarget.getUTCFullYear();
  const month = firstOfTarget.getUTCMonth() + 1;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return fromJerusalemWallClock({
    ...w,
    year,
    month,
    day: Math.min(w.day, lastDay),
  });
}

/** 00:00 Jerusalem time on the instant's Israeli calendar day. */
export function startOfJerusalemDay(value: Date | string | number): Date {
  const w = jerusalemWallClock(value);
  return fromJerusalemWallClock({ ...w, hour: 0, minute: 0, second: 0 });
}

/** 23:59:59 Jerusalem time on the instant's Israeli calendar day. */
export function endOfJerusalemDay(value: Date | string | number): Date {
  const w = jerusalemWallClock(value);
  return fromJerusalemWallClock({ ...w, hour: 23, minute: 59, second: 59 });
}
