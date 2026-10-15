/**
 * The data rules of the tenant salon form (Issue #563): form values, validation, the create body
 * and the changed-keys-only patch. Pure functions, no DOM, no store.
 *
 * Tenant-only module written against the tenant salon route's types. The server stays the
 * authority for every rule here (lengths, required Bundesland on create through the page,
 * Bundesland lock); a test pins the copies that exist for convenience.
 */

import type { FederalStateCode } from "./federal-states";
import {
  DEFAULT_OPENING_HOURS,
  prefillOpeningHours,
  validateOpeningHours,
  type OpeningHoursDay,
} from "./opening-hours";

/** The fields of a salon row of `GET /api/v1/salons[/:id]` the admin pages use. */
export interface SalonDto {
  id: string;
  name: string;
  street: string | null;
  postalCode: string | null;
  city: string | null;
  federalState: FederalStateCode;
  openingHours: unknown;
  isActive: boolean;
  deactivatedAt: string | null;
}

export interface SalonFormValues {
  name: string;
  street: string;
  postalCode: string;
  city: string;
  /** "" = nothing chosen yet (a new salon must choose explicitly). */
  federalState: FederalStateCode | "";
  openingHours: OpeningHoursDay[];
}

export type SalonFormField =
  "name" | "street" | "postalCode" | "city" | "federalState" | "openingHours";

export type SalonFormErrors = Partial<Record<SalonFormField, string>>;

/** The keys of `PATCH /api/v1/salons/:id` this form can change (never `isActive`). */
export type SalonPatchKey = SalonFormField;

export type SalonPatch = Partial<{
  name: string;
  street: string | null;
  postalCode: string | null;
  city: string | null;
  federalState: FederalStateCode;
  openingHours: OpeningHoursDay[];
}>;

export interface CreateSalonBody {
  name: string;
  street: string | null;
  postalCode: string | null;
  city: string | null;
  federalState: FederalStateCode;
  openingHours: OpeningHoursDay[];
}

// Same limits as the API's `createSalonSchema` / `updateSalonSchema`.
const NAME_MAX_LENGTH = 100;
const STREET_MAX_LENGTH = 200;
const POSTAL_CODE_MAX_LENGTH = 20;
const CITY_MAX_LENGTH = 100;

const PATCH_KEYS: readonly SalonPatchKey[] = [
  "name",
  "street",
  "postalCode",
  "city",
  "federalState",
  "openingHours",
];

export function emptySalonForm(): SalonFormValues {
  return {
    name: "",
    street: "",
    postalCode: "",
    city: "",
    federalState: "",
    openingHours: DEFAULT_OPENING_HOURS.map((day) => ({ ...day })),
  };
}

export function salonToForm(salon: SalonDto): SalonFormValues {
  return {
    name: salon.name,
    street: salon.street ?? "",
    postalCode: salon.postalCode ?? "",
    city: salon.city ?? "",
    federalState: salon.federalState,
    openingHours: prefillOpeningHours(salon.openingHours),
  };
}

/** An empty or blank address part is stored as null. */
function nullIfBlank(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * German messages per field; an empty object means the form may be sent. `mode` "create" requires
 * an explicit Bundesland (a salon must never inherit one silently), "edit" does not.
 */
export function validateSalonForm(form: SalonFormValues, mode: "create" | "edit"): SalonFormErrors {
  const errors: SalonFormErrors = {};
  const name = form.name.trim();
  if (name === "") {
    errors.name = "Bitte einen Namen angeben.";
  } else if (name.length > NAME_MAX_LENGTH) {
    errors.name = `Der Name darf höchstens ${NAME_MAX_LENGTH} Zeichen lang sein.`;
  }
  if (form.street.trim().length > STREET_MAX_LENGTH) {
    errors.street = `Die Straße darf höchstens ${STREET_MAX_LENGTH} Zeichen lang sein.`;
  }
  if (form.postalCode.trim().length > POSTAL_CODE_MAX_LENGTH) {
    errors.postalCode = `Die Postleitzahl darf höchstens ${POSTAL_CODE_MAX_LENGTH} Zeichen lang sein.`;
  }
  if (form.city.trim().length > CITY_MAX_LENGTH) {
    errors.city = `Der Ort darf höchstens ${CITY_MAX_LENGTH} Zeichen lang sein.`;
  }
  if (mode === "create" && form.federalState === "") {
    errors.federalState = "Bitte ein Bundesland wählen.";
  }
  if (Object.keys(validateOpeningHours(form.openingHours)).length > 0) {
    errors.openingHours = "Bitte prüfen Sie die markierten Tage.";
  }
  return errors;
}

/** The body of `POST /api/v1/salons`: always an explicit Bundesland, never `isActive`. */
export function createSalonBody(form: SalonFormValues): CreateSalonBody {
  if (form.federalState === "") {
    throw new Error("A new salon needs an explicit federal state.");
  }
  return {
    name: form.name.trim(),
    street: nullIfBlank(form.street),
    postalCode: nullIfBlank(form.postalCode),
    city: nullIfBlank(form.city),
    federalState: form.federalState,
    openingHours: form.openingHours.map((day) => ({ ...day })),
  };
}

function weekKey(days: readonly OpeningHoursDay[]): string {
  return JSON.stringify(
    [...days]
      .sort((a, b) => a.day - b.day)
      .map((entry) => [entry.day, entry.open, entry.close, entry.closed === true]),
  );
}

/**
 * The changed keys of `form` against the stored `salon`, restricted to `keys` (default: all);
 * `null` when nothing changed, so a caller never sends an empty body (the server answers 400).
 * An address part that is blank in the form and null in the store counts as unchanged.
 */
export function salonPatch(
  salon: SalonDto,
  form: SalonFormValues,
  keys: readonly SalonPatchKey[] = PATCH_KEYS,
): SalonPatch | null {
  const patch: SalonPatch = {};
  const wants = (key: SalonPatchKey) => keys.includes(key);

  const name = form.name.trim();
  if (wants("name") && name !== salon.name) patch.name = name;

  const address = [
    ["street", form.street, salon.street],
    ["postalCode", form.postalCode, salon.postalCode],
    ["city", form.city, salon.city],
  ] as const;
  for (const [key, value, stored] of address) {
    if (!wants(key)) continue;
    const next = nullIfBlank(value);
    if (next !== (stored ?? null)) patch[key] = next;
  }

  if (
    wants("federalState") &&
    form.federalState !== "" &&
    form.federalState !== salon.federalState
  ) {
    patch.federalState = form.federalState;
  }

  if (
    wants("openingHours") &&
    weekKey(form.openingHours) !== weekKey(prefillOpeningHours(salon.openingHours))
  ) {
    patch.openingHours = form.openingHours.map((day) => ({ ...day }));
  }

  return Object.keys(patch).length === 0 ? null : patch;
}
