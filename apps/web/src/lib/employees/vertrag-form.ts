// Issue #854 (plan 854-21) - the pure model of the contract half of the „Vertrag“ tab: the form values
// of a stored work schedule, the field messages and the body of `PUT /settings/work/:employeeId`.
// The tab keeps a snapshot and the live values (`$lib/settings/section-state`).
//
// The server stays the authority for every rule: `MONTH_FIRST_ERROR` (a contract CHANGE starts on the
// first of a month), `WEEKLY_HOURS_MISMATCH` (#848, FIXED_SCHEDULE weeklyHours = Σ day hours), the
// SHIFT_BASED `usualWorkDays` rule (#481) and the pending-shift 409. The checks here only save a round
// trip and mirror the bounds of the API's Zod schema.
import { weeklyHoursOf, type DayHoursValues } from "$lib/settings/arbeitszeit";
import { isMonthFirst } from "$lib/employees/contract-start";
import {
  buildContractWorkDaysPayload,
  buildUsualWorkDaysPayload,
  isWorkDay,
  overtimeModeLocked,
  usualWorkDaysMissing,
  usualWorkDaysShortfall,
} from "$lib/utils/work-schedule";

export type ScheduleType = "FIXED_SCHEDULE" | "FLEXTIME" | "MONTHLY_HOURS" | "SHIFT_BASED";
export type OvertimeMode = "CARRY_FORWARD" | "TRACK_ONLY";

export const SCHEDULE_TYPES: ReadonlyArray<{ value: ScheduleType; label: string }> = [
  { value: "FIXED_SCHEDULE", label: "Feste Arbeitszeit" },
  { value: "FLEXTIME", label: "Gleitzeit" },
  { value: "MONTHLY_HOURS", label: "Monatsstunden" },
  { value: "SHIFT_BASED", label: "Nach Schichtplan" },
];

/** What each model means, shown under the model switch. */
export const SCHEDULE_TYPE_HELP: Readonly<Record<ScheduleType, string>> = {
  FIXED_SCHEDULE: "Stunden je Wochentag sind festgelegt, zum Beispiel Mo bis Fr je 8 Stunden.",
  FLEXTIME: "Wochenstunden-Soll mit freier Tagesverteilung, optional mit Kernarbeitszeit.",
  MONTHLY_HOURS: "Ein Stundenbudget pro Monat, zum Beispiel 15 Stunden für einen Minijob.",
  SHIFT_BASED: "Die Arbeitstage ergeben sich aus dem Schichtplan; die Wochenstunden sind das Soll.",
};

/** A stored work schedule as `GET /settings/work/:id` and the PUT answer send it (Decimals arrive as strings). */
export interface ContractSchedule {
  id?: string;
  type: ScheduleType;
  weeklyHours: number | string | null;
  monthlyHours: number | string | null;
  mondayHours: number | string;
  tuesdayHours: number | string;
  wednesdayHours: number | string;
  thursdayHours: number | string;
  fridayHours: number | string;
  saturdayHours: number | string;
  sundayHours: number | string;
  overtimeThreshold: number | string;
  allowOvertimePayout: boolean;
  validFrom: string;
  overtimeMode?: OvertimeMode;
  coreStart?: string | null;
  coreEnd?: string | null;
  coreDays?: number[];
  workDays?: number[];
  contractWorkDaysPerWeek?: number | null;
  usualWorkDays?: number[];
}

/** What the form shows and compares against. Weekday lists use 0 = Sonntag ... 6 = Samstag. */
export type ContractValues = {
  type: ScheduleType;
  /** FLEXTIME and SHIFT_BASED weekly target. */
  weeklyHours: number | null;
  monthlyHours: number | null;
  /** FIXED_SCHEDULE hours per weekday. */
  days: DayHoursValues;
  /** FLEXTIME contractual workdays (they steer leave consumption and the Soll distribution). */
  workDays: number[];
  /** MONTHLY_HOURS contractual workdays (sent as day-hour flags, the server derives workDays from them). */
  monthlyWorkDays: number[];
  coreStart: string;
  coreEnd: string;
  coreDays: number[];
  /** SHIFT_BASED contractual workdays per week (a count, never a weekday set). */
  contractWorkDays: number | null;
  /** SHIFT_BASED „übliche Arbeitstage“ (#481). */
  usualWorkDays: number[];
  overtimeThreshold: number | null;
  allowOvertimePayout: boolean;
  overtimeMode: OvertimeMode;
  /** ISO day of the first of a month, or null while empty. */
  validFrom: string | null;
};

/** Every key of the contract group; a change of any of them is one change of the SaveBar. */
export const CONTRACT_KEYS = [
  "type",
  "weeklyHours",
  "monthlyHours",
  "days",
  "workDays",
  "monthlyWorkDays",
  "coreStart",
  "coreEnd",
  "coreDays",
  "contractWorkDays",
  "usualWorkDays",
  "overtimeThreshold",
  "allowOvertimePayout",
  "overtimeMode",
  "validFrom",
] as const satisfies readonly (keyof ContractValues)[];

export type ContractField = (typeof CONTRACT_KEYS)[number];

const DEFAULT_WORK_DAYS = [1, 2, 3, 4, 5];

function toNumber(value: number | string | null | undefined, fallback: number): number {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Monday 2026-06-01 ... Sunday 2026-06-07: stub dates for `isWorkDay`, which reads only the weekday. */
function referenceDate(weekdayIndex: number): Date {
  // 0 = Sonntag -> 7 June, 1 = Montag -> 1 June ... 6 = Samstag -> 6 June
  return new Date(2026, 5, weekdayIndex === 0 ? 7 : weekdayIndex);
}

/**
 * The form values of a stored schedule. `validFrom` is NOT the stored day: a contract change takes
 * effect from `defaultValidFrom` (the next month-first), the stored day is shown in the history. The
 * stored overtime mode is kept as is (the TRACK_ONLY lock is display only, #494).
 */
export function contractValuesOf(
  schedule: ContractSchedule | null | undefined,
  defaultValidFrom: string | null,
): ContractValues {
  const s = schedule ?? null;
  const flagged = [0, 1, 2, 3, 4, 5, 6].filter((i) => isWorkDay(s, referenceDate(i)));
  return {
    type: s?.type ?? "FIXED_SCHEDULE",
    weeklyHours: toNumber(s?.weeklyHours, 40),
    monthlyHours: s?.monthlyHours ? toNumber(s.monthlyHours, 0) : 0,
    days: {
      mon: s ? toNumber(s.mondayHours, 8) : 8,
      tue: s ? toNumber(s.tuesdayHours, 8) : 8,
      wed: s ? toNumber(s.wednesdayHours, 8) : 8,
      thu: s ? toNumber(s.thursdayHours, 8) : 8,
      fri: s ? toNumber(s.fridayHours, 8) : 8,
      sat: s ? toNumber(s.saturdayHours, 0) : 0,
      sun: s ? toNumber(s.sundayHours, 0) : 0,
    },
    workDays:
      Array.isArray(s?.workDays) && (s?.workDays?.length ?? 0) > 0
        ? [...(s?.workDays ?? [])]
        : [...DEFAULT_WORK_DAYS],
    monthlyWorkDays: flagged,
    coreStart: s?.coreStart ?? "",
    coreEnd: s?.coreEnd ?? "",
    coreDays: Array.isArray(s?.coreDays) ? [...(s?.coreDays ?? [])] : [],
    contractWorkDays: s?.contractWorkDaysPerWeek ?? null,
    usualWorkDays: [...(s?.usualWorkDays ?? [])].sort((a, b) => a - b),
    overtimeThreshold: s ? toNumber(s.overtimeThreshold, 60) : 60,
    allowOvertimePayout: s ? s.allowOvertimePayout : false,
    overtimeMode: s?.overtimeMode ?? "CARRY_FORWARD",
    validFrom: defaultValidFrom,
  };
}

/** The weekly hours the contract plans, for the Minijob hint: Σ day hours for FIXED, the target otherwise. */
export function plannedWeeklyHours(values: ContractValues): number | null {
  if (values.type === "FIXED_SCHEDULE") return weeklyHoursOf(values.days);
  if (values.type === "MONTHLY_HOURS") return null;
  return values.weeklyHours;
}

/** Weekly hours: the API accepts 0 to 60; a SHIFT_BASED target must be at least 1 (the field always required it). */
export const WEEKLY_HOURS_MAX = 60;
export const MONTHLY_HOURS_MAX = 999;
export const OVERTIME_THRESHOLD_MAX = 500;

function numberMessage(
  value: number | null,
  min: number,
  max: number,
  what: string,
): string | undefined {
  if (value === null || !Number.isFinite(value)) return `Gib ${what} ein.`;
  if (value < min || value > max)
    return `${what[0].toUpperCase()}${what.slice(1)}: ${min} bis ${max}.`;
  return undefined;
}

/** The same rule as DayGrid's `isValidDayHours` (0...24); feedback only, the API validates. */
function validDay(hours: number | null): hours is number {
  return hours !== null && Number.isFinite(hours) && hours >= 0 && hours <= 24;
}

/** The message of each invalid field; a missing key is fine. */
export function contractErrors(values: ContractValues): Partial<Record<ContractField, string>> {
  const errors: Partial<Record<ContractField, string>> = {};

  if (values.type === "FIXED_SCHEDULE") {
    const keys = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
    if (!keys.every((key) => validDay(values.days[key]))) {
      errors.days = "Gib für jeden Tag eine Zahl von 0 bis 24 ein.";
    }
  }
  if (values.type === "FLEXTIME") {
    const message = numberMessage(values.weeklyHours, 0, WEEKLY_HOURS_MAX, "die Wochenstunden");
    if (message) errors.weeklyHours = message;
  }
  if (values.type === "SHIFT_BASED") {
    const message = numberMessage(values.weeklyHours, 1, WEEKLY_HOURS_MAX, "die Wochenstunden");
    if (message) errors.weeklyHours = message;
    if (
      values.contractWorkDays !== null &&
      (!Number.isInteger(values.contractWorkDays) ||
        values.contractWorkDays < 1 ||
        values.contractWorkDays > 7)
    ) {
      errors.contractWorkDays = "Gib ganze Tage von 1 bis 7 ein.";
    }
    if (usualWorkDaysMissing(values.type, values.usualWorkDays)) {
      errors.usualWorkDays =
        "Bitte kreuze die üblichen Arbeitstage an – bei Schichtbetrieb Pflicht. Ohne Angabe kann der Vertrag nicht gespeichert werden.";
    } else if (usualWorkDaysShortfall(values.usualWorkDays, values.contractWorkDays) > 0) {
      errors.usualWorkDays = `Bitte kreuze mindestens ${values.contractWorkDays} Tage an – so viele Arbeitstage hat der Vertrag. Sonst wird die Angabe beim Speichern abgelehnt.`;
    }
  }
  if (values.type === "MONTHLY_HOURS" && values.monthlyHours !== null) {
    const message = numberMessage(
      values.monthlyHours,
      0,
      MONTHLY_HOURS_MAX,
      "die Stunden pro Monat",
    );
    if (message) errors.monthlyHours = message;
  }
  const threshold = numberMessage(
    values.overtimeThreshold,
    0,
    OVERTIME_THRESHOLD_MAX,
    "die Überstunden-Warnschwelle",
  );
  if (threshold) errors.overtimeThreshold = threshold;

  if (!values.validFrom) {
    errors.validFrom = "Wähle den Tag, ab dem der Vertrag gilt.";
  } else if (!isMonthFirst(values.validFrom)) {
    errors.validFrom = "Vertragswechsel gelten ab dem Monatsersten. Wähle den 1. eines Monats.";
  }
  return errors;
}

/** Index 0 = Sonntag ... 6 = Samstag -> the API's `{day}Hours` field of that weekday. */
const DAY_FIELDS = [
  "sundayHours",
  "mondayHours",
  "tuesdayHours",
  "wednesdayHours",
  "thursdayHours",
  "fridayHours",
  "saturdayHours",
] as const;

const DAY_VALUE_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

export interface PendingShiftChoice {
  keepOrphanShifts?: boolean;
  cancelOrphanShifts?: boolean;
}

/**
 * The body of `PUT /settings/work/:employeeId`. FIXED_SCHEDULE sends the day hours and their sum as
 * `weeklyHours` (#848); every other model sends 1/0 workday flags in the day-hour fields, which are
 * placeholders for it (CLAUDE.md). SHIFT_BASED never sends `workDays` and is the only model that sends
 * a contract day count (Phase 107).
 */
export function buildSchedulePayload(values: ContractValues, extra?: PendingShiftChoice) {
  const fixed = values.type === "FIXED_SCHEDULE";
  const flagged = new Set(values.monthlyWorkDays);
  const dayHours: Record<(typeof DAY_FIELDS)[number], number> = {} as never;
  DAY_FIELDS.forEach((field, index) => {
    dayHours[field] = fixed
      ? (values.days[DAY_VALUE_KEYS[index]] ?? 0)
      : flagged.has(index)
        ? 1
        : 0;
  });
  return {
    type: values.type,
    weeklyHours:
      values.type === "SHIFT_BASED" || values.type === "FLEXTIME"
        ? values.weeklyHours
        : fixed
          ? weeklyHoursOf(values.days)
          : null,
    monthlyHours: values.type === "MONTHLY_HOURS" ? values.monthlyHours : null,
    coreStart: values.type === "FLEXTIME" ? values.coreStart || null : null,
    coreEnd: values.type === "FLEXTIME" ? values.coreEnd || null : null,
    coreDays: values.type === "FLEXTIME" ? values.coreDays : [],
    ...dayHours,
    overtimeThreshold: values.overtimeThreshold,
    allowOvertimePayout: values.allowOvertimePayout,
    overtimeMode: values.type === "MONTHLY_HOURS" ? values.overtimeMode : "CARRY_FORWARD",
    ...buildContractWorkDaysPayload(values.type, values.workDays, values.contractWorkDays),
    ...buildUsualWorkDaysPayload(values.type, values.usualWorkDays),
    validFrom: values.validFrom,
    ...extra,
  };
}

/** True when the overtime mode is shown locked (display only, the stored mode is sent unchanged, #494). */
export function overtimeLocked(values: ContractValues): boolean {
  return overtimeModeLocked(values.type, values.monthlyHours);
}

/** „2026-12-01“ -> „01.12.2026“ (string split, no time zone involved); anything else is returned unchanged. */
export function germanDay(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  return m ? `${m[3]}.${m[2]}.${m[1]}` : (iso ?? "");
}
