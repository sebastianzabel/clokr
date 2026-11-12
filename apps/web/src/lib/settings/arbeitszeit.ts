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
