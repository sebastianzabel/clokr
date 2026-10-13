// Opening-hours helpers of the operator salon form (Issue #89, D-10).
//
// The API stores seven entries, `day` 0 = Montag … 6 = Sonntag. A closed day still carries valid
// `open` / `close` strings because the API schema requires them, so closing a day never empties
// its times. The form keeps one entry per index, so `days[index].day === index`.
import type { FederalState } from "@clokr/types";
import type {
  CouplingProvider,
  CreateSalonBody,
  OpeningHoursDay,
  OperatorSalon,
  UpdateSalonBody,
} from "./types";

/** Display names, indexed by `day` (0 = Montag). */
export const DAY_NAMES: readonly string[] = [
  "Montag",
  "Dienstag",
  "Mittwoch",
  "Donnerstag",
  "Freitag",
  "Samstag",
  "Sonntag",
];

export const HOURS_ORDER_MESSAGE = "Die Öffnungszeit muss vor der Schließzeit liegen.";
export const HOURS_MISSING_MESSAGE = "Uhrzeit angeben.";

// Same pattern as the API schema (`salonOpeningHoursSchema`).
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Display mirror of the API's `DEFAULT_SALON_OPENING_HOURS`
 * (`apps/api/src/contexts/platform/facade/salons.ts`): the hours a salon gets when none are given.
 * The web tree cannot import API code, so `__tests__/opening-hours.test.ts` reads that source file
 * and fails when a day, time or closed flag here drifts from it. Never edit one side alone.
 */
const DEFAULT_HOURS: readonly OpeningHoursDay[] = [
  { day: 0, open: "08:00", close: "20:00", closed: false },
  { day: 1, open: "08:00", close: "20:00", closed: false },
  { day: 2, open: "08:00", close: "20:00", closed: false },
  { day: 3, open: "08:00", close: "20:00", closed: false },
  { day: 4, open: "08:00", close: "20:00", closed: false },
  { day: 5, open: "08:00", close: "20:00", closed: false },
  { day: 6, open: "08:00", close: "20:00", closed: true },
];

/** A fresh copy of the API's default hours: Montag-Samstag 08:00-20:00, Sonntag geschlossen. */
export function defaultOpeningHours(): OpeningHoursDay[] {
  return DEFAULT_HOURS.map((entry) => ({ ...entry }));
}

function isUsable(hours: readonly OpeningHoursDay[] | null | undefined): boolean {
  if (!hours || hours.length !== 7) return false;
  const seen = new Set<number>();
  for (const entry of hours) {
    if (!Number.isInteger(entry.day) || entry.day < 0 || entry.day > 6) return false;
    if (!TIME_PATTERN.test(entry.open) || !TIME_PATTERN.test(entry.close)) return false;
    seen.add(entry.day);
  }
  return seen.size === 7;
}

/**
 * The hours a new salon starts with: a deep copy of the tenant's current Standardsalon hours when
 * those are seven valid entries, otherwise the default. The copy is ordered by `day` and always
 * carries an explicit `closed`, so the form edits it in place without touching the loaded salon.
 */
export function prefillOpeningHours(
  defaultSalon: { openingHours: readonly OpeningHoursDay[] } | null | undefined,
): OpeningHoursDay[] {
  const source = defaultSalon?.openingHours;
  if (!isUsable(source)) return defaultOpeningHours();
  return [...(source as readonly OpeningHoursDay[])]
    .sort((a, b) => a.day - b.day)
    .map((entry) => ({
      day: entry.day,
      open: entry.open,
      close: entry.close,
      closed: entry.closed === true,
    }));
}

/**
 * Problems per day index. Only an open day can have one: a closed day's times are ignored by the
 * API's order check. Zero-padded `HH:MM` strings compare correctly as text.
 */
export function validateOpeningHours(days: readonly OpeningHoursDay[]): Record<number, string> {
  const errors: Record<number, string> = {};
  days.forEach((entry, index) => {
    if (entry.closed) return;
    if (!TIME_PATTERN.test(entry.open) || !TIME_PATTERN.test(entry.close)) {
      errors[index] = HOURS_MISSING_MESSAGE;
    } else if (entry.open >= entry.close) {
      errors[index] = HOURS_ORDER_MESSAGE;
    }
  });
  return errors;
}

/** An empty PLZ is fine (the field is optional); a filled one is exactly five digits. */
export function isValidPostalCode(value: string): boolean {
  return value === "" || /^\d{5}$/.test(value);
}

// ── Salon form values, validation and the PATCH diff ───────────────────────────────────────────

/** Name length limit of the API's salon schema. */
export const SALON_NAME_MAX = 100;

export const NAME_REQUIRED_MESSAGE = "Name ist erforderlich.";
export const FEDERAL_STATE_REQUIRED_MESSAGE = "Bundesland auswählen.";
export const POSTAL_CODE_MESSAGE = "PLZ: 5 Ziffern.";

/** What the salon dialog edits. Text fields are plain strings; "" means "not given". */
export interface SalonFormValues {
  name: string;
  street: string;
  postalCode: string;
  city: string;
  /** "" = nothing chosen yet (create starts there on purpose, D-07a). */
  federalState: FederalState | "";
  openingHours: OpeningHoursDay[];
  provider: CouplingProvider;
  externalBranchId: string;
}

export type SalonFieldKey = "name" | "postal-code" | "federal-state";

/** A fresh create form: hours from the Standardsalon (else the API default), nothing else filled. */
export function emptySalonForm(
  defaultSalon: { openingHours: readonly OpeningHoursDay[] } | null | undefined,
): SalonFormValues {
  return {
    name: "",
    street: "",
    postalCode: "",
    city: "",
    federalState: "",
    openingHours: prefillOpeningHours(defaultSalon),
    provider: "NONE",
    externalBranchId: "",
  };
}

/** The edit form of a loaded salon. Missing address parts become "". */
export function salonFormFromSalon(salon: OperatorSalon): SalonFormValues {
  const phorest = salon.coupling?.provider === "PHOREST";
  return {
    name: salon.name,
    street: salon.street ?? "",
    postalCode: salon.postalCode ?? "",
    city: salon.city ?? "",
    federalState: salon.federalState,
    openingHours: prefillOpeningHours(salon),
    provider: phorest ? "PHOREST" : "NONE",
    externalBranchId: phorest ? (salon.coupling?.externalBranchId ?? "") : "",
  };
}

/** Problems that block saving, keyed by field. The API stays authoritative. */
export function validateSalonForm(form: SalonFormValues): Partial<Record<SalonFieldKey, string>> {
  const problems: Partial<Record<SalonFieldKey, string>> = {};
  if (form.name.trim() === "") problems.name = NAME_REQUIRED_MESSAGE;
  if (form.federalState === "") problems["federal-state"] = FEDERAL_STATE_REQUIRED_MESSAGE;
  if (!isValidPostalCode(form.postalCode.trim())) problems["postal-code"] = POSTAL_CODE_MESSAGE;
  return problems;
}

/** Whole-form validity: field problems, every open day in order, and a Filialkennung for Phorest. */
export function isSalonFormValid(form: SalonFormValues): boolean {
  if (Object.keys(validateSalonForm(form)).length > 0) return false;
  if (Object.keys(validateOpeningHours(form.openingHours)).length > 0) return false;
  return form.provider !== "PHOREST" || form.externalBranchId.trim() !== "";
}

/** The wire shape of one day: all four keys, `closed` always explicit. */
function wireDay(entry: OpeningHoursDay): OpeningHoursDay {
  return { day: entry.day, open: entry.open, close: entry.close, closed: entry.closed === true };
}

function sameHours(a: readonly OpeningHoursDay[], b: readonly OpeningHoursDay[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((entry, index) => {
    const other = b[index];
    return (
      other !== undefined &&
      entry.day === other.day &&
      entry.open === other.open &&
      entry.close === other.close &&
      (entry.closed === true) === (other.closed === true)
    );
  });
}

/** Cleared address field -> `null` (the API stores "no value"); anything else trimmed. */
function addressPatch(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * The PATCH body for an edit: only the keys that differ from the loaded salon (T-89-41). `coupling`
 * appears only when it changed: another Filialkennung or a first Phorest coupling -> the object,
 * Phorest -> Keine -> `null`. An identical form yields `{}`.
 */
export function diffSalonForm(original: SalonFormValues, form: SalonFormValues): UpdateSalonBody {
  const patch: UpdateSalonBody = {};
  if (form.name.trim() !== original.name.trim()) patch.name = form.name.trim();
  if (form.street.trim() !== original.street.trim()) patch.street = addressPatch(form.street);
  if (form.postalCode.trim() !== original.postalCode.trim()) {
    patch.postalCode = addressPatch(form.postalCode);
  }
  if (form.city.trim() !== original.city.trim()) patch.city = addressPatch(form.city);
  if (form.federalState !== "" && form.federalState !== original.federalState) {
    patch.federalState = form.federalState;
  }
  if (!sameHours(original.openingHours, form.openingHours)) {
    patch.openingHours = form.openingHours.map(wireDay);
  }
  if (form.provider === "PHOREST") {
    const branch = form.externalBranchId.trim();
    if (original.provider !== "PHOREST" || branch !== original.externalBranchId.trim()) {
      patch.coupling = { externalBranchId: branch };
    }
  } else if (original.provider === "PHOREST") {
    patch.coupling = null;
  }
  return patch;
}

/**
 * The POST body for a new salon: the hours are always sent explicitly (all seven days), empty
 * address fields and a "Keine" coupling are left out. Call only with a valid form.
 */
export function buildCreateSalonBody(form: SalonFormValues): CreateSalonBody {
  const body: CreateSalonBody = {
    name: form.name.trim(),
    openingHours: form.openingHours.map(wireDay),
    federalState: form.federalState as FederalState,
  };
  if (form.street.trim() !== "") body.street = form.street.trim();
  if (form.postalCode.trim() !== "") body.postalCode = form.postalCode.trim();
  if (form.city.trim() !== "") body.city = form.city.trim();
  if (form.provider === "PHOREST")
    body.coupling = { externalBranchId: form.externalBranchId.trim() };
  return body;
}
