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

// ── Owner acceptance 09.11.2026 (prototype v5) ─────────────────────────────────────────────────

const MONTH_SHORT = [
  "Jan",
  "Feb",
  "Mär",
  "Apr",
  "Mai",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Okt",
  "Nov",
  "Dez",
];

/**
 * The one short line under the Stundenkonto figure, by month: „Okt ±0:00 · Nov +1:55“ — the confirmed
 * carry as of the last closed month, then the open period. `today` = YYYY-MM-DD. No sentence, no
 * forecast label (the chip „Prognose“ says that).
 */
export function saldoMonthsLine(answer: OvertimeAnswer, today: string): string | null {
  const confirmed = answer.confirmedMinutes;
  const open = answer.openMonthMinutes;
  const n = answer.unconfirmedMonths;
  if (confirmed === undefined || open === undefined || open === null) return null;
  if (answer.hasClosedMonth !== true || n === null || n === undefined || n < 1) {
    return `seit Eintritt ${fmtBalance(open)}`;
  }
  const m = Number(today.slice(5, 7)) - 1;
  const last = (((m - n) % 12) + 12) % 12;
  const openName = n === 1 ? MONTH_SHORT[m] : "seitdem";
  return `${MONTH_SHORT[last]} ${fmtBalance(confirmed)} · ${openName} ${fmtBalance(open)}`;
}

/** One `GET /dashboard/my-week` day with the fields of the week strip. */
export interface MyWeekStripDay extends MyWeekDay {
  status?: string;
  shift?: { startTime: string; endTime: string } | null;
}

export interface PlannedDay {
  date: string;
  /** „10:00–18:30“ for a shift, else the contract hours „8:00 geplant“. */
  text: string;
}

function hm(minutes: number): string {
  const t = Math.max(0, Math.round(minutes));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

/**
 * The next planned working day after today (owner: never „— keine geplant“ while there are
 * workdays): an own shift first, else a contractual workday with hours (FIXED_SCHEDULE only — other
 * contracts carry placeholder day hours), never a holiday or an absence day.
 */
export function nextPlannedDay(
  days: MyWeekStripDay[],
  shift: NextShift | null,
  scheduleType: string | null | undefined,
  today: string,
): PlannedDay | null {
  if (shift) return { date: shift.date, text: `${shift.startTime}–${shift.endTime}` };
  if (scheduleType !== "FIXED_SCHEDULE") return null;
  const next = days
    .filter((d) => d.date > today)
    .sort((a, b) => a.date.localeCompare(b.date))
    .find((d) => dayGoalMinutes(scheduleType, d) !== null);
  return next ? { date: next.date, text: `${hm(next.expectedHours * 60)} geplant` } : null;
}

/** How many days of the week are planned: own shifts, or contractual workdays with hours. */
export function plannedDaysCount(
  days: MyWeekStripDay[],
  scheduleType: string | null | undefined,
  shiftDates: ReadonlySet<string>,
): number {
  return days.filter((d) => shiftDates.has(d.date) || dayGoalMinutes(scheduleType, d) !== null)
    .length;
}

/** The second line of a week-strip day: shift, holiday, absence, contract hours or „Frei“. */
export function weekStripText(
  d: MyWeekStripDay,
  scheduleType: string | null | undefined,
  shiftText: string | null,
): string {
  if (d.holidayName) return d.holidayName;
  if (d.leaveType) return d.leaveType;
  if (d.absenceType === "VOCATIONAL_SCHOOL") return "Berufsschule";
  if (shiftText) return shiftText;
  if (dayGoalMinutes(scheduleType, d) !== null) return `${hm(d.expectedHours * 60)} h`;
  return "Frei";
}

/** One closed entry of `GET /time-entries` as „Letzte Tage“ reads it. */
export interface RecentEntry {
  id: string;
  startTime: string;
  endTime: string | null;
  breakMinutes?: number | null;
  workingMinutes?: number | null;
}

export interface RecentDay {
  date: string;
  start: string;
  end: string;
  breakMinutes: number;
  workingMinutes: number;
  /** The day's saldo from the server's cumulative series, or null when it cannot be read. */
  saldoMinutes: number | null;
  breakMissing: boolean;
}

function localDay(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function localHm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function previousDay(day: string): string {
  const d = new Date(`${day}T12:00:00`);
  d.setDate(d.getDate() - 1);
  return localDay(d.toISOString());
}

/**
 * The last worked days, newest first: span, break, net (the per-day totals of `dayTotals`, passed in
 * as `totalsOf`), the day's saldo as the step of the server's cumulative series
 * (`GET /overtime/month-saldo` days: cumulative(d) − cumulative(d−1)) and the break finding of the
 * server's day check (`unconfirmedBreakDays`).
 */
export function recentDays(
  entries: RecentEntry[],
  cumulativeByDate: ReadonlyMap<string, number>,
  breakDays: ReadonlySet<string>,
  totalsOf: (rows: RecentEntry[]) => { breakMinutes: number; workingMinutes: number },
  limit = 4,
): RecentDay[] {
  const byDay = new Map<string, RecentEntry[]>();
  for (const e of entries) {
    if (!e.endTime) continue;
    const day = localDay(e.startTime);
    byDay.set(day, [...(byDay.get(day) ?? []), e]);
  }
  return [...byDay.keys()]
    .sort((a, b) => b.localeCompare(a))
    .slice(0, limit)
    .map((day) => {
      const rows = byDay.get(day)!;
      const starts = rows.map((r) => r.startTime).sort();
      const ends = rows.map((r) => r.endTime as string).sort();
      const totals = totalsOf(rows);
      const cum = cumulativeByDate.get(day);
      const prev = cumulativeByDate.get(previousDay(day));
      return {
        date: day,
        start: localHm(starts[0]),
        end: localHm(ends[ends.length - 1]),
        breakMinutes: totals.breakMinutes,
        workingMinutes: totals.workingMinutes,
        saldoMinutes: cum !== undefined && prev !== undefined ? cum - prev : null,
        breakMissing: breakDays.has(day),
      };
    });
}
