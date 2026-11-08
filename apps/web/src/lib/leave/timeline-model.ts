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
}

export interface TimelinePerson {
  employeeId: string;
  name: string;
  isOwn: boolean;
  outsideRanges?: Array<{ start: string; end: string }>;
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
