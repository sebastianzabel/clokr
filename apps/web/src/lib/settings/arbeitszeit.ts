// Issue #854 (D-854-03) - the pure half of Verwalten › Regeln › Arbeitszeit & Verträge: how each
// section reads its values from `GET /settings/work`, which messages its fields show and what its save
// puts on the wire. No runes and no `$app` imports on purpose; the section components
// (`lib/components/admin/arbeitszeit/`) own the form state and the request.
//
// The server stays the authority for every rule (the Zod schema of `PUT /settings/work`); the checks
// here only save a round trip and mirror the bounds the pages always showed.

/** The part of `GET /settings/work` the Arbeitszeit sections read. Every field is optional on the wire. */
export interface WorkConfig {
  autoBreakEnabled?: boolean;
  defaultBreakStart?: string | null;
  defaultBreakOver6h?: number;
  defaultBreakOver9h?: number;
  enforceBreakConfirmation?: boolean;
  retroEntryWindowDays?: number;
  defaultWorkDays?: number[];
  defaultCoreStart?: string | null;
  defaultCoreEnd?: string | null;
  defaultCoreDays?: number[];
  bsSlotFirstLongDayMinutes?: number | null;
  bsSlotSecondLongDayMinutes?: number | null;
  bsSlotShortDayMinutes?: number | null;
  bsSlotBlockWeekMinutes?: number | null;
  // Prisma serialises a Decimal as a string, so the hours may arrive as "8.00".
  defaultMondayHours?: number | string;
  defaultTuesdayHours?: number | string;
  defaultWednesdayHours?: number | string;
  defaultThursdayHours?: number | string;
  defaultFridayHours?: number | string;
  defaultSaturdayHours?: number | string;
  defaultSundayHours?: number | string;
  overtimeThreshold?: number | string;
  allowOvertimePayout?: boolean;
  maxNegativeBalanceMinutes?: number | null;
  arbzgEnabled?: boolean;
  autoDeleteOpenHours?: number;
}

/** Messages keyed by field; an empty or missing entry means the field is fine. */
export type FieldMessages<K extends string> = Partial<Record<K, string>>;

/** The number of fields that carry a message (the SaveBar's error count). */
export function messageCount(messages: Record<string, string | undefined>): number {
  return Object.values(messages).filter((message) => message !== undefined && message !== "")
    .length;
}

// ── Pausen (ArbZG § 4) ───────────────────────────────────────────────────────────────────────────

export const BREAK_OVER_6H_MIN = 30;
export const BREAK_OVER_6H_MAX = 120;
export const BREAK_OVER_9H_MIN = 45;
export const BREAK_OVER_9H_MAX = 180;
export const DEFAULT_BREAK_START = "12:00";

// A type alias, not an interface: countChanges/pickSection take `Record<string, unknown>`, which an
// interface (no implicit index signature) does not satisfy.
export type BreaksValues = {
  autoBreakEnabled: boolean;
  /** `HH:MM`; "" while the field is cleared. */
  defaultBreakStart: string;
  /** Minutes; null while the field is empty. */
  defaultBreakOver6h: number | null;
  defaultBreakOver9h: number | null;
  enforceBreakConfirmation: boolean;
};

export type BreaksField = keyof BreaksValues;

/** The values a stored configuration shows (defaults match the ArbZG floor, Phase 64 BREAK-08). */
export function breaksFrom(config: WorkConfig): BreaksValues {
  return {
    autoBreakEnabled: config.autoBreakEnabled ?? false,
    defaultBreakStart: config.defaultBreakStart ?? DEFAULT_BREAK_START,
    defaultBreakOver6h: config.defaultBreakOver6h ?? BREAK_OVER_6H_MIN,
    defaultBreakOver9h: config.defaultBreakOver9h ?? BREAK_OVER_9H_MIN,
    enforceBreakConfirmation: config.enforceBreakConfirmation ?? false,
  };
}

function outsideRange(value: number | null, min: number, max: number): boolean {
  return value === null || !Number.isFinite(value) || value < min || value > max;
}

export function breaksMessages(values: BreaksValues): FieldMessages<BreaksField> {
  const messages: FieldMessages<BreaksField> = {};
  if (values.autoBreakEnabled && !/^\d{2}:\d{2}$/.test(values.defaultBreakStart)) {
    messages.defaultBreakStart = "Gib die Uhrzeit im Format HH:MM an.";
  }
  if (outsideRange(values.defaultBreakOver6h, BREAK_OVER_6H_MIN, BREAK_OVER_6H_MAX)) {
    messages.defaultBreakOver6h = `Die Pause ab 6 Stunden muss zwischen ${BREAK_OVER_6H_MIN} und ${BREAK_OVER_6H_MAX} Minuten liegen.`;
  }
  if (outsideRange(values.defaultBreakOver9h, BREAK_OVER_9H_MIN, BREAK_OVER_9H_MAX)) {
    messages.defaultBreakOver9h = `Die Pause ab 9 Stunden muss zwischen ${BREAK_OVER_9H_MIN} und ${BREAK_OVER_9H_MAX} Minuten liegen.`;
  }
  return messages;
}

/**
 * The body of the Pausen save, for `pickSection`. The start time is only meaningful while the automatic
 * deduction is on, so switching it off clears it (as the instant toggle always did); the minutes are
 * whole numbers. Callers validate first (`breaksMessages`).
 */
export function breaksWire(values: BreaksValues): Record<BreaksField, unknown> {
  return {
    autoBreakEnabled: values.autoBreakEnabled,
    defaultBreakStart: values.autoBreakEnabled ? values.defaultBreakStart : null,
    defaultBreakOver6h: Math.trunc(values.defaultBreakOver6h ?? BREAK_OVER_6H_MIN),
    defaultBreakOver9h: Math.trunc(values.defaultBreakOver9h ?? BREAK_OVER_9H_MIN),
    enforceBreakConfirmation: values.enforceBreakConfirmation,
  };
}

// ── Rückwirkende Einträge ────────────────────────────────────────────────────────────────────────

export const RETRO_WINDOW_MIN = 1;
export const RETRO_WINDOW_MAX = 90;
export const DEFAULT_RETRO_WINDOW_DAYS = 10;

export type RetroValues = {
  /** Days; null while the field is empty. */
  retroEntryWindowDays: number | null;
};

export type RetroField = keyof RetroValues;

export function retroFrom(config: WorkConfig): RetroValues {
  return { retroEntryWindowDays: config.retroEntryWindowDays ?? DEFAULT_RETRO_WINDOW_DAYS };
}

export function retroMessages(values: RetroValues): FieldMessages<RetroField> {
  const days = values.retroEntryWindowDays;
  if (days === null || !Number.isFinite(days)) {
    return { retroEntryWindowDays: "Gib die Anzahl der Tage ein." };
  }
  const whole = Math.trunc(days);
  if (whole < RETRO_WINDOW_MIN || whole > RETRO_WINDOW_MAX) {
    return {
      retroEntryWindowDays: `Gib einen Wert zwischen ${RETRO_WINDOW_MIN} und ${RETRO_WINDOW_MAX} Tagen ein.`,
    };
  }
  return {};
}

export function retroWire(values: RetroValues): Record<RetroField, unknown> {
  return {
    retroEntryWindowDays: Math.trunc(values.retroEntryWindowDays ?? DEFAULT_RETRO_WINDOW_DAYS),
  };
}

// ── Arbeitstage ──────────────────────────────────────────────────────────────────────────────────

/** Mo…So with the index the API stores (0 = Sonntag … 6 = Samstag). */
export const WEEKDAYS: ReadonlyArray<{ value: number; short: string; full: string }> = [
  { value: 1, short: "Mo", full: "Montag" },
  { value: 2, short: "Di", full: "Dienstag" },
  { value: 3, short: "Mi", full: "Mittwoch" },
  { value: 4, short: "Do", full: "Donnerstag" },
  { value: 5, short: "Fr", full: "Freitag" },
  { value: 6, short: "Sa", full: "Samstag" },
  { value: 0, short: "So", full: "Sonntag" },
];

export const DEFAULT_WORK_DAYS: readonly number[] = [1, 2, 3, 4, 5];

export type WorkDaysValues = { defaultWorkDays: number[] };
export type WorkDaysField = keyof WorkDaysValues;

/** `days` with `day` added or removed, ascending by index like the API stores it. */
export function toggleDay(days: readonly number[], day: number): number[] {
  return days.includes(day) ? days.filter((d) => d !== day) : [...days, day].sort((a, b) => a - b);
}

export function workDaysFrom(config: WorkConfig): WorkDaysValues {
  const stored = config.defaultWorkDays;
  return {
    defaultWorkDays:
      Array.isArray(stored) && stored.length > 0 ? [...stored] : [...DEFAULT_WORK_DAYS],
  };
}

export function workDaysMessages(values: WorkDaysValues): FieldMessages<WorkDaysField> {
  return values.defaultWorkDays.length === 0
    ? { defaultWorkDays: "Mindestens ein Arbeitstag muss aktiv sein." }
    : {};
}

export function workDaysWire(values: WorkDaysValues): Record<WorkDaysField, unknown> {
  return { defaultWorkDays: [...values.defaultWorkDays].sort((a, b) => a - b) };
}

// ── Gleitzeit (Kernzeit) ─────────────────────────────────────────────────────────────────────────

export type CoreHoursValues = {
  /** `HH:MM`; "" = no company default. */
  defaultCoreStart: string;
  defaultCoreEnd: string;
  defaultCoreDays: number[];
};
export type CoreHoursField = keyof CoreHoursValues;

export function coreHoursFrom(config: WorkConfig): CoreHoursValues {
  return {
    defaultCoreStart: config.defaultCoreStart ?? "",
    defaultCoreEnd: config.defaultCoreEnd ?? "",
    defaultCoreDays: Array.isArray(config.defaultCoreDays) ? [...config.defaultCoreDays] : [],
  };
}

/** The server's two rules: begin and end are set together, and the end lies after the begin. */
export function coreHoursMessages(values: CoreHoursValues): FieldMessages<CoreHoursField> {
  const { defaultCoreStart: start, defaultCoreEnd: end } = values;
  if (start !== "" && end === "") {
    return {
      defaultCoreEnd: "Kernzeitbeginn und Kernzeitende gehören zusammen: Gib auch das Ende an.",
    };
  }
  if (start === "" && end !== "") {
    return {
      defaultCoreStart: "Kernzeitbeginn und Kernzeitende gehören zusammen: Gib auch den Beginn an.",
    };
  }
  if (start !== "" && end <= start) {
    return { defaultCoreEnd: "Das Kernzeitende muss nach dem Kernzeitbeginn liegen." };
  }
  return {};
}

export function coreHoursWire(values: CoreHoursValues): Record<CoreHoursField, unknown> {
  return {
    defaultCoreStart: values.defaultCoreStart || null,
    defaultCoreEnd: values.defaultCoreEnd || null,
    defaultCoreDays: [...values.defaultCoreDays].sort((a, b) => a - b),
  };
}

// ── Berufsschule: Zeitgutschrift ─────────────────────────────────────────────────────────────────

// Bounds mirror the server schema (vocational-school-constants.ts): daily slots 240..600 minutes,
// block week 1200..3000 minutes.
export const BS_DAILY_MIN = 240;
export const BS_DAILY_MAX = 600;
export const BS_BLOCK_MIN = 1200;
export const BS_BLOCK_MAX = 3000;

export type VocationalSlotsValues = {
  /** Minutes; null = no company value (inherited from the person's daily Soll). */
  bsSlotFirstLongDayMinutes: number | null;
  bsSlotSecondLongDayMinutes: number | null;
  bsSlotShortDayMinutes: number | null;
  bsSlotBlockWeekMinutes: number | null;
};
export type VocationalSlotsField = keyof VocationalSlotsValues;

export const VOCATIONAL_SLOT_FIELDS: ReadonlyArray<{
  key: VocationalSlotsField;
  label: string;
  /** Short name used in messages. */
  name: string;
  min: number;
  max: number;
  testid: string;
}> = [
  {
    key: "bsSlotFirstLongDayMinutes",
    label: "1. Berufsschul-Langtag (Minuten)",
    name: "1. Langtag",
    min: BS_DAILY_MIN,
    max: BS_DAILY_MAX,
    testid: "firstLong",
  },
  {
    key: "bsSlotSecondLongDayMinutes",
    label: "2. Berufsschul-Langtag (Minuten)",
    name: "2. Langtag",
    min: BS_DAILY_MIN,
    max: BS_DAILY_MAX,
    testid: "secondLong",
  },
  {
    key: "bsSlotShortDayMinutes",
    label: "Berufsschul-Kurztag (Minuten)",
    name: "Kurztag",
    min: BS_DAILY_MIN,
    max: BS_DAILY_MAX,
    testid: "shortDay",
  },
  {
    key: "bsSlotBlockWeekMinutes",
    label: "Blockunterricht-Woche (Minuten)",
    name: "Blockunterricht-Woche",
    min: BS_BLOCK_MIN,
    max: BS_BLOCK_MAX,
    testid: "blockWeek",
  },
];

export function vocationalSlotsFrom(config: WorkConfig): VocationalSlotsValues {
  return {
    bsSlotFirstLongDayMinutes: config.bsSlotFirstLongDayMinutes ?? null,
    bsSlotSecondLongDayMinutes: config.bsSlotSecondLongDayMinutes ?? null,
    bsSlotShortDayMinutes: config.bsSlotShortDayMinutes ?? null,
    bsSlotBlockWeekMinutes: config.bsSlotBlockWeekMinutes ?? null,
  };
}

/** An empty field is valid (no company value); a filled one is a whole number inside its bounds. */
export function vocationalSlotsMessages(
  values: VocationalSlotsValues,
): FieldMessages<VocationalSlotsField> {
  const messages: FieldMessages<VocationalSlotsField> = {};
  for (const field of VOCATIONAL_SLOT_FIELDS) {
    const value = values[field.key];
    if (value === null || value === undefined) continue;
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      messages[field.key] = `${field.name}: Gib eine ganze Zahl ein.`;
    } else if (value < field.min || value > field.max) {
      messages[field.key] =
        `${field.name}: Der Wert muss zwischen ${field.min} und ${field.max} Minuten liegen.`;
    }
  }
  return messages;
}

/** An empty field sends an explicit null, which clears the company value. */
export function vocationalSlotsWire(
  values: VocationalSlotsValues,
): Record<VocationalSlotsField, unknown> {
  return {
    bsSlotFirstLongDayMinutes: values.bsSlotFirstLongDayMinutes ?? null,
    bsSlotSecondLongDayMinutes: values.bsSlotSecondLongDayMinutes ?? null,
    bsSlotShortDayMinutes: values.bsSlotShortDayMinutes ?? null,
    bsSlotBlockWeekMinutes: values.bsSlotBlockWeekMinutes ?? null,
  };
}

/** "= 8 h" for a minute count; "" for an empty or invalid one. */
export function minutesAsHours(minutes: number | null): string {
  if (minutes === null || !Number.isFinite(minutes)) return "";
  return `= ${(minutes / 60).toLocaleString("de-DE", { maximumFractionDigits: 2 })} h`;
}

// ── Standard-Arbeitszeit ─────────────────────────────────────────────────────────────────────────

/** Hours per weekday, the shape of the DayGrid block (null while a field is empty). */
export type DayHoursValues = Record<
  "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun",
  number | null
>;

export const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type DayKey = (typeof DAY_KEYS)[number];

/** The registry key of each weekday's default hours. */
export const DAY_FIELD: Readonly<Record<DayKey, string>> = {
  mon: "defaultMondayHours",
  tue: "defaultTuesdayHours",
  wed: "defaultWednesdayHours",
  thu: "defaultThursdayHours",
  fri: "defaultFridayHours",
  sat: "defaultSaturdayHours",
  sun: "defaultSundayHours",
};

export const WEEKLY_HOURS_MIN = 1;
export const WEEKLY_HOURS_MAX = 60;
export const OVERTIME_THRESHOLD_MIN = 1;
export const OVERTIME_THRESHOLD_MAX = 500;

export type DefaultHoursValues = {
  days: DayHoursValues;
  /** Hours; null while the field is empty. */
  overtimeThreshold: number | null;
  allowOvertimePayout: boolean;
};

/** What the confirmed bulk apply adds to the save (Issue #568); the server computed all three. */
export interface BulkSelection {
  applyEmployeeIds: string[];
  previewFingerprint: string;
  effectiveFrom: string;
}

/** The same rule as DayGrid's `isValidDayHours` (0…24); feedback only, the API validates. */
function validDay(hours: number | null): hours is number {
  return hours !== null && Number.isFinite(hours) && hours >= 0 && hours <= 24;
}

/** Sum of the valid days, rounded to hundredths so float noise never shows (DayGrid's `sumDayHours`). */
export function weeklyHoursOf(days: DayHoursValues): number {
  let sum = 0;
  for (const key of DAY_KEYS) {
    const hours = days[key];
    if (validDay(hours)) sum += hours;
  }
  return Math.round(sum * 100) / 100;
}

export function defaultHoursFrom(config: WorkConfig): DefaultHoursValues {
  const hours = (value: number | string | undefined, fallback: number): number => {
    const parsed = Number(value);
    return value === undefined || !Number.isFinite(parsed) ? fallback : parsed;
  };
  return {
    days: {
      mon: hours(config.defaultMondayHours, 8),
      tue: hours(config.defaultTuesdayHours, 8),
      wed: hours(config.defaultWednesdayHours, 8),
      thu: hours(config.defaultThursdayHours, 8),
      fri: hours(config.defaultFridayHours, 8),
      sat: hours(config.defaultSaturdayHours, 0),
      sun: hours(config.defaultSundayHours, 0),
    },
    overtimeThreshold: hours(config.overtimeThreshold, 60),
    allowOvertimePayout: config.allowOvertimePayout ?? false,
  };
}

/** The values the section's SaveBar counts: one field per weekday, the threshold and the payout flag. */
export function defaultHoursComparable(values: DefaultHoursValues): Record<string, unknown> {
  const out: Record<string, unknown> = {
    overtimeThreshold: values.overtimeThreshold,
    allowOvertimePayout: values.allowOvertimePayout,
  };
  for (const key of DAY_KEYS) out[DAY_FIELD[key]] = values.days[key];
  return out;
}

export const DEFAULT_HOURS_COMPARABLE_KEYS: readonly string[] = [
  ...DAY_KEYS.map((key) => DAY_FIELD[key]),
  "overtimeThreshold",
  "allowOvertimePayout",
];

/** One message per invalid weekday (the DayGrid shows the same wording under the field), the weekly
 *  total and the threshold. */
export function defaultHoursMessages(
  values: DefaultHoursValues,
): Record<string, string | undefined> {
  const messages: Record<string, string | undefined> = {};
  for (const key of DAY_KEYS) {
    if (!validDay(values.days[key])) messages[DAY_FIELD[key]] = "Gib eine Zahl von 0 bis 24 ein.";
  }
  const weekly = weeklyHoursOf(values.days);
  if (
    Object.keys(messages).length === 0 &&
    (weekly < WEEKLY_HOURS_MIN || weekly > WEEKLY_HOURS_MAX)
  ) {
    messages.defaultWeeklyHours = `Die Wochensumme muss zwischen ${WEEKLY_HOURS_MIN} und ${WEEKLY_HOURS_MAX} Stunden liegen.`;
  }
  const threshold = values.overtimeThreshold;
  if (
    threshold === null ||
    !Number.isFinite(threshold) ||
    threshold < OVERTIME_THRESHOLD_MIN ||
    threshold > OVERTIME_THRESHOLD_MAX
  ) {
    messages.overtimeThreshold = `Die Warnschwelle muss zwischen ${OVERTIME_THRESHOLD_MIN} und ${OVERTIME_THRESHOLD_MAX} Stunden liegen.`;
  }
  return messages;
}

/**
 * The body of the save: the defaults, and — only for a confirmed bulk apply (Issue #568, AC-2) — the
 * server's own selection. `applyToExisting` is true exactly when a selection is given; the effective
 * date is the one the server's preview allowed, never computed here. Callers validate first.
 */
export function defaultHoursWire(
  values: DefaultHoursValues,
  bulk: BulkSelection | null,
): Record<string, unknown> {
  return {
    defaultWeeklyHours: weeklyHoursOf(values.days),
    defaultMondayHours: values.days.mon,
    defaultTuesdayHours: values.days.tue,
    defaultWednesdayHours: values.days.wed,
    defaultThursdayHours: values.days.thu,
    defaultFridayHours: values.days.fri,
    defaultSaturdayHours: values.days.sat,
    defaultSundayHours: values.days.sun,
    overtimeThreshold: values.overtimeThreshold,
    allowOvertimePayout: values.allowOvertimePayout,
    applyToExisting: bulk !== null,
    applyEmployeeIds: bulk?.applyEmployeeIds,
    previewFingerprint: bulk?.previewFingerprint,
    effectiveFrom: bulk?.effectiveFrom,
  };
}

// ── Überstunden: negatives Saldo ─────────────────────────────────────────────────────────────────

export const MAX_NEGATIVE_HOURS_MIN = 1;
export const MAX_NEGATIVE_HOURS_MAX = 999;
export const DEFAULT_MAX_NEGATIVE_HOURS = 20;

export type MaxNegativeValues = {
  enabled: boolean;
  /** Hours; null while the field is empty. */
  hours: number | null;
};

export function maxNegativeFrom(config: WorkConfig): MaxNegativeValues {
  const minutes = config.maxNegativeBalanceMinutes;
  return minutes === null || minutes === undefined
    ? { enabled: false, hours: DEFAULT_MAX_NEGATIVE_HOURS }
    : { enabled: true, hours: minutes / 60 };
}

export function maxNegativeMessages(values: MaxNegativeValues): FieldMessages<"hours"> {
  if (!values.enabled) return {};
  const hours = values.hours;
  if (
    hours === null ||
    !Number.isFinite(hours) ||
    hours < MAX_NEGATIVE_HOURS_MIN ||
    hours > MAX_NEGATIVE_HOURS_MAX
  ) {
    return {
      hours: `Gib einen Wert zwischen ${MAX_NEGATIVE_HOURS_MIN} und ${MAX_NEGATIVE_HOURS_MAX} Stunden ein.`,
    };
  }
  return {};
}

/** Off sends null (no limit: a tolerance of 0 hours applies); on sends whole minutes. */
export function maxNegativeWire(
  values: MaxNegativeValues,
): Record<"maxNegativeBalanceMinutes", unknown> {
  return {
    maxNegativeBalanceMinutes: values.enabled
      ? Math.round((values.hours ?? DEFAULT_MAX_NEGATIVE_HOURS) * 60)
      : null,
  };
}

// ── ArbZG-Prüfung ────────────────────────────────────────────────────────────────────────────────

export type ComplianceValues = { arbzgEnabled: boolean };
export type ComplianceField = keyof ComplianceValues;

export function complianceFrom(config: WorkConfig): ComplianceValues {
  return { arbzgEnabled: config.arbzgEnabled ?? true };
}

export function complianceWire(values: ComplianceValues): Record<ComplianceField, unknown> {
  return { arbzgEnabled: values.arbzgEnabled };
}

// ── Offene Einträge ──────────────────────────────────────────────────────────────────────────────

export const OPEN_ENTRIES_HOURS_MAX = 168;
export const DEFAULT_OPEN_ENTRIES_HOURS = 14;

export type OpenEntriesValues = {
  /** Hours; 0 = switched off; null while the field is empty. */
  autoDeleteOpenHours: number | null;
};
export type OpenEntriesField = keyof OpenEntriesValues;

export function openEntriesFrom(config: WorkConfig): OpenEntriesValues {
  return { autoDeleteOpenHours: config.autoDeleteOpenHours ?? DEFAULT_OPEN_ENTRIES_HOURS };
}

export function openEntriesMessages(values: OpenEntriesValues): FieldMessages<OpenEntriesField> {
  const hours = values.autoDeleteOpenHours;
  if (
    hours === null ||
    !Number.isFinite(hours) ||
    Math.trunc(hours) < 0 ||
    Math.trunc(hours) > OPEN_ENTRIES_HOURS_MAX
  ) {
    return {
      autoDeleteOpenHours: `Gib einen Wert zwischen 0 und ${OPEN_ENTRIES_HOURS_MAX} Stunden ein.`,
    };
  }
  return {};
}

export function openEntriesWire(values: OpenEntriesValues): Record<OpenEntriesField, unknown> {
  return {
    autoDeleteOpenHours: Math.trunc(values.autoDeleteOpenHours ?? DEFAULT_OPEN_ENTRIES_HOURS),
  };
}
