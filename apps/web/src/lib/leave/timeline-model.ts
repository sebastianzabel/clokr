/**
 * Issue #840 (D-840-01/07/10) — the pure model behind the absence timeline of `/team/leave`:
 * the period of a zoom, its day columns, and the adapter that turns the `GET /leave/calendar`
 * range answer into timeline rows.
 *
 * Days are `YYYY-MM-DD` strings and every calculation is UTC arithmetic on whole days (like
 * `lib/leave-plan/timeline.ts`), so a DST change or the viewer's time zone can never shift a bar by
 * a day. No clock is read — callers pass `today`.
 *
 * The adapter decides nothing about visibility. It reads only `masked: true` and `isHoliday: true`
 * of the answer, never a role: the server already withheld what the reader may not see, and a
 * masked bar carries no type and the neutral word (Art. 9 DSGVO, T-840-49). Tracer subset of plan
 * 840-02, completed in 840-05.
 */
import { MONTH_NAMES_DE, MONTH_NAMES_SHORT_DE } from "$lib/reports/period-state";
import {
  ROW_STATE_LABELS,
  WISH_CONFLICT_HINT,
  WISH_FOREIGN_PLAN_HINT,
  WISH_TAKEN_OVER_HINT,
  rowTypeLabel,
} from "$lib/leave-plan/labels";
import type { PlannerReadDto } from "$lib/leave-plan/types";
import { NEUTRAL_CHIP_LABEL, type CalendarTypeCode } from "./team-calendar-visibility";

export type Zoom = "jahr" | "quartal" | "monat";

export interface Period {
  zoom: Zoom;
  year: number;
  startDay: string;
  endDay: string;
}

export interface DayColumn {
  day: string;
  /** German weekday initial: M D M D F S S (Monday first). */
  weekdayLetter: string;
  dayNumber: number;
  isWeekend: boolean;
}

// ── Day arithmetic ───────────────────────────────────────────────────────────

const WEEKDAY_LETTERS = ["S", "M", "D", "M", "D", "F", "S"] as const; // index = getUTCDay()

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function dayString(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${pad2(month)}-${pad2(day)}`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function addDays(day: string, delta: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}

/** The year, quarter or month that contains `datum` (a real `YYYY-MM-DD`). */
export function periodOf(zoom: Zoom, datum: string): Period {
  const [year, month] = datum.split("-").map(Number);
  if (zoom === "jahr") {
    return { zoom, year, startDay: dayString(year, 1, 1), endDay: dayString(year, 12, 31) };
  }
  if (zoom === "quartal") {
    const firstMonth = Math.floor((month - 1) / 3) * 3 + 1;
    const lastMonth = firstMonth + 2;
    return {
      zoom,
      year,
      startDay: dayString(year, firstMonth, 1),
      endDay: dayString(year, lastMonth, daysInMonth(year, lastMonth)),
    };
  }
  return {
    zoom,
    year,
    startDay: dayString(year, month, 1),
    endDay: dayString(year, month, daysInMonth(year, month)),
  };
}

/** One column per day of the period, first to last day inclusive. */
export function dayColumns(period: Period): DayColumn[] {
  const columns: DayColumn[] = [];
  for (let day = period.startDay; day <= period.endDay; day = addDays(day, 1)) {
    const [y, m, d] = day.split("-").map(Number);
    const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    columns.push({
      day,
      weekdayLetter: WEEKDAY_LETTERS[weekday],
      dayNumber: d,
      isWeekend: weekday === 0 || weekday === 6,
    });
  }
  return columns;
}

/** The query part of the range read for a period; the page adds the salon through `withSalonId`. */
export function calendarRangeQuery(period: Period): string {
  return `from=${period.startDay}&to=${period.endDay}`;
}

// ── The calendar answer (shapes of `GET /leave/calendar?from&to`, plan 840-01) ─

/** A row the reader may see in detail (own, or inside the `leave-request:read` reach). */
export interface CalendarDetailedEntry {
  id: string;
  isOwn: boolean;
  employeeId: string;
  firstName: string;
  lastName: string;
  typeCode: CalendarTypeCode;
  typeName: string;
  startDate: string;
  endDate: string;
  halfDay: boolean;
  status: string;
  isHoliday: false;
  masked?: undefined;
  section9?: string | null;
  section9Days?: string[];
}

/** A foreign absence outside the reach: name and period only — no id, no type, no status. */
export interface CalendarMaskedEntry {
  employeeId: string;
  firstName: string;
  lastName: string;
  startDate: string;
  endDate: string;
  isOwn: false;
  masked: true;
  /** Absent on the wire; declared so the union can be narrowed on `isHoliday`. */
  isHoliday?: undefined;
}

/** A public holiday item; `typeName` is the holiday's name. */
export interface CalendarHolidayEntry {
  id: string;
  isOwn: false;
  firstName: string;
  lastName: string;
  typeCode: "HOLIDAY";
  typeName: string;
  startDate: string;
  endDate: string;
  halfDay: false;
  status: "APPROVED";
  isHoliday: true;
  masked?: undefined;
}

export type CalendarEntry = CalendarDetailedEntry | CalendarMaskedEntry | CalendarHolidayEntry;

export interface CalendarSalon {
  salonId: string;
  name: string;
  openingHours: unknown;
}

export interface CalendarRangeAnswer {
  entries: CalendarEntry[];
  salons: CalendarSalon[];
}

// ── Timeline rows ────────────────────────────────────────────────────────────

export interface TimelineBar {
  key: string;
  start: string;
  end: string;
  halfDay?: boolean;
  style: "gesetzt" | "beantragt" | "wunsch" | "abwesend";
  /** `null` for a masked bar: the reader may not learn the type. */
  typeCode: string | null;
  label: string;
  editable: boolean;
  requestId?: string;
  /** A wish over a leave row of the same person (#835). */
  conflict?: boolean;
  /** The #835 wish hint (conflict, foreign plan, taken over); display only. */
  hint?: string | null;
  /** A wish of another open plan: shown, never opened or changed from here (#835). */
  foreignPlan?: boolean;
}

export interface TimelinePerson {
  employeeId: string;
  name: string;
  isOwn: boolean;
  /** Days outside the person's Stammsalon span, shaded; no wish can start there (#835). */
  outsideRanges?: Array<{ start: string; end: string }>;
  /** The #835 forecast column „Anspruch“; `null` outside the reader's entitlement reach. */
  forecast?: { forecastDays: number; forecastNegative: boolean } | null;
  bars: TimelineBar[];
}

function isMasked(entry: CalendarEntry): entry is CalendarMaskedEntry {
  return entry.masked === true;
}

function isHolidayEntry(entry: CalendarEntry): entry is CalendarHolidayEntry {
  return entry.isHoliday === true;
}

/**
 * Rows (one per absent person, ordered by last name, first name, id) and the holidays of the
 * answer. The decision "detailed or masked" is the server's; it is read from `masked` alone.
 */
export function calendarToTimeline(entries: readonly CalendarEntry[]): {
  rows: TimelinePerson[];
  holidays: Array<{ day: string; name: string }>;
} {
  const holidays: Array<{ day: string; name: string }> = [];
  const byPerson = new Map<string, { person: TimelinePerson; last: string }>();

  const personOf = (entry: CalendarDetailedEntry | CalendarMaskedEntry): TimelinePerson => {
    const known = byPerson.get(entry.employeeId);
    if (known) {
      if (entry.isOwn) known.person.isOwn = true;
      return known.person;
    }
    const person: TimelinePerson = {
      employeeId: entry.employeeId,
      name: `${entry.firstName} ${entry.lastName}`.trim(),
      isOwn: entry.isOwn,
      bars: [],
    };
    byPerson.set(entry.employeeId, { person, last: entry.lastName });
    return person;
  };

  for (const entry of entries) {
    if (isHolidayEntry(entry)) {
      holidays.push({ day: entry.startDate, name: entry.typeName });
      continue;
    }
    if (isMasked(entry)) {
      personOf(entry).bars.push({
        key: `masked:${entry.employeeId}:${entry.startDate}`,
        start: entry.startDate,
        end: entry.endDate,
        style: "abwesend",
        typeCode: null,
        label: NEUTRAL_CHIP_LABEL,
        editable: false,
      });
      continue;
    }
    personOf(entry).bars.push({
      key: entry.id,
      start: entry.startDate,
      end: entry.endDate,
      halfDay: entry.halfDay,
      style: entry.status === "PENDING" ? "beantragt" : "gesetzt",
      typeCode: entry.typeCode,
      label: entry.typeName,
      editable: false,
      requestId: entry.id,
    });
  }

  const rows = Array.from(byPerson.values())
    .sort(
      (a, b) =>
        a.last.localeCompare(b.last, "de") ||
        a.person.name.localeCompare(b.person.name, "de") ||
        a.person.employeeId.localeCompare(b.person.employeeId),
    )
    .map((v) => v.person);
  return { rows, holidays };
}

// ── Plan 840-05: ISO week grid, Werktage share, markings, load ──────────────────────────────

const DAY_MS = 86_400_000;

/** Weekday index with Monday = 0 (like `lib/shifts/closed-days.ts`). */
function weekdayIndex(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

/** ISO 8601 week number of the week that starts on `monday`. */
function isoWeekOf(monday: string): number {
  const thursday = addDays(monday, 3);
  const [y, m, d] = thursday.split("-").map(Number);
  return Math.floor((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / DAY_MS / 7) + 1;
}

export interface IsoWeekColumn {
  monday: string;
  sunday: string;
  isoWeek: number;
  /** The days of this week that lie inside the year. */
  daysInYear: string[];
}

/**
 * The week grid of the Jahr zoom: from the Monday on/before 1 January to the Sunday on/after
 * 31 December. 53 columns in most years, 54 in 2040; nothing else may assume a count.
 */
export function isoWeekColumns(year: number): IsoWeekColumn[] {
  const jan1 = dayString(year, 1, 1);
  const dec31 = dayString(year, 12, 31);
  const last = addDays(dec31, 6 - weekdayIndex(dec31));
  const prefix = `${String(year).padStart(4, "0")}-`;
  const columns: IsoWeekColumn[] = [];
  for (
    let monday = addDays(jan1, -weekdayIndex(jan1));
    monday <= last;
    monday = addDays(monday, 7)
  ) {
    const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
    columns.push({
      monday,
      sunday: days[6],
      isoWeek: isoWeekOf(monday),
      daysInYear: days.filter((day) => day.startsWith(prefix)),
    });
  }
  return columns;
}

/**
 * The weekdays (Monday = 0) that count as Werktage: Monday to Saturday when no single salon is in
 * view (§ 3 Abs. 2 BUrlG), else the seven weekdays minus the closed ones of that salon.
 */
export function workdaySet(closedWeekdays: ReadonlySet<number> | null): Set<number> {
  if (closedWeekdays === null) return new Set([0, 1, 2, 3, 4, 5]);
  return new Set([0, 1, 2, 3, 4, 5, 6].filter((weekday) => !closedWeekdays.has(weekday)));
}

export interface WeekCell {
  monday: string;
  /** Absent Werktage ÷ Werktage of the week inside the year (0 when there are none). */
  share: number;
  /** `type`: one visible type fills the cell; `absent`: neutral; `null`: not absent. */
  fill: "type" | "absent" | null;
  typeCode: string | null;
  hasBeantragt: boolean;
  hasWish: boolean;
  outOfYearDays: number;
}

type HolidayDays = ReadonlyArray<{ day: string }>;

function covers(bar: TimelineBar, day: string): boolean {
  return bar.start <= day && day <= bar.end;
}

/**
 * One cell per ISO week of the year for a person. A wish is no absence and never changes the
 * share; days outside the year are excluded from share and fill. A half day counts as half a
 * Werktag; a masked or mixed week reads as the neutral absent fill (T-840-17).
 */
export function weekCells(
  person: TimelinePerson,
  year: number,
  workdays: ReadonlySet<number>,
  holidays: HolidayDays,
): WeekCell[] {
  const holidaySet = new Set(holidays.map((holiday) => holiday.day));
  const absence = person.bars.filter((bar) => bar.style !== "wunsch");
  const requests = person.bars.filter((bar) => bar.style === "beantragt");
  const wishes = person.bars.filter((bar) => bar.style === "wunsch");

  return isoWeekColumns(year).map((column) => {
    let werktage = 0;
    let absent = 0;
    const types = new Set<string | null>();
    for (const day of column.daysInYear) {
      if (!workdays.has(weekdayIndex(day)) || holidaySet.has(day)) continue;
      werktage += 1;
      const present = absence.filter((bar) => covers(bar, day));
      if (present.length === 0) continue;
      absent += present.some((bar) => !bar.halfDay) ? 1 : 0.5;
      for (const bar of present) types.add(bar.typeCode);
    }
    const oneType = types.size === 1 && !types.has(null);
    return {
      monday: column.monday,
      share: werktage === 0 ? 0 : absent / werktage,
      fill: absent === 0 ? null : oneType ? "type" : "absent",
      typeCode: absent > 0 && oneType ? ([...types][0] ?? null) : null,
      hasBeantragt: column.daysInYear.some((day) => requests.some((bar) => covers(bar, day))),
      hasWish: column.daysInYear.some((day) => wishes.some((bar) => covers(bar, day))),
      outOfYearDays: 7 - column.daysInYear.length,
    };
  });
}

export interface DayMarking {
  weekend: boolean;
  holidayName: string | null;
  /** The viewed salon is closed on this weekday. */
  closed: boolean;
  today: boolean;
}

/** The markings of every day column of a period; `closedWeekdays` null = no single salon. */
export function dayMarkings(
  period: Period,
  context: {
    holidays: ReadonlyArray<{ day: string; name: string }>;
    closedWeekdays: ReadonlySet<number> | null;
    today: string;
  },
): Map<string, DayMarking> {
  const holidayName = new Map(context.holidays.map((holiday) => [holiday.day, holiday.name]));
  return new Map(
    dayColumns(period).map((column) => [
      column.day,
      {
        weekend: column.isWeekend,
        holidayName: holidayName.get(column.day) ?? null,
        closed: context.closedWeekdays?.has(weekdayIndex(column.day)) ?? false,
        today: column.day === context.today,
      },
    ]),
  );
}

/** Distinct persons with any non-wish bar on a day; days nobody is absent on are left out. */
export function calendarDayLoad(
  rows: readonly TimelinePerson[],
  days: readonly string[],
): Map<string, number> {
  const load = new Map<string, number>();
  for (const day of days) {
    const count = rows.filter((person) =>
      person.bars.some((bar) => bar.style !== "wunsch" && covers(bar, day)),
    ).length;
    if (count > 0) load.set(day, count);
  }
  return load;
}

/** Distinct persons absent on at least one Werktag of an ISO week, keyed by the Monday. */
export function weekLoad(
  rows: readonly TimelinePerson[],
  year: number,
  workdays: ReadonlySet<number>,
  holidays: HolidayDays,
): Map<string, number> {
  const load = new Map<string, number>();
  for (const person of rows) {
    for (const cell of weekCells(person, year, workdays, holidays)) {
      if (cell.share > 0) load.set(cell.monday, (load.get(cell.monday) ?? 0) + 1);
    }
  }
  return load;
}

// ── Plan 840-05: the planner adapter ─────────────────────────────────────────────────────────

/** The days of the plan year outside every home range (the person is in another salon then). */
function outsideRangesOf(
  year: number,
  homeRanges: ReadonlyArray<{ from: string; to: string }>,
): Array<{ start: string; end: string }> {
  const yearEnd = dayString(year, 12, 31);
  const gaps: Array<{ start: string; end: string }> = [];
  let cursor = dayString(year, 1, 1);
  for (const range of [...homeRanges].sort((a, b) => a.from.localeCompare(b.from))) {
    if (cursor > yearEnd) break;
    if (range.from > cursor) {
      const end = addDays(range.from, -1);
      gaps.push({ start: cursor, end: end < yearEnd ? end : yearEnd });
    }
    const next = addDays(range.to, 1);
    if (next > cursor) cursor = next;
  }
  if (cursor <= yearEnd) gaps.push({ start: cursor, end: yearEnd });
  return gaps;
}

/**
 * Rows of the leave planner (`GET /leave/plans/:id`) as timeline rows. Reads only `kind`, `state`
 * and the wish fields the server decided — a `MASKED` row becomes an `abwesend` bar with no type
 * and the neutral label, whatever a stray `typeCode` says (T-840-17, D-840-07).
 */
export function plannerToTimeline(dto: PlannerReadDto): {
  rows: TimelinePerson[];
  holidays: Array<{ day: string; name: string }>;
} {
  const rows = dto.persons.map((person): TimelinePerson => {
    const bars: TimelineBar[] = person.rows.map((row, i) => {
      const base = {
        key: `row:${person.employeeId}:${i}`,
        start: row.startDate,
        end: row.endDate,
        halfDay: row.halfDay,
        editable: false,
      };
      if (row.kind === "MASKED") {
        return {
          ...base,
          style: "abwesend",
          typeCode: null,
          label: ROW_STATE_LABELS.ABWESEND,
        };
      }
      return {
        ...base,
        style: row.state === "BEANTRAGT" ? "beantragt" : "gesetzt",
        typeCode: row.typeCode,
        label: rowTypeLabel(row),
      };
    });
    for (const wish of person.wishes) {
      const hints = [
        wish.foreignPlan ? WISH_FOREIGN_PLAN_HINT : null,
        wish.leaveRequestId !== null ? WISH_TAKEN_OVER_HINT : null,
        wish.conflict ? WISH_CONFLICT_HINT : null,
      ].filter((hint): hint is string => hint !== null);
      bars.push({
        key: wish.id,
        start: wish.startDate,
        end: wish.endDate,
        halfDay: wish.halfDay,
        style: "wunsch",
        typeCode: null,
        label: ROW_STATE_LABELS.WISH,
        editable: wish.editable && !wish.foreignPlan && wish.leaveRequestId === null,
        conflict: wish.conflict,
        hint: hints.length > 0 ? hints.join(". ") : null,
        foreignPlan: wish.foreignPlan,
      });
    }
    return {
      employeeId: person.employeeId,
      name: `${person.firstName} ${person.lastName}`.trim(),
      isOwn: person.employeeId === dto.viewer.employeeId,
      outsideRanges: outsideRangesOf(dto.plan.year, person.homeRanges),
      forecast: person.forecast
        ? {
            forecastDays: person.forecast.forecastDays,
            forecastNegative: person.forecast.forecastNegative,
          }
        : null,
      bars,
    };
  });
  return {
    rows,
    holidays: dto.holidays.map((holiday) => ({ day: holiday.date, name: holiday.name })),
  };
}

// ── Plan 840-05: period label and stepping ───────────────────────────────────────────────────

/** „2026“ / „Q4 2026 · Okt–Dez“ / „November 2026“. */
export function periodLabel(period: Period): string {
  if (period.zoom === "jahr") return String(period.year);
  const month = Number(period.startDay.slice(5, 7));
  if (period.zoom === "monat") return `${MONTH_NAMES_DE[month - 1]} ${period.year}`;
  const quarter = Math.floor((month - 1) / 3) + 1;
  return `Q${quarter} ${period.year} · ${MONTH_NAMES_SHORT_DE[month - 1]}–${MONTH_NAMES_SHORT_DE[month + 1]}`;
}

/** The anchor (first day) of the period before or after the one containing `datum`. */
export function shiftPeriod(zoom: Zoom, datum: string, step: -1 | 1): string {
  const { year, startDay } = periodOf(zoom, datum);
  const month = Number(startDay.slice(5, 7));
  if (zoom === "jahr") return dayString(year + step, 1, 1);
  const months = year * 12 + (month - 1) + step * (zoom === "quartal" ? 3 : 1);
  return dayString(Math.floor(months / 12), (months % 12) + 1, 1);
}
