// Issue #854 (D-854-03) - the pure half of the „Einstellungen“ tab of Verwalten › Regeln › Dienstplan: how
// each of its sections reads its values from `GET /settings/work` and what its save puts on the wire. No
// runes and no `$app` imports on purpose; `DienstplanSettingsPanel.svelte` owns the form state and the
// requests.
//
// The server stays the authority for every rule (the Zod schema of `PUT /settings/work`); the helpers here
// only mirror the bounds the pages always showed.

import type { PermissionHolder } from "$lib/permissions";
import { mayOpenSection, settingsSection } from "$lib/settings/settings-pages";
import {
  DEFAULT_DAY_CLOSE_TIME,
  DEFAULT_REMINDER_OFFSET_MINUTES,
  REMINDER_OFFSET_MAX,
  REMINDER_OFFSET_MIN,
  clampReminderOffsetInput,
  normalizeDayCloseTimeInput,
} from "$lib/settings/shift-reminder-settings";

// ── The tabs of the page ─────────────────────────────────────────────────────────────────────────

export interface DienstplanTab {
  value: "vorlagen" | "bedarf" | "muster" | "einstellungen";
  label: string;
  /** The registry sections the tab shows; the tab is offered when the person may open at least one. */
  sections: readonly string[];
}

/** The tabs of Regeln › Dienstplan in strip order. */
export const DIENSTPLAN_TABS: readonly DienstplanTab[] = [
  { value: "vorlagen", label: "Schichtvorlagen", sections: ["dienstplan-vorlagen"] },
  { value: "bedarf", label: "Bedarfsregeln", sections: ["dienstplan-bedarf"] },
  { value: "muster", label: "Wochenmuster", sections: ["dienstplan-muster"] },
  {
    value: "einstellungen",
    label: "Einstellungen",
    sections: ["dienstplan-oeffnungszeiten"],
  },
];

/**
 * The tabs `user` may open (T-854-26): the page merges sections of several old pages and opens under the
 * union of their gates (D-854-05), so a person sees a tab only under the alternatives of its own sections.
 * Presentation only; the API's 403 stays the authority.
 */
export function visibleDienstplanTabs(user: PermissionHolder | null | undefined): DienstplanTab[] {
  return DIENSTPLAN_TABS.filter((tab) =>
    tab.sections.some((id) => mayOpenSection(user, settingsSection(id))),
  );
}

/** The check mode of shifts against the opening hours of their salon (a tenant policy, #563). */
export type StoreHoursMode = "STRICT" | "DAY_ONLY" | "OFF";

/** The part of `GET /settings/work` the Dienstplan settings read. Every field is optional on the wire. */
export interface DienstplanConfig {
  shiftStoreHoursMode?: StoreHoursMode;
  availabilityEnabled?: boolean;
  vocationalSchoolAutoCleanupShifts?: boolean;
  reminderShiftStartEnabled?: boolean;
  reminderShiftEndEnabled?: boolean;
  reminderDayCloseEnabled?: boolean;
  reminderOffsetMinutes?: number;
  reminderDayCloseTime?: string;
}

// ── Öffnungszeiten-Bindung ───────────────────────────────────────────────────────────────────────

export const STORE_HOURS_MODES: readonly {
  value: StoreHoursMode;
  label: string;
  help: string;
}[] = [
  {
    value: "DAY_ONLY",
    label: "Nur geschlossene Tage blockieren (Standard)",
    help: "Schichten dürfen vor der Öffnung beginnen und nach der Schließung enden (Vor- und Nachbereitung). An geschlossenen Tagen ist keine Schicht möglich.",
  },
  {
    value: "STRICT",
    label: "Strikt",
    help: "Schichten müssen vollständig in den Öffnungszeiten liegen.",
  },
  {
    value: "OFF",
    label: "Deaktiviert",
    help: "Keine Bindung an die Öffnungszeiten.",
  },
];

// Type aliases, not interfaces: countChanges/pickSection take `Record<string, unknown>`, which an
// interface (no implicit index signature) does not satisfy.
export type HoursModeValues = { shiftStoreHoursMode: StoreHoursMode };
export type HoursModeField = keyof HoursModeValues;

/** The stored mode; a missing or unknown value reads as the default (only closed days block). */
export function hoursModeFrom(config: DienstplanConfig): HoursModeValues {
  const stored = config.shiftStoreHoursMode;
  const known = STORE_HOURS_MODES.some((mode) => mode.value === stored);
  return { shiftStoreHoursMode: known ? (stored as StoreHoursMode) : "DAY_ONLY" };
}

export function hoursModeWire(values: HoursModeValues): Record<HoursModeField, unknown> {
  return { shiftStoreHoursMode: values.shiftStoreHoursMode };
}

// ── Verfügbarkeiten ──────────────────────────────────────────────────────────────────────────────

export type AvailabilityValues = { availabilityEnabled: boolean };
export type AvailabilityField = keyof AvailabilityValues;

/** The availability system is on unless the company switched it off (stored default: on). */
export function availabilityFrom(config: DienstplanConfig): AvailabilityValues {
  return { availabilityEnabled: config.availabilityEnabled ?? true };
}

export function availabilityWire(values: AvailabilityValues): Record<AvailabilityField, unknown> {
  return { availabilityEnabled: values.availabilityEnabled };
}

// ── Berufsschule und Schichten ───────────────────────────────────────────────────────────────────

export type VocationalCleanupValues = { vocationalSchoolAutoCleanupShifts: boolean };
export type VocationalCleanupField = keyof VocationalCleanupValues;

/** Future shifts on new Berufsschul days are removed unless the company switched it off (stored default: on). */
export function vocationalCleanupFrom(config: DienstplanConfig): VocationalCleanupValues {
  return {
    vocationalSchoolAutoCleanupShifts: config.vocationalSchoolAutoCleanupShifts ?? true,
  };
}

export function vocationalCleanupWire(
  values: VocationalCleanupValues,
): Record<VocationalCleanupField, unknown> {
  return { vocationalSchoolAutoCleanupShifts: values.vocationalSchoolAutoCleanupShifts };
}

// ── Schicht-Erinnerungen (Issue #609) ────────────────────────────────────────────────────────────

export { REMINDER_OFFSET_MAX, REMINDER_OFFSET_MIN };

export type ShiftRemindersValues = {
  reminderShiftStartEnabled: boolean;
  reminderShiftEndEnabled: boolean;
  reminderDayCloseEnabled: boolean;
  /** Null while the input is empty. */
  reminderOffsetMinutes: number | null;
  reminderDayCloseTime: string;
};
export type ShiftRemindersField = keyof ShiftRemindersValues;

/** All three reminders are off until the company opts in; offset and evening time read through the #609 clamps. */
export function shiftRemindersFrom(config: DienstplanConfig): ShiftRemindersValues {
  return {
    reminderShiftStartEnabled: config.reminderShiftStartEnabled ?? false,
    reminderShiftEndEnabled: config.reminderShiftEndEnabled ?? false,
    reminderDayCloseEnabled: config.reminderDayCloseEnabled ?? false,
    reminderOffsetMinutes: clampReminderOffsetInput(config.reminderOffsetMinutes),
    reminderDayCloseTime: normalizeDayCloseTimeInput(config.reminderDayCloseTime),
  };
}

/**
 * The body of the reminder save, for `pickSection`. The API fields are `.optional()`, not `.nullable()` and the
 * offset is bounded 5-120, so the offset is clamped (a cleared input becomes 15) and an empty evening time becomes
 * 20:00 instead of failing the request (#609). The section shows the stored value after the save.
 */
export function shiftRemindersWire(
  values: ShiftRemindersValues,
): Record<ShiftRemindersField, unknown> {
  return {
    reminderShiftStartEnabled: values.reminderShiftStartEnabled,
    reminderShiftEndEnabled: values.reminderShiftEndEnabled,
    reminderDayCloseEnabled: values.reminderDayCloseEnabled,
    reminderOffsetMinutes: clampReminderOffsetInput(values.reminderOffsetMinutes),
    reminderDayCloseTime: normalizeDayCloseTimeInput(values.reminderDayCloseTime),
  };
}

export { DEFAULT_DAY_CLOSE_TIME, DEFAULT_REMINDER_OFFSET_MINUTES };
