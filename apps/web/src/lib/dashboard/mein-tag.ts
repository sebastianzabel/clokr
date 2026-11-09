/**
 * Issue #845 — the pure derivations of the start page „Mein Tag“ (Ich › Mein Tag), in ONE module.
 *
 * Nothing here computes a business figure: every number comes from an existing endpoint and is
 * only selected, combined as the endpoint documents it, or worded.
 *
 * - `dayGoalMinutes()`   — the Tagesziel of the clock stage (D-845-01): today's contractual Soll
 *   from `GET /dashboard/my-week`, only for a FIXED_SCHEDULE contract. For FLEXTIME, MONTHLY_HOURS and
 *   SHIFT_BASED the stored day hours are placeholders (CLAUDE.md „{day}Hours is authoritative data only
 *   for FIXED_SCHEDULE“), so those contracts get no daily goal. Never a fixed 8 h.
 * - `saldoFigure()`      — the one Stundenkonto number (D-04, D-845-03) from `GET /overtime/:employeeId`,
 *   the endpoint the Zeiten page shows: confirmed + open period, worded through `forecastLabel()`.
 * - `nextOwnShift()`     — the next own shift after now from `GET /shifts/my-week` (D-845-07).
 * - `historySentences()` — the „Verlauf“ lines (D-05, D-845-04): the API's `who` + `what` form one
 *   sentence (text source `composition/activity-sentences.ts`, #849); identical sentences are dropped.
 */
import { fmtBalance } from "$lib/utils/format-minutes";
import { forecastLabel } from "$lib/saldo/forecast-label";

export type ScheduleType = "FIXED_SCHEDULE" | "FLEXTIME" | "MONTHLY_HOURS" | "SHIFT_BASED";

/** The fields of one `GET /dashboard/my-week` day this module reads. */
export interface MyWeekDay {
  date: string;
  expectedHours: number;
  isWorkday: boolean;
  holidayName: string | null;
  leaveType: string | null;
  absenceType: string | null;
}

/**
 * Minutes of today's goal, or `null` when the day has none (no FIXED_SCHEDULE contract, not a
 * workday of the contract, a holiday, a leave or absence day, or a zero Soll).
 */
export function dayGoalMinutes(
  scheduleType: ScheduleType | string | null | undefined,
  day: MyWeekDay | null | undefined,
): number | null {
  if (scheduleType !== "FIXED_SCHEDULE" || !day) return null;
  if (!day.isWorkday || day.holidayName || day.leaveType || day.absenceType) return null;
  const minutes = Math.round(day.expectedHours * 60);
  return minutes > 0 ? minutes : null;
}

/** The fields of `GET /overtime/:employeeId` the Stundenkonto reads. */
export interface OvertimeAnswer {
  balanceHours: number;
  confirmedMinutes?: number;
  openMonthMinutes?: number | null;
  hasClosedMonth?: boolean;
  unconfirmedMonths?: number | null;
}

export interface SaldoFigure {
  /** The one figure, ±H:MM. */
  value: string;
  /** The signed minutes of the figure (tone of the cell). */
  minutes: number;
  /** Plain-text derivation, e.g. „Bestätigt ±0:00 · Laufender Monat +1:55“. */
  explanation: string;
  /** True when part of the figure is not yet confirmed by a month close. */
  forecast: boolean;
}

export function saldoFigure(answer: OvertimeAnswer): SaldoFigure {
  const confirmed = answer.confirmedMinutes;
  const open = answer.openMonthMinutes;
  if (confirmed === undefined || open === undefined || open === null) {
    // No split available: the endpoint's own total, without a derivation it cannot state.
    const minutes = Math.round(answer.balanceHours * 60);
    return {
      value: fmtBalance(minutes),
      minutes,
      explanation: "Stand bis gestern",
      forecast: false,
    };
  }
  const minutes = confirmed + open;
  const label = forecastLabel(answer.unconfirmedMonths, answer.hasClosedMonth);
  return {
    value: fmtBalance(minutes),
    minutes,
    explanation: `Bestätigt ${fmtBalance(confirmed)} · ${label} ${fmtBalance(open)}`,
    forecast: open !== 0 || answer.hasClosedMonth !== true,
  };
}

/** One own shift of `GET /shifts/my-week`. */
export interface OwnShift {
  startTime: string;
  endTime: string;
  label?: string | null;
  templateName?: string | null;
}

export interface MyShiftWeek {
  days: Array<{ date: string; ownShifts: OwnShift[] }>;
}

export interface NextShift {
  date: string;
  startTime: string;
  endTime: string;
  name: string | null;
}

/**
 * The first own shift that has not started yet at `todayStr` / `nowHHMM` (tenant-local calendar day
 * and wall time as the shift rows carry them), searched over the given weeks in order.
 */
export function nextOwnShift(
  weeks: MyShiftWeek[],
  todayStr: string,
  nowHHMM: string,
): NextShift | null {
  const candidates: NextShift[] = [];
  for (const week of weeks) {
    for (const day of week.days) {
      for (const s of day.ownShifts) {
        if (day.date < todayStr) continue;
        if (day.date === todayStr && s.startTime <= nowHHMM) continue;
        candidates.push({
          date: day.date,
          startTime: s.startTime,
          endTime: s.endTime,
          name: s.label ?? s.templateName ?? null,
        });
      }
    }
  }
  candidates.sort((a, b) =>
    a.date === b.date ? a.startTime.localeCompare(b.startTime) : a.date.localeCompare(b.date),
  );
  return candidates[0] ?? null;
}

/** One item of `GET /activity`. */
export interface ActivityLine {
  id: string;
  who: string;
  what: string;
  when: string;
}

export interface HistorySentence {
  id: string;
  text: string;
  when: string;
}

/** The history as complete sentences, the first occurrence of an identical sentence kept. */
export function historySentences(items: ActivityLine[]): HistorySentence[] {
  const seen = new Set<string>();
  const out: HistorySentence[] = [];
  for (const item of items) {
    const text = `${item.who} ${item.what}`.replace(/\s+/g, " ").trim();
    if (text === "" || seen.has(text)) continue;
    seen.add(text);
    out.push({ id: item.id, text, when: item.when });
  }
  return out;
}
