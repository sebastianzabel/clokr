// Issue #854 (plan 854-22) - the pure model of the Berufsschultage editor of the person detail
// (Phase 67 / 67.1 / 67.2 / 76.37): the editor draft, its hydration from
// GET /employees/:id/vocational-school-pattern, the validation that mirrors the API's refine and
// the PUT body. The editor draft is NEVER sent as it is; `patternsBody` strips the key and the mode.
//
// Weekday indices of a pattern are 0 = Montag … 6 = Sonntag (not the 0 = Sonntag of the company
// workdays); `toPickerDays` / `fromPickerDays` convert for the shared WeekdayPicker.

import {
  BS_BLOCK_BOUNDS,
  BS_DAILY_BOUNDS,
  minutesError,
  type BsSlotKey,
} from "$lib/employees/overrides-form";
import { sameSettingValue } from "$lib/settings/section-state";

export type PatternMode = "weekly" | "block";

export type FederalState =
  | "BADEN_WUERTTEMBERG"
  | "BAYERN"
  | "BERLIN"
  | "BRANDENBURG"
  | "BREMEN"
  | "HAMBURG"
  | "HESSEN"
  | "MECKLENBURG_VORPOMMERN"
  | "NIEDERSACHSEN"
  | "NORDRHEIN_WESTFALEN"
  | "RHEINLAND_PFALZ"
  | "SAARLAND"
  | "SACHSEN"
  | "SACHSEN_ANHALT"
  | "SCHLESWIG_HOLSTEIN"
  | "THUERINGEN";

/** The labels of the Bundesland choice (the same strings as the company settings). */
export const FEDERAL_STATE_OPTIONS: { value: FederalState; label: string }[] = [
  { value: "BADEN_WUERTTEMBERG", label: "Baden-Württemberg" },
  { value: "BAYERN", label: "Bayern" },
  { value: "BERLIN", label: "Berlin" },
  { value: "BRANDENBURG", label: "Brandenburg" },
  { value: "BREMEN", label: "Bremen" },
  { value: "HAMBURG", label: "Hamburg" },
  { value: "HESSEN", label: "Hessen" },
  { value: "MECKLENBURG_VORPOMMERN", label: "Mecklenburg-Vorpommern" },
  { value: "NIEDERSACHSEN", label: "Niedersachsen" },
  { value: "NORDRHEIN_WESTFALEN", label: "Nordrhein-Westfalen" },
  { value: "RHEINLAND_PFALZ", label: "Rheinland-Pfalz" },
  { value: "SAARLAND", label: "Saarland" },
  { value: "SACHSEN", label: "Sachsen" },
  { value: "SACHSEN_ANHALT", label: "Sachsen-Anhalt" },
  { value: "SCHLESWIG_HOLSTEIN", label: "Schleswig-Holstein" },
  { value: "THUERINGEN", label: "Thüringen" },
];

/** One pattern row as GET and PUT /employees/:id/vocational-school-pattern answer it. */
export interface StoredPattern {
  id: string;
  /** Legacy single day (pre-v1.7.4); `daysOfWeek` is canonical. */
  dayOfWeek: number | null;
  daysOfWeek: number[];
  blockWeeks: number[];
  blockYear: number | null;
  validFrom: string;
  validUntil: string | null;
  respectSchoolHolidays?: boolean;
  federalStateOverride?: FederalState | null;
  bsSlotFirstLongDayMinutes?: number | null;
  bsSlotSecondLongDayMinutes?: number | null;
  bsSlotShortDayMinutes?: number | null;
  bsSlotBlockWeekMinutes?: number | null;
}

export interface PatternDraft {
  /** The stored id, or a synthetic `new-n` for a row not saved yet (a {#each} key only). */
  key: string;
  mode: PatternMode;
  daysOfWeek: number[];
  blockWeeks: number[];
  blockYear: number | null;
  validFrom: string;
  validUntil: string | null;
  respectSchoolHolidays: boolean;
  federalStateOverride: FederalState | null;
  /** Per-pattern Zeitgutschrift slots; null = inherit from the company / the daily Soll. */
  bsSlotFirstLongDayMinutes: number | null;
  bsSlotSecondLongDayMinutes: number | null;
  bsSlotShortDayMinutes: number | null;
  bsSlotBlockWeekMinutes: number | null;
}

/**
 * A stored row as an editor draft. The mode follows the data shape: any block week means 'block'
 * (a legacy row with both is coerced to 'block', the dominant reading of the old OR semantics).
 */
export function draftOf(stored: StoredPattern): PatternDraft {
  const days =
    stored.daysOfWeek && stored.daysOfWeek.length > 0
      ? [...stored.daysOfWeek]
      : stored.dayOfWeek != null
        ? [stored.dayOfWeek]
        : [];
  const weeks = [...stored.blockWeeks];
  return {
    key: stored.id,
    mode: weeks.length > 0 ? "block" : "weekly",
    daysOfWeek: days,
    blockWeeks: weeks,
    blockYear: stored.blockYear,
    validFrom: stored.validFrom,
    validUntil: stored.validUntil,
    respectSchoolHolidays: stored.respectSchoolHolidays ?? true,
    federalStateOverride: stored.federalStateOverride ?? null,
    bsSlotFirstLongDayMinutes: stored.bsSlotFirstLongDayMinutes ?? null,
    bsSlotSecondLongDayMinutes: stored.bsSlotSecondLongDayMinutes ?? null,
    bsSlotShortDayMinutes: stored.bsSlotShortDayMinutes ?? null,
    bsSlotBlockWeekMinutes: stored.bsSlotBlockWeekMinutes ?? null,
  };
}

/** A new weekly row valid from `today` (the much more common mode; block schools are special). */
export function newDraft(counter: number, today: string): PatternDraft {
  return {
    key: `new-${counter}`,
    mode: "weekly",
    daysOfWeek: [],
    blockWeeks: [],
    blockYear: null,
    validFrom: today,
    validUntil: null,
    respectSchoolHolidays: true,
    federalStateOverride: null,
    bsSlotFirstLongDayMinutes: null,
    bsSlotSecondLongDayMinutes: null,
    bsSlotShortDayMinutes: null,
    bsSlotBlockWeekMinutes: null,
  };
}

/** Switching the mode clears the other mode's data, so a PUT never carries leftovers of it. */
export function withMode(draft: PatternDraft, mode: PatternMode): PatternDraft {
  if (draft.mode === mode) return draft;
  return mode === "weekly"
    ? { ...draft, mode, blockWeeks: [], blockYear: null }
    : { ...draft, mode, daysOfWeek: [] };
}

/** Toggle a number in a sorted set. */
export function toggled(list: readonly number[], value: number): number[] {
  return list.includes(value)
    ? list.filter((item) => item !== value)
    : [...list, value].sort((a, b) => a - b);
}

/** Toggle one block week; emptying the set also clears the year (it only means something with weeks). */
export function withBlockWeekToggled(
  draft: PatternDraft,
  week: number,
  currentYear: number,
): PatternDraft {
  const weeks = toggled(draft.blockWeeks, week);
  return {
    ...draft,
    blockWeeks: weeks,
    blockYear: weeks.length === 0 ? null : (draft.blockYear ?? currentYear),
  };
}

// ── Weekday indices ──────────────────────────────────────────────────────────

/** Pattern days (0 = Mo … 6 = So) as the picker's days (0 = So, 1 = Mo … 6 = Sa). */
export function toPickerDays(days: readonly number[]): number[] {
  return days.map((day) => (day + 1) % 7).sort((a, b) => a - b);
}

/** The picker's days back as pattern days, ascending. */
export function fromPickerDays(days: readonly number[]): number[] {
  return days.map((day) => (day + 6) % 7).sort((a, b) => a - b);
}

// ── Validation ───────────────────────────────────────────────────────────────

const SLOT_BOUNDS: Record<BsSlotKey, typeof BS_DAILY_BOUNDS> = {
  bsSlotFirstLongDayMinutes: BS_DAILY_BOUNDS,
  bsSlotSecondLongDayMinutes: BS_DAILY_BOUNDS,
  bsSlotShortDayMinutes: BS_DAILY_BOUNDS,
  bsSlotBlockWeekMinutes: BS_BLOCK_BOUNDS,
};

export const PATTERN_SLOT_KEYS = Object.keys(SLOT_BOUNDS) as BsSlotKey[];

/** The messages of one row, by field; an empty object when the row is fine. */
export interface PatternMessages {
  validFrom?: string;
  days?: string;
  weeks?: string;
  year?: string;
  validUntil?: string;
  slots: Partial<Record<BsSlotKey, string>>;
}

/** Mirrors the API's refine of `putPatternsSchema`: weekly needs a day, block needs weeks and a year. */
export function patternMessages(draft: PatternDraft): PatternMessages {
  const out: PatternMessages = { slots: {} };
  if (!draft.validFrom) out.validFrom = "„Gültig ab“ ist erforderlich.";
  if (draft.mode === "weekly") {
    if (draft.daysOfWeek.length === 0) out.days = "Wähle mindestens einen Wochentag.";
  } else {
    if (draft.blockWeeks.length === 0) out.weeks = "Wähle mindestens eine Block-Woche.";
    if (draft.blockYear == null)
      out.year = "Das Jahr ist erforderlich, wenn Block-Wochen gewählt sind.";
  }
  if (draft.validUntil && draft.validFrom && draft.validUntil < draft.validFrom) {
    out.validUntil = "„Gültig bis“ darf nicht vor „Gültig ab“ liegen.";
  }
  for (const key of PATTERN_SLOT_KEYS) {
    const message = minutesError(draft[key], SLOT_BOUNDS[key]);
    if (message) out.slots[key] = message;
  }
  return out;
}

/** The number of invalid fields of one row. */
export function messageCountOf(messages: PatternMessages): number {
  const own = [
    messages.validFrom,
    messages.days,
    messages.weeks,
    messages.year,
    messages.validUntil,
  ].filter(Boolean);
  return own.length + Object.values(messages.slots).filter(Boolean).length;
}

export function patternsErrorCount(drafts: readonly PatternDraft[]): number {
  return drafts.reduce((sum, draft) => sum + messageCountOf(patternMessages(draft)), 0);
}

// ── Changes and the PUT body ─────────────────────────────────────────────────

/**
 * The SaveBar's count: rows added, removed or edited against the saved list. The list is replaced
 * as a whole by one PUT, so a row is one change however many of its fields moved.
 */
export function patternChangeCount(
  saved: readonly PatternDraft[],
  current: readonly PatternDraft[],
): number {
  const savedByKey = new Map(saved.map((draft) => [draft.key, draft]));
  const currentKeys = new Set(current.map((draft) => draft.key));
  let changes = saved.filter((draft) => !currentKeys.has(draft.key)).length;
  for (const draft of current) {
    const before = savedByKey.get(draft.key);
    if (!before || !sameSettingValue(before, draft)) changes += 1;
  }
  return changes;
}

/** The PUT body: persistable fields only, never the key or the mode. */
export function patternsBody(drafts: readonly PatternDraft[]) {
  return {
    patterns: drafts.map((draft) => ({
      daysOfWeek: draft.daysOfWeek,
      blockWeeks: draft.blockWeeks,
      blockYear: draft.blockYear,
      validFrom: draft.validFrom,
      validUntil: draft.validUntil,
      respectSchoolHolidays: draft.respectSchoolHolidays,
      federalStateOverride: draft.federalStateOverride,
      bsSlotFirstLongDayMinutes: draft.bsSlotFirstLongDayMinutes,
      bsSlotSecondLongDayMinutes: draft.bsSlotSecondLongDayMinutes,
      bsSlotShortDayMinutes: draft.bsSlotShortDayMinutes,
      bsSlotBlockWeekMinutes: draft.bsSlotBlockWeekMinutes,
    })),
  };
}

/** Does any saved row start before `today` - the trigger of the retroactive check (Phase 103). */
export function hasRetroactiveRow(drafts: readonly PatternDraft[], today: string): boolean {
  return drafts.some((draft) => draft.validFrom < today);
}
