// Issue #854 (D-854-03) - the pure half of Verwalten › Regeln › Abwesenheiten: how each settings section reads
// its values from `GET /settings/work`, which messages its fields show and what its save puts on the wire. No
// runes and no `$app` imports on purpose; `UrlaubPanel.svelte` and `UebertragPanel.svelte` own the form state
// and the requests.
//
// The server stays the authority for every rule (the Zod schema of `PUT /settings/work`); the checks here only
// save a round trip and mirror the bounds the page always showed.

import type { PermissionHolder } from "$lib/permissions";
import { messageCount, type FieldMessages } from "$lib/settings/arbeitszeit";
import { mayOpenSection, settingsSection } from "$lib/settings/settings-pages";

export { messageCount, type FieldMessages };

// ── The tabs of the page ─────────────────────────────────────────────────────────────────────────

export interface AbwesenheitenTab {
  value: "urlaub" | "sonderurlaub" | "uebertrag" | "betriebsurlaub" | "urlaubsgrenzen";
  label: string;
  /** The registry sections the tab shows; the tab is offered when the person may open at least one. */
  sections: readonly string[];
  /** True for a tab whose sections read and write `/settings/work` (the page loads the config for them). */
  usesConfig: boolean;
}

/** The tabs of Regeln › Abwesenheiten in strip order. */
export const ABWESENHEITEN_TABS: readonly AbwesenheitenTab[] = [
  {
    value: "urlaub",
    label: "Urlaub",
    sections: [
      "abwesenheiten-anspruch",
      "abwesenheiten-antraege",
      "abwesenheiten-krankheit",
      "abwesenheiten-feiertage",
    ],
    usesConfig: true,
  },
  {
    value: "sonderurlaub",
    label: "Sonderurlaub",
    sections: ["abwesenheiten-sonderurlaub"],
    usesConfig: false,
  },
  {
    value: "uebertrag",
    label: "Übertrag",
    sections: ["abwesenheiten-uebertrag", "abwesenheiten-verfallswarnung"],
    usesConfig: true,
  },
  {
    value: "betriebsurlaub",
    label: "Betriebsurlaub",
    sections: ["abwesenheiten-betriebsurlaub"],
    usesConfig: false,
  },
  {
    value: "urlaubsgrenzen",
    label: "Urlaubsgrenzen & Sperren",
    sections: ["abwesenheiten-urlaubsgrenzen"],
    usesConfig: false,
  },
];

/**
 * The tabs `user` may open (T-854-30): the page merges sections of two old pages (the vacation page and the
 * company shutdowns) and opens under the union of their gates (D-854-05), so a person sees a tab only under
 * the alternatives of its own sections. Presentation only; the API's 403 stays the authority.
 */
export function visibleAbwesenheitenTabs(
  user: PermissionHolder | null | undefined,
): AbwesenheitenTab[] {
  return ABWESENHEITEN_TABS.filter((tab) =>
    tab.sections.some((id) => mayOpenSection(user, settingsSection(id))),
  );
}

export type HolidayRule = "NORMAL" | "HALF_DAY" | "FULL_DAY_OFF";

/** The part of `GET /settings/work` the Abwesenheiten sections read. Every field is optional on the wire. */
export interface AbwesenheitenConfig {
  // Prisma serialises a Decimal as a string, so the days may arrive as "30.00".
  defaultVacationDays?: number | string;
  defaultApprenticeVacationDays?: number | string;
  autoCalcPartTimeVacation?: boolean;
  fullTimeWorkDaysPerWeek?: number;
  enforceMinVacation?: boolean;
  vacationLeadTimeDays?: number;
  vacationMaxAdvanceMonths?: number;
  halfDayAllowed?: boolean;
  leavePlanDeadlineLocksWishes?: boolean;
  sickSelfReport?: boolean;
  sickNoteRequiredAfterDays?: number | null;
  christmasEveRule?: HolidayRule;
  newYearsEveRule?: HolidayRule;
  holidayRulesValidFromYear?: number | null;
  carryOverDeadlineDay?: number;
  carryOverDeadlineMonth?: number;
  carryOverRequiresReason?: boolean;
  vacationReminderStartMonth?: number;
  carryoverWarningEnabled?: boolean;
  carryoverWarningThresholds?: number[];
}

export const MONTHS = [
  "Januar",
  "Februar",
  "März",
  "April",
  "Mai",
  "Juni",
  "Juli",
  "August",
  "September",
  "Oktober",
  "November",
  "Dezember",
] as const;

/** Days per month for the carry-over deadline (February at 28: the deadline recurs every year). */
export const MONTH_MAX_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/** The last day the month `month` (1-12) can name as a deadline. */
export function maxDayOfMonth(month: number): number {
  return MONTH_MAX_DAYS[month - 1] ?? 31;
}

/** `day` lowered to the last day of `month` (never raised: a stored 15 June stays 15 June). */
export function clampDayToMonth(day: number | null, month: number): number | null {
  if (day === null || !Number.isFinite(day)) return day;
  return Math.min(day, maxDayOfMonth(month));
}

function whole(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isInteger(value);
}

function outsideRange(value: number | null, min: number, max: number): boolean {
  return value === null || !Number.isFinite(value) || value < min || value > max;
}

function multipleOfHalf(value: number): boolean {
  return Number.isInteger(value * 2);
}

// ── Urlaubsanspruch ──────────────────────────────────────────────────────────────────────────────

export const VACATION_DAYS_MIN = 1;
export const VACATION_DAYS_MAX = 365;
export const APPRENTICE_DAYS_MIN = 20;
export const DEFAULT_VACATION_DAYS = 30;
export const DEFAULT_APPRENTICE_VACATION_DAYS = 20;

// Type aliases, not interfaces: countChanges/pickSection take `Record<string, unknown>`, which an interface
// (no implicit index signature) does not satisfy.
export type AnspruchValues = {
  /** Days; null while the field is empty. */
  defaultVacationDays: number | null;
  /** Issue #482: the Azubi-Standard, a calculation input for apprentices without an own value. */
  defaultApprenticeVacationDays: number | null;
  autoCalcPartTimeVacation: boolean;
  fullTimeWorkDaysPerWeek: number;
  enforceMinVacation: boolean;
};
export type AnspruchField = keyof AnspruchValues;

export function anspruchFrom(config: AbwesenheitenConfig): AnspruchValues {
  return {
    defaultVacationDays: Number(config.defaultVacationDays) || DEFAULT_VACATION_DAYS,
    defaultApprenticeVacationDays:
      Number(config.defaultApprenticeVacationDays) || DEFAULT_APPRENTICE_VACATION_DAYS,
    autoCalcPartTimeVacation: config.autoCalcPartTimeVacation ?? true,
    fullTimeWorkDaysPerWeek: config.fullTimeWorkDaysPerWeek ?? 5,
    enforceMinVacation: config.enforceMinVacation ?? true,
  };
}

export function anspruchMessages(values: AnspruchValues): FieldMessages<AnspruchField> {
  const messages: FieldMessages<AnspruchField> = {};
  const days = values.defaultVacationDays;
  if (outsideRange(days, VACATION_DAYS_MIN, VACATION_DAYS_MAX) || !multipleOfHalf(days as number)) {
    messages.defaultVacationDays = `Gib Tage von ${VACATION_DAYS_MIN} bis ${VACATION_DAYS_MAX} an, in halben Tagen.`;
  }
  const apprentice = values.defaultApprenticeVacationDays;
  if (
    outsideRange(apprentice, APPRENTICE_DAYS_MIN, VACATION_DAYS_MAX) ||
    !multipleOfHalf(apprentice as number)
  ) {
    messages.defaultApprenticeVacationDays = `Gib Tage von ${APPRENTICE_DAYS_MIN} (§ 3 BUrlG) bis ${VACATION_DAYS_MAX} an, in halben Tagen.`;
  }
  return messages;
}

export function anspruchWire(values: AnspruchValues): Record<AnspruchField, unknown> {
  return {
    defaultVacationDays: values.defaultVacationDays,
    defaultApprenticeVacationDays: values.defaultApprenticeVacationDays,
    autoCalcPartTimeVacation: values.autoCalcPartTimeVacation,
    fullTimeWorkDaysPerWeek: values.fullTimeWorkDaysPerWeek,
    enforceMinVacation: values.enforceMinVacation,
  };
}

/** The part-time example of the help line: a 4-day week of `days` (basis 5-day week). */
export function partTimeDays(days: number | null): number {
  return Math.round(((days ?? DEFAULT_VACATION_DAYS) * 4) / 5);
}

// ── Urlaubsanträge ───────────────────────────────────────────────────────────────────────────────

export const LEAD_TIME_MAX = 365;
export const ADVANCE_MONTHS_MAX = 24;

export type AntraegeValues = {
  /** Days; null while the field is empty. */
  vacationLeadTimeDays: number | null;
  vacationMaxAdvanceMonths: number | null;
  halfDayAllowed: boolean;
  leavePlanDeadlineLocksWishes: boolean;
};
export type AntraegeField = keyof AntraegeValues;

export function antraegeFrom(config: AbwesenheitenConfig): AntraegeValues {
  return {
    vacationLeadTimeDays: config.vacationLeadTimeDays ?? 0,
    vacationMaxAdvanceMonths: config.vacationMaxAdvanceMonths ?? 0,
    halfDayAllowed: config.halfDayAllowed ?? true,
    leavePlanDeadlineLocksWishes: config.leavePlanDeadlineLocksWishes ?? false,
  };
}

export function antraegeMessages(values: AntraegeValues): FieldMessages<AntraegeField> {
  const messages: FieldMessages<AntraegeField> = {};
  if (
    !whole(values.vacationLeadTimeDays) ||
    outsideRange(values.vacationLeadTimeDays, 0, LEAD_TIME_MAX)
  ) {
    messages.vacationLeadTimeDays = `Gib ganze Tage von 0 bis ${LEAD_TIME_MAX} an.`;
  }
  if (
    !whole(values.vacationMaxAdvanceMonths) ||
    outsideRange(values.vacationMaxAdvanceMonths, 0, ADVANCE_MONTHS_MAX)
  ) {
    messages.vacationMaxAdvanceMonths = `Gib ganze Monate von 0 bis ${ADVANCE_MONTHS_MAX} an.`;
  }
  return messages;
}

export function antraegeWire(values: AntraegeValues): Record<AntraegeField, unknown> {
  return {
    vacationLeadTimeDays: values.vacationLeadTimeDays,
    vacationMaxAdvanceMonths: values.vacationMaxAdvanceMonths,
    halfDayAllowed: values.halfDayAllowed,
    leavePlanDeadlineLocksWishes: values.leavePlanDeadlineLocksWishes,
  };
}

// ── Krankmeldung ─────────────────────────────────────────────────────────────────────────────────

export const KARENZ_DAYS_MAX = 3;
export const DEFAULT_KARENZ_DAYS = 3;

/**
 * Mirrors normalizeKarenzDays() in apps/api/src/contexts/absence/find-karenz-overrun-days.ts:
 * § 5 Abs. 1 EFZG ("länger als drei Kalendertage") caps the threshold at 3; null/undefined (a cleared input, or
 * a tenant that never set it) falls back to the default 3. Phase 104 review (WR-08): 104-08 narrowed the API
 * range from 1-30 to 0-3 and deliberately did NOT migrate legacy rows, so this clamp is applied on the READ path
 * and again on the way out.
 */
export function clampKarenzDays(raw: number | null | undefined): number {
  if (raw === null || raw === undefined || Number.isNaN(Number(raw))) return DEFAULT_KARENZ_DAYS;
  return Math.min(KARENZ_DAYS_MAX, Math.max(0, Math.trunc(Number(raw))));
}

export type KrankheitValues = {
  sickSelfReport: boolean;
  /** Calendar days; null while the field is empty. */
  sickNoteRequiredAfterDays: number | null;
};
export type KrankheitField = keyof KrankheitValues;

export function krankheitFrom(config: AbwesenheitenConfig): KrankheitValues {
  return {
    sickSelfReport: config.sickSelfReport ?? true,
    sickNoteRequiredAfterDays: clampKarenzDays(config.sickNoteRequiredAfterDays),
  };
}

export function krankheitMessages(values: KrankheitValues): FieldMessages<KrankheitField> {
  const messages: FieldMessages<KrankheitField> = {};
  if (
    !whole(values.sickNoteRequiredAfterDays) ||
    outsideRange(values.sickNoteRequiredAfterDays, 0, KARENZ_DAYS_MAX)
  ) {
    messages.sickNoteRequiredAfterDays = `Gib ganze Kalendertage von 0 bis ${KARENZ_DAYS_MAX} an.`;
  }
  return messages;
}

export function krankheitWire(values: KrankheitValues): Record<KrankheitField, unknown> {
  return {
    sickSelfReport: values.sickSelfReport,
    // Clamped again on the way out: the API field is .optional() (not .nullable() in the sense of "empty").
    sickNoteRequiredAfterDays: clampKarenzDays(values.sickNoteRequiredAfterDays),
  };
}

// ── Heiligabend und Silvester ────────────────────────────────────────────────────────────────────

export const HOLIDAY_RULES: readonly { value: HolidayRule; label: string }[] = [
  { value: "NORMAL", label: "Normaler Arbeitstag" },
  { value: "HALF_DAY", label: "Halber Tag frei" },
  { value: "FULL_DAY_OFF", label: "Ganzer Tag frei" },
];
export const HOLIDAY_YEAR_MIN = 2020;
export const HOLIDAY_YEAR_MAX = 2100;
export const DEFAULT_HOLIDAY_RULES_YEAR = 2026;

export type FeiertageValues = {
  christmasEveRule: HolidayRule;
  newYearsEveRule: HolidayRule;
  /** Year; null while the field is empty. */
  holidayRulesValidFromYear: number | null;
};
export type FeiertageField = keyof FeiertageValues;

function holidayRuleFrom(raw: HolidayRule | undefined): HolidayRule {
  return HOLIDAY_RULES.some((rule) => rule.value === raw) ? (raw as HolidayRule) : "NORMAL";
}

export function feiertageFrom(config: AbwesenheitenConfig): FeiertageValues {
  return {
    christmasEveRule: holidayRuleFrom(config.christmasEveRule),
    newYearsEveRule: holidayRuleFrom(config.newYearsEveRule),
    holidayRulesValidFromYear: config.holidayRulesValidFromYear ?? DEFAULT_HOLIDAY_RULES_YEAR,
  };
}

export function feiertageMessages(values: FeiertageValues): FieldMessages<FeiertageField> {
  const messages: FieldMessages<FeiertageField> = {};
  if (
    !whole(values.holidayRulesValidFromYear) ||
    outsideRange(values.holidayRulesValidFromYear, HOLIDAY_YEAR_MIN, HOLIDAY_YEAR_MAX)
  ) {
    messages.holidayRulesValidFromYear = `Gib ein Jahr von ${HOLIDAY_YEAR_MIN} bis ${HOLIDAY_YEAR_MAX} an.`;
  }
  return messages;
}

export function feiertageWire(values: FeiertageValues): Record<FeiertageField, unknown> {
  return {
    christmasEveRule: values.christmasEveRule,
    newYearsEveRule: values.newYearsEveRule,
    holidayRulesValidFromYear: values.holidayRulesValidFromYear,
  };
}

function ruleText(rule: HolidayRule): string {
  return rule === "HALF_DAY" ? "halber Tag" : "ganzer Tag frei";
}

/** The help line below „Gültig ab Jahr“: what the two rules mean for which years. */
export function holidayRulesSummary(values: FeiertageValues): string {
  const { christmasEveRule: xmas, newYearsEveRule: nye, holidayRulesValidFromYear: year } = values;
  if (xmas === "NORMAL" && nye === "NORMAL") return "Aktuell keine Sonderregelung aktiv.";
  if (xmas !== "NORMAL" && nye !== "NORMAL") {
    return `Heiligabend (${ruleText(xmas)}) und Silvester (${ruleText(nye)}) gelten ab ${year}. Für frühere Jahre gelten beide als normaler Arbeitstag.`;
  }
  if (xmas !== "NORMAL") {
    return `Heiligabend (${ruleText(xmas)}) gilt ab ${year}. Für frühere Jahre gilt der Tag als normaler Arbeitstag.`;
  }
  return `Silvester (${ruleText(nye)}) gilt ab ${year}. Für frühere Jahre gilt der Tag als normaler Arbeitstag.`;
}

// ── Übertrag ins neue Jahr ───────────────────────────────────────────────────────────────────────

export const DEFAULT_CARRY_OVER_DAY = 31;
export const DEFAULT_CARRY_OVER_MONTH = 3;

export type UebertragValues = {
  /** Day of the month; null while the field is empty. */
  carryOverDeadlineDay: number | null;
  /** 1-12. */
  carryOverDeadlineMonth: number;
  carryOverRequiresReason: boolean;
};
export type UebertragField = keyof UebertragValues;

export function uebertragFrom(config: AbwesenheitenConfig): UebertragValues {
  const month = config.carryOverDeadlineMonth ?? DEFAULT_CARRY_OVER_MONTH;
  return {
    carryOverDeadlineDay: clampDayToMonth(
      config.carryOverDeadlineDay ?? DEFAULT_CARRY_OVER_DAY,
      month,
    ),
    carryOverDeadlineMonth: month,
    carryOverRequiresReason: config.carryOverRequiresReason ?? true,
  };
}

export function uebertragMessages(values: UebertragValues): FieldMessages<UebertragField> {
  const messages: FieldMessages<UebertragField> = {};
  const max = maxDayOfMonth(values.carryOverDeadlineMonth);
  if (!whole(values.carryOverDeadlineDay) || outsideRange(values.carryOverDeadlineDay, 1, max)) {
    messages.carryOverDeadlineDay = `Gib einen Tag von 1 bis ${max} an (${MONTHS[values.carryOverDeadlineMonth - 1]}).`;
  }
  return messages;
}

export function uebertragWire(values: UebertragValues): Record<UebertragField, unknown> {
  return {
    carryOverDeadlineDay: values.carryOverDeadlineDay,
    carryOverDeadlineMonth: values.carryOverDeadlineMonth,
    carryOverRequiresReason: values.carryOverRequiresReason,
  };
}

/** „31. März“ - the deadline as the overview shows it. */
export function carryOverLabel(day: number | null, month: number): string {
  return `${day ?? DEFAULT_CARRY_OVER_DAY}. ${MONTHS[month - 1] ?? ""}`.trim();
}

// ── Warnung vor Verfall (BUrlG § 7, Hinweispflicht) ──────────────────────────────────────────────

export const THRESHOLD_MIN = 1;
export const THRESHOLD_MAX = 365;
export const THRESHOLD_COUNT_MAX = 10;
export const DEFAULT_THRESHOLDS = [60, 30, 14, 7] as const;
export const REMINDER_MONTHS: readonly { value: number; label: string }[] = [8, 9, 10, 11, 12].map(
  (month) => ({ value: month, label: MONTHS[month - 1] }),
);

export type VerfallValues = {
  /** Month the reminders start (8-12). */
  vacationReminderStartMonth: number;
  carryoverWarningEnabled: boolean;
  /** The list as typed: "60, 30, 14, 7". */
  carryoverWarningThresholds: string;
};
export type VerfallField = keyof VerfallValues;

/** "60, 30, 14, 7" → [60, 30, 14, 7]: invalid entries dropped, duplicates removed, sorted descending. */
export function parseThresholdsInput(text: string): number[] {
  const seen = new Set<number>();
  for (const token of text
    .split(/[,;\s]+/)
    .map((t) => t.trim())
    .filter(Boolean)) {
    const n = parseInt(token, 10);
    if (Number.isFinite(n) && n >= THRESHOLD_MIN && n <= THRESHOLD_MAX) seen.add(n);
  }
  return Array.from(seen).sort((a, b) => b - a);
}

export function verfallFrom(config: AbwesenheitenConfig): VerfallValues {
  return {
    vacationReminderStartMonth: config.vacationReminderStartMonth ?? 10,
    carryoverWarningEnabled: config.carryoverWarningEnabled ?? true,
    carryoverWarningThresholds: (config.carryoverWarningThresholds ?? [...DEFAULT_THRESHOLDS]).join(
      ", ",
    ),
  };
}

export function verfallMessages(values: VerfallValues): FieldMessages<VerfallField> {
  const messages: FieldMessages<VerfallField> = {};
  // The list is only used while the warnings are on; a disabled input is not judged.
  if (values.carryoverWarningEnabled) {
    const tokens = values.carryoverWarningThresholds
      .split(/[,;\s]+/)
      .map((t) => t.trim())
      .filter(Boolean);
    const parsed = parseThresholdsInput(values.carryoverWarningThresholds);
    if (tokens.length === 0) {
      messages.carryoverWarningThresholds =
        "Gib mindestens einen Schwellwert an, z. B. 60, 30, 14, 7.";
    } else if (parsed.length < new Set(tokens).size) {
      messages.carryoverWarningThresholds = `Gib ganze Tage von ${THRESHOLD_MIN} bis ${THRESHOLD_MAX} an, getrennt durch Komma.`;
    } else if (parsed.length > THRESHOLD_COUNT_MAX) {
      messages.carryoverWarningThresholds = `Höchstens ${THRESHOLD_COUNT_MAX} Schwellwerte sind möglich.`;
    }
  }
  return messages;
}

export function verfallWire(values: VerfallValues): Record<VerfallField, unknown> {
  return {
    vacationReminderStartMonth: values.vacationReminderStartMonth,
    carryoverWarningEnabled: values.carryoverWarningEnabled,
    carryoverWarningThresholds: parseThresholdsInput(values.carryoverWarningThresholds),
  };
}
