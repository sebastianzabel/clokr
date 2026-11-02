/**
 * Issue #609 (D-03, D-04, D-06, D-07, D-17; P-609-03 .. P-609-12) - the pure kernel of the shift
 * reminders: instants, windows, the START decision, dedupe keys and links.
 *
 * Pure: no Prisma, no `app`, no clock read. The job (`shift-reminder-job.ts`) reads through the
 * facades and calls these functions with its own `now`, so every rule here is a table-driven unit.
 *
 * Time model. A planned shift is a `Shift` row: a `@db.Date` day plus `startTime`/`endTime` strings
 * in the tenant time zone. Its instants are built with `fromZonedTime`, so a DST change moves the
 * wall-clock time, never the rule; an end that is not after the start belongs to the next calendar
 * day (an overnight shift, the same reading as `scheduling/get-current-shift.ts`).
 */
import { fromZonedTime } from "date-fns-tz";

/** A reminder is due for this long after it opened; a restart after downtime never floods (D-04). */
export const REMINDER_WINDOW_MINUTES = 60;
/** The evening reminder is due for this long after the tenant's evening time (D-04). */
export const DAY_CLOSE_WINDOW_MINUTES = 30;
/** An entry that started up to this long before the shift start counts as "already clocked in" (D-04). */
export const START_LOOKBACK_MINUTES = 120;

export const DEFAULT_REMINDER_OFFSET_MINUTES = 15;
export const MIN_REMINDER_OFFSET_MINUTES = 5;
export const MAX_REMINDER_OFFSET_MINUTES = 120;
export const DEFAULT_DAY_CLOSE_TIME = "20:00";

/** Start and end reminders lead to the dashboard clock; the app asks for confirmation there (D-09). */
export const REMINDER_CLOCK_LINK = "/dashboard?clock=1";

const MINUTE_MS = 60_000;
const DAY_CLOSE_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const HHMM_RE = /^(\d{1,2}):(\d{2})$/;

/** Why a candidate got no notice - a closed set, logged at debug level with ids only (P-609-11). */
export type ReminderSkipReason =
  | "TENANT_OFF"
  | "PERSON_OFF"
  | "OUTSIDE_WINDOW"
  | "NOT_IN_POPULATION"
  | "LEAVE"
  | "ABSENCE"
  | "HOLIDAY"
  | "FLAGGED"
  | "CLOCKED_IN"
  | "ENTRY_STARTED"
  | "NO_OPEN_ENTRY"
  | "NEXT_SHIFT_ADJACENT"
  | "NO_ELIGIBLE_SHIFT"
  | "HAS_CLOSED_ENTRY"
  | "OPEN_ENTRY_PRESENT"
  | "ALREADY_NOTIFIED";

export type ReminderDecision = { send: true } | { send: false; reason: ReminderSkipReason };

/** The offset N of the tenant, clamped to 5 .. 120 minutes (a stored value out of range is bent, not trusted). */
export function clampReminderOffset(minutes: number | null | undefined): number {
  if (typeof minutes !== "number" || !Number.isFinite(minutes)) {
    return DEFAULT_REMINDER_OFFSET_MINUTES;
  }
  const whole = Math.trunc(minutes);
  return Math.min(MAX_REMINDER_OFFSET_MINUTES, Math.max(MIN_REMINDER_OFFSET_MINUTES, whole));
}

/** The tenant's evening time as `HH:MM`; anything but a valid 24-hour time falls back to 20:00. */
export function parseDayCloseTime(raw: string | null | undefined): string {
  return typeof raw === "string" && DAY_CLOSE_TIME_RE.test(raw) ? raw : DEFAULT_DAY_CLOSE_TIME;
}

/** The calendar day after `day` ("YYYY-MM-DD"), by UTC calendar arithmetic (never a 24 h step). */
export function nextCalendarDay(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** `HH:MM` zero-padded; a stored "9:00" is read as 09:00. Null when the text is no time of day. */
function padTime(hhmm: string): string | null {
  const m = HHMM_RE.exec(hhmm);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, "0")}:${m[2]}`;
}

export interface ShiftInstants {
  /** The shift's calendar day, `@db.Date` read as a UTC day (CLAUDE.md, #493). */
  day: string;
  startUtc: Date;
  endUtc: Date;
}

/**
 * The instants of a shift in the tenant time zone. `endUtc <= startUtc` means the shift ends on the
 * next calendar day. An unreadable time makes the instant an Invalid Date; the job drops such a shift.
 */
export function shiftInstants(
  shift: { date: Date; startTime: string; endTime: string },
  tz: string,
): ShiftInstants {
  const day = shift.date.toISOString().slice(0, 10);
  const start = padTime(shift.startTime);
  const end = padTime(shift.endTime);
  if (start === null || end === null) {
    return { day, startUtc: new Date(NaN), endUtc: new Date(NaN) };
  }
  const startUtc = fromZonedTime(`${day}T${start}:00`, tz);
  let endUtc = fromZonedTime(`${day}T${end}:00`, tz);
  if (endUtc.getTime() <= startUtc.getTime()) {
    endUtc = fromZonedTime(`${nextCalendarDay(day)}T${end}:00`, tz);
  }
  return { day, startUtc, endUtc };
}

/** True for `from <= now < from + minutes` (inclusive start, exclusive end). */
export function windowContains(from: Date, minutes: number, now: Date): boolean {
  const start = from.getTime();
  const t = now.getTime();
  if (Number.isNaN(start) || Number.isNaN(t)) return false;
  return t >= start && t < start + minutes * MINUTE_MS;
}

/** "09:00" -> "9:00", "13:30" -> "13:30" (the in-app texts name the stored time without a leading zero). */
export function formatShiftTime(hhmm: string): string {
  const padded = padTime(hhmm);
  if (padded === null) return hhmm;
  return `${Number(padded.slice(0, 2))}:${padded.slice(3)}`;
}

/**
 * The instant of the tenant's evening time on `day` (an unparsable stored time falls back to
 * 20:00). Built in the tenant time zone, so a DST day moves the wall clock, never the rule.
 */
export function dayCloseInstant(day: string, hhmm: string | null | undefined, tz: string): Date {
  return fromZonedTime(`${day}T${parseDayCloseTime(hhmm)}:00`, tz);
}

/** The evening reminder leads to the list view of the shift day, not to the dashboard (D-09). */
export function dayCloseLink(day: string): string {
  return `/time-entries?view=list&date=${day}`;
}

/** The dedupe key of an evening notice: one per person and day (the `EmployeeDay` convention of #80). */
export function dayCloseReminderKey(userId: string, employeeId: string, day: string): string {
  return `${userId}|REMINDER_DAY_CLOSE|EmployeeDay|${employeeId}:${day}`;
}

/** The dedupe key of a START or END notice: one per person, type and shift (D-06, P-609-10). */
export function shiftReminderKey(userId: string, type: string, shiftId: string): string {
  return `${userId}|${type}|Shift|${shiftId}`;
}

/**
 * The second dedupe key of a START or END notice: one per person, type and INSTANT (the "exactly one
 * reminder" criterion). Two shifts of one person that start (or end) at the identical instant, in
 * whichever salon, are one occasion for the person and give one notice.
 */
export function shiftInstantKey(userId: string, type: string, instant: Date): string {
  return `${userId}|${type}|At|${instant.getTime()}`;
}

/** Why a shift day is silent although a reminder would be due (AC-3, D-05, D-12). */
export type ExclusionKind = "LEAVE" | "ABSENCE" | "HOLIDAY" | "FLAGGED";

/** An inclusive range of calendar days ("YYYY-MM-DD"), the stored `@db.Date` read as a UTC day. */
export interface DayRange {
  startDay: string;
  endDay: string;
}

export interface ExclusionFacts {
  /** The person's effective leave (approved, cancellation requested; half days included) - never PENDING. */
  leave: readonly DayRange[];
  /** The person's imposed absences (Berufsschule, Mutterschutz, Elternzeit, ...). */
  absences: readonly DayRange[];
  /** The holidays of the shift's salon in the read range ("YYYY-MM-DD"). */
  holidayDays: readonly string[];
  /** The shift is flagged as conflicting with leave. */
  flagged: boolean;
}

/**
 * Whether the shift day `day` is excluded from every reminder, and why (P-609-08). A day inside a
 * leave or absence range (bounds inclusive; a half day counts like a whole one, D-12), a holiday of
 * the shift's salon and a shift flagged as conflicting with leave are silent. Pure: day strings only.
 */
export function exclusionFor(day: string, facts: ExclusionFacts): ExclusionKind | null {
  if (facts.flagged) return "FLAGGED";
  const inside = (r: DayRange) => r.startDay <= day && day <= r.endDay;
  if (facts.leave.some(inside)) return "LEAVE";
  if (facts.absences.some(inside)) return "ABSENCE";
  if (facts.holidayDays.includes(day)) return "HOLIDAY";
  return null;
}

/** The minimal shape of a recorded entry the decisions read. */
export interface ReminderEntry {
  startTime: Date;
  endTime: Date | null;
  isInvalid: boolean;
  /** The entry's own day ("YYYY-MM-DD", the stored `@db.Date`); only the day-close rule reads it. */
  day?: string;
}

export interface StartDecisionInput {
  startUtc: Date;
  offsetMinutes: number;
  now: Date;
  /** The person's recorded WORK entries around the shift (any validity; invalid rows are ignored). */
  entries: readonly ReminderEntry[];
  /** Why the shift day is excluded (leave, absence, holiday, flag); the job computes it, null when none. */
  exclusion?: ExclusionKind | null;
}

/**
 * Whether the person gets the START notice for this shift (AC-1, D-04, D-07).
 *
 * Due in `[start + N, start + N + 60 min)`. Not sent while a valid OPEN entry exists (this also covers
 * an open entry of an adjacent earlier shift), nor when a valid entry started within
 * `[start - 2 h, now]` - the person clocked in early or has already worked and left.
 */
export function decideShiftStart(input: StartDecisionInput): ReminderDecision {
  const opens = new Date(input.startUtc.getTime() + input.offsetMinutes * MINUTE_MS);
  if (!windowContains(opens, REMINDER_WINDOW_MINUTES, input.now)) {
    return { send: false, reason: "OUTSIDE_WINDOW" };
  }
  if (input.exclusion) return { send: false, reason: input.exclusion };
  const valid = input.entries.filter((e) => !e.isInvalid);
  if (valid.some((e) => e.endTime === null)) return { send: false, reason: "CLOCKED_IN" };
  const lookbackFrom = input.startUtc.getTime() - START_LOOKBACK_MINUTES * MINUTE_MS;
  const nowMs = input.now.getTime();
  const started = valid.some((e) => {
    const t = e.startTime.getTime();
    return t >= lookbackFrom && t <= nowMs;
  });
  if (started) return { send: false, reason: "ENTRY_STARTED" };
  return { send: true };
}

/** The instants of another shift of the same person, for the adjacency rule of the end reminder. */
export interface OtherShiftInstants {
  startUtc: Date;
  endUtc: Date;
}

export interface EndDecisionInput {
  endUtc: Date;
  offsetMinutes: number;
  now: Date;
  /** The person's recorded WORK entries around the shift (any validity; invalid rows are ignored). */
  entries: readonly ReminderEntry[];
  /** The person's OTHER non-deleted shifts in the read range (never the shift being decided). */
  otherShifts: readonly OtherShiftInstants[];
  /** Why the shift day is excluded (leave, absence, holiday, flag); the job computes it, null when none. */
  exclusion?: ExclusionKind | null;
}

/**
 * Whether the person gets the END notice for this shift (AC-2, D-04, D-07, P-609-06).
 *
 * Due in `[end + N, end + N + 60 min)`. Sent only while a valid OPEN entry that started before the
 * shift end exists - an entry opened after the end is not nagged, a closed day is done. A shift that
 * is directly followed (the other starts at or before `end + N` and ends after this end) gets none:
 * the person is expected to keep working and the last shift's notice covers the evening.
 */
export function decideShiftEnd(input: EndDecisionInput): ReminderDecision {
  const opens = new Date(input.endUtc.getTime() + input.offsetMinutes * MINUTE_MS);
  if (!windowContains(opens, REMINDER_WINDOW_MINUTES, input.now)) {
    return { send: false, reason: "OUTSIDE_WINDOW" };
  }
  if (input.exclusion) return { send: false, reason: input.exclusion };
  const endMs = input.endUtc.getTime();
  const stillIn = input.entries.some(
    (e) => !e.isInvalid && e.endTime === null && e.startTime.getTime() < endMs,
  );
  if (!stillIn) return { send: false, reason: "NO_OPEN_ENTRY" };
  const opensMs = opens.getTime();
  const followed = input.otherShifts.some(
    (o) => o.startUtc.getTime() <= opensMs && o.endUtc.getTime() > endMs,
  );
  if (followed) return { send: false, reason: "NEXT_SHIFT_ADJACENT" };
  return { send: true };
}

/** A shift of the person on the day in question, for the evening reminder. */
export interface DayCloseShift {
  endUtc: Date;
  /** The shift is flagged as conflicting with approved leave (it is not worked). */
  conflictsWithLeave: boolean;
  /** Why the shift's day is excluded for the person (leave, absence, holiday); null when none. */
  exclusion?: ExclusionKind | null;
}

export interface DayCloseDecisionInput {
  /** The tenant-local day under judgement ("YYYY-MM-DD"). */
  day: string;
  /** The tenant's evening time on that day. */
  closeUtc: Date;
  now: Date;
  /** The person's shifts of that day. */
  shifts: readonly DayCloseShift[];
  /** The person's recorded WORK entries; each carries its own `day`. */
  entries: readonly ReminderEntry[];
}

/**
 * Whether the person gets the evening notice for `day` (AC-3, D-04, D-13, D-15, P-609-07).
 *
 * Due in `[evening, evening + 30 min)`. Needs at least one shift of the day that is not flagged as
 * conflicting with leave and ended by the evening time (a shift that ends later gives no notice that
 * day, D-15). Not sent while a valid OPEN entry exists (D-13) or when any CLOSED entry, valid or
 * not, is dated that day - any recorded time means the day is not empty.
 */
export function decideDayClose(input: DayCloseDecisionInput): ReminderDecision {
  if (!windowContains(input.closeUtc, DAY_CLOSE_WINDOW_MINUTES, input.now)) {
    return { send: false, reason: "OUTSIDE_WINDOW" };
  }
  const closeMs = input.closeUtc.getTime();
  const ended = input.shifts.filter((s) => s.endUtc.getTime() <= closeMs);
  const eligible = ended.some((s) => !s.conflictsWithLeave && !s.exclusion);
  if (!eligible) {
    const excluded = ended.find((s) => s.exclusion);
    return { send: false, reason: excluded?.exclusion ?? "NO_ELIGIBLE_SHIFT" };
  }
  if (input.entries.some((e) => !e.isInvalid && e.endTime === null)) {
    return { send: false, reason: "OPEN_ENTRY_PRESENT" };
  }
  if (input.entries.some((e) => e.endTime !== null && e.day === input.day)) {
    return { send: false, reason: "HAS_CLOSED_ENTRY" };
  }
  return { send: true };
}
