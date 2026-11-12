// Issue #854 (plan 854-22) - the pure model of the per-person overrides of the Vertrag tab: the
// Pausendauer (BREAK-06), the Phorest Vor-/Nachbereitungszeit (#85.1.1) and the four Berufsschule
// time-credit slots of the person (Phase 76.36). Values are `number | null`; null is "inherit",
// which the API stores as null again. The server stays the authority for every bound (the checks
// here only save a round trip and name the field), and a section sends exactly its own keys
// (#878), never a spread of the whole record.

import { minutesAsHours } from "$lib/settings/arbeitszeit";

// ── Keys ─────────────────────────────────────────────────────────────────────

export const PAUSE_KEYS = ["breakOver6hOverride", "breakOver9hOverride"] as const;
export type PauseKey = (typeof PAUSE_KEYS)[number];
export type PauseValues = Record<PauseKey, number | null>;

export const PHOREST_KEYS = ["phorestPrepMinutesOverride", "phorestWrapupMinutesOverride"] as const;
export type PhorestKey = (typeof PHOREST_KEYS)[number];
export type PhorestValues = Record<PhorestKey, number | null>;

export const BS_SLOT_KEYS = [
  "bsSlotFirstLongDayMinutes",
  "bsSlotSecondLongDayMinutes",
  "bsSlotShortDayMinutes",
  "bsSlotBlockWeekMinutes",
] as const;
export type BsSlotKey = (typeof BS_SLOT_KEYS)[number];
export type BsSlotValues = Record<BsSlotKey, number | null>;

/** The stored person, as far as the three groups read it (GET /employees/:id). */
export interface OverrideEmployee {
  birthDate?: string | null;
  breakOver6hOverride?: number | null;
  breakOver9hOverride?: number | null;
  phorestPrepMinutesOverride?: number | null;
  phorestWrapupMinutesOverride?: number | null;
  bsSlotFirstLongDayMinutes?: number | null;
  bsSlotSecondLongDayMinutes?: number | null;
  bsSlotShortDayMinutes?: number | null;
  bsSlotBlockWeekMinutes?: number | null;
}

/** The company defaults the placeholders and hints name (GET /settings/work). */
export interface OverrideTenant {
  defaultBreakOver6h?: number;
  defaultBreakOver9h?: number;
  phorestPrepMinutes?: number;
  phorestWrapupMinutes?: number;
  bsSlotFirstLongDayMinutes?: number | null;
  bsSlotSecondLongDayMinutes?: number | null;
  bsSlotShortDayMinutes?: number | null;
  bsSlotBlockWeekMinutes?: number | null;
}

// ── Values ───────────────────────────────────────────────────────────────────

function minutesOrNull(value: number | null | undefined): number | null {
  return value === undefined || value === null ? null : value;
}

export function pauseValuesOf(employee: OverrideEmployee): PauseValues {
  return {
    breakOver6hOverride: minutesOrNull(employee.breakOver6hOverride),
    breakOver9hOverride: minutesOrNull(employee.breakOver9hOverride),
  };
}

export function phorestValuesOf(employee: OverrideEmployee): PhorestValues {
  return {
    phorestPrepMinutesOverride: minutesOrNull(employee.phorestPrepMinutesOverride),
    phorestWrapupMinutesOverride: minutesOrNull(employee.phorestWrapupMinutesOverride),
  };
}

export function bsSlotValuesOf(employee: OverrideEmployee): BsSlotValues {
  return {
    bsSlotFirstLongDayMinutes: minutesOrNull(employee.bsSlotFirstLongDayMinutes),
    bsSlotSecondLongDayMinutes: minutesOrNull(employee.bsSlotSecondLongDayMinutes),
    bsSlotShortDayMinutes: minutesOrNull(employee.bsSlotShortDayMinutes),
    bsSlotBlockWeekMinutes: minutesOrNull(employee.bsSlotBlockWeekMinutes),
  };
}

// ── Bounds and messages ──────────────────────────────────────────────────────

interface Bounds {
  min: number;
  max: number;
}

/** Mirrors the API (ARBZG floors, BREAK_MAX_OVER_6H / _9H in `contexts/platform/api/employees.ts`). */
export const PAUSE_BOUNDS: Record<PauseKey, Bounds> = {
  breakOver6hOverride: { min: 30, max: 120 },
  breakOver9hOverride: { min: 45, max: 180 },
};

export const PHOREST_BOUNDS: Bounds = { min: 0, max: 30 };

/** Mirrors `vocational-school-constants.ts` (BS_DAILY_*_BOUND, BS_BLOCK_WEEKLY_*_BOUND). */
export const BS_DAILY_BOUNDS: Bounds = { min: 240, max: 600 };
export const BS_BLOCK_BOUNDS: Bounds = { min: 1200, max: 3000 };

export const BS_SLOT_BOUNDS: Record<BsSlotKey, Bounds> = {
  bsSlotFirstLongDayMinutes: BS_DAILY_BOUNDS,
  bsSlotSecondLongDayMinutes: BS_DAILY_BOUNDS,
  bsSlotShortDayMinutes: BS_DAILY_BOUNDS,
  bsSlotBlockWeekMinutes: BS_BLOCK_BOUNDS,
};

/** The message of one minute value, or undefined when it is fine (empty = inherit, always fine). */
export function minutesError(value: number | null, bounds: Bounds): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    return "Bitte eine ganze Zahl eingeben.";
  }
  if (value < bounds.min || value > bounds.max) {
    return `Der Wert muss zwischen ${bounds.min} und ${bounds.max} Minuten liegen.`;
  }
  return undefined;
}

export type Messages<K extends string> = Partial<Record<K, string>>;

function messagesOf<K extends string>(
  keys: readonly K[],
  values: Record<K, number | null>,
  bounds: (key: K) => Bounds,
): Messages<K> {
  const out: Messages<K> = {};
  for (const key of keys) {
    const message = minutesError(values[key], bounds(key));
    if (message) out[key] = message;
  }
  return out;
}

export function pauseMessages(values: PauseValues): Messages<PauseKey> {
  return messagesOf(PAUSE_KEYS, values, (key) => PAUSE_BOUNDS[key]);
}

export function phorestMessages(values: PhorestValues): Messages<PhorestKey> {
  return messagesOf(PHOREST_KEYS, values, () => PHOREST_BOUNDS);
}

export function bsSlotMessages(values: BsSlotValues): Messages<BsSlotKey> {
  return messagesOf(BS_SLOT_KEYS, values, (key) => BS_SLOT_BOUNDS[key]);
}

// ── Under 18 (§ 11 JArbSchG) ─────────────────────────────────────────────────

/**
 * Full years between `birthDay` (ISO day) and `now`; NaN for a missing or unreadable day. Mirrors
 * `ageAtDate` of `apps/api/src/contexts/absence/jarbschg.ts` (no date library).
 */
export function ageOn(birthDay: string | null | undefined, now: Date): number {
  if (!birthDay) return Number.NaN;
  const born = new Date(birthDay);
  if (Number.isNaN(born.getTime())) return Number.NaN;
  let age = now.getFullYear() - born.getFullYear();
  const month = now.getMonth() - born.getMonth();
  if (month < 0 || (month === 0 && now.getDate() < born.getDate())) age--;
  return age;
}

/**
 * § 11 JArbSchG applies to ANY person under 18, whatever the classification (Issue #574): decided
 * from the birth day alone. No birth date reads as "not under 18" (the API's regime is fail-open
 * to § 4 ArbZG in the same case).
 */
export function isUnder18(birthDay: string | null | undefined, now: Date = new Date()): boolean {
  const age = ageOn(birthDay, now);
  return Number.isFinite(age) && age < 18;
}

/** The one-click § 11 suggestion: 60 minutes in both fields (the 4.5 h band is the API's regime). */
export const UNDER_18_PAUSE: PauseValues = {
  breakOver6hOverride: 60,
  breakOver9hOverride: 60,
};

// ── Berufsschule slots: where an empty field inherits from ───────────────────

/** The values of the lower layers: the person's pattern, the company and the daily Soll. */
export interface SlotLayers {
  pattern: number | null;
  tenant: number | null;
  dailySoll: number | null;
}

function hoursLabel(minutes: number): string {
  return (minutes / 60).toLocaleString("de-DE", { maximumFractionDigits: 2 });
}

/**
 * "Erbt aus: Muster = 480 Min (8 h)" - the first lower layer that holds a value (person > Muster >
 * Unternehmen > Tages-Soll, 4-layer hierarchy of Phase 76.36); a block week falls back to the
 * weekly hours instead of the daily Soll.
 */
export function inheritedFrom(layers: SlotLayers, isBlockWeek: boolean): string {
  if (layers.pattern !== null)
    return `Erbt aus: Muster = ${layers.pattern} Min (${hoursLabel(layers.pattern)} h)`;
  if (layers.tenant !== null)
    return `Erbt aus: Unternehmen = ${layers.tenant} Min (${hoursLabel(layers.tenant)} h)`;
  if (!isBlockWeek && layers.dailySoll !== null)
    return `Erbt aus: Tages-Soll = ${layers.dailySoll} Min (${hoursLabel(layers.dailySoll)} h)`;
  return isBlockWeek
    ? "Erbt aus: Wochenstunden-Soll der Person"
    : "Erbt aus: Tages-Soll der Person";
}

/** The "= 7,5 h" echo next to a minute field, or "" while it is empty. */
export function slotHours(minutes: number | null): string {
  return minutesAsHours(minutes);
}

/**
 * The over-credit notice: the 2nd long day credits more than the 1st one that applies (own value,
 * then Muster, Unternehmen, Tages-Soll). Advisory only; the API answers the same case with its own
 * non-blocking warning. "" when nothing is over-credited or the 1st long day is unknown.
 */
export function overCreditNotice(
  secondLong: number | null,
  firstLong: number | null,
  firstLayers: SlotLayers,
): string {
  if (secondLong === null || !Number.isFinite(secondLong)) return "";
  const effectiveFirst =
    firstLong ?? firstLayers.pattern ?? firstLayers.tenant ?? firstLayers.dailySoll;
  if (effectiveFirst === null || !Number.isFinite(effectiveFirst)) return "";
  if (secondLong <= effectiveFirst) return "";
  return `Der 2. Langtag (${secondLong} Min = ${hoursLabel(secondLong)} h) übersteigt den 1. Langtag (${effectiveFirst} Min = ${hoursLabel(effectiveFirst)} h). Prüf, ob der zweite Berufsschul-Langtag so hoch gutgeschrieben werden soll.`;
}
