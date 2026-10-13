// Create-tenant form model of the operator console (Issue #89, D-07a, D-13).
//
// Pure functions behind TenantCreateDialog: client-side validation that mirrors the API's strict
// schema, the exact request body, and the mapping of a failed response to a form field. The API
// stays authoritative; control flow here reads machine codes (`code`, `details[].path`), never the
// German `error` text (D-13).
import { OperatorApiError } from "./client";
import type { FederalState } from "@clokr/types";
import type { CreateTenantBody } from "./types";
import { isValidSlug } from "./slug";

/** Field keys double as the suffix of the `op-tenant-create-field-error-<key>` test ids. */
export type TenantFieldKey =
  | "name"
  | "slug"
  | "federal-state"
  | "timezone"
  | "admin-email"
  | "admin-first-name"
  | "admin-last-name"
  | "admin-employee-number";

export interface TenantFormValues {
  name: string;
  slug: string;
  /** Empty until the operator chooses: the Bundesland is fixed for the default salon (Pitfall 6). */
  federalState: FederalState | "";
  timezone: string;
  adminEmail: string;
  adminFirstName: string;
  adminLastName: string;
  adminEmployeeNumber: string;
}

export interface FieldProblem {
  /** Machine-readable reason; shown as `data-code` so tests assert it instead of the text. */
  code: string;
  message: string;
}

export type FieldProblems = Partial<Record<TenantFieldKey, FieldProblem>>;

export function emptyTenantForm(): TenantFormValues {
  return {
    name: "",
    slug: "",
    federalState: "",
    timezone: "",
    adminEmail: "",
    adminFirstName: "",
    adminLastName: "",
    adminEmployeeNumber: "",
  };
}

/** Same shape the API's `z.string().email()` accepts for everyday addresses; the server decides the rest. */
function isEmailShape(value: string): boolean {
  const at = value.indexOf("@");
  if (at < 1 || value.indexOf("@", at + 1) !== -1 || /\s/.test(value)) return false;
  const domain = value.slice(at + 1);
  // A dot with at least one character on each side of it.
  for (let i = 1; i < domain.length - 1; i += 1) {
    if (domain[i] === ".") return true;
  }
  return false;
}

export const NAME_MAX = 200;
export const EMAIL_MAX = 254;

/** Client-side problems of the current values, one per field at most. */
export function validateTenantForm(values: TenantFormValues): FieldProblems {
  const problems: FieldProblems = {};
  const name = values.name.trim();
  if (name === "" || name.length > NAME_MAX) {
    problems.name = { code: "NAME_REQUIRED", message: "Name ist erforderlich." };
  }
  if (!isValidSlug(values.slug)) {
    problems.slug = {
      code: "SLUG_INVALID",
      message: "Kurzname: 3 bis 63 Zeichen, nur Kleinbuchstaben, Ziffern und Bindestriche.",
    };
  }
  if (values.federalState === "") {
    problems["federal-state"] = {
      code: "FEDERAL_STATE_REQUIRED",
      message: "Bundesland auswählen.",
    };
  }
  const email = values.adminEmail.trim();
  if (!isEmailShape(email) || email.length > EMAIL_MAX) {
    problems["admin-email"] = {
      code: "EMAIL_INVALID",
      message: "Gültige E-Mail-Adresse eingeben.",
    };
  }
  if (values.adminFirstName.trim() === "") {
    problems["admin-first-name"] = {
      code: "FIRST_NAME_REQUIRED",
      message: "Vorname ist erforderlich.",
    };
  }
  if (values.adminLastName.trim() === "") {
    problems["admin-last-name"] = {
      code: "LAST_NAME_REQUIRED",
      message: "Nachname ist erforderlich.",
    };
  }
  return problems;
}

/**
 * The exact request body: text trimmed, the e-mail lower-cased like the API does, and the two
 * optional keys left out (not sent as empty strings) when the operator left them empty.
 * Throws when the Bundesland is still unchosen - callers validate first.
 */
export function buildTenantBody(values: TenantFormValues): CreateTenantBody {
  if (values.federalState === "") throw new Error("federalState is required");
  const timezone = values.timezone.trim();
  const employeeNumber = values.adminEmployeeNumber.trim();
  return {
    name: values.name.trim(),
    slug: values.slug,
    federalState: values.federalState,
    ...(timezone !== "" ? { timezone } : {}),
    admin: {
      email: values.adminEmail.trim().toLowerCase(),
      firstName: values.adminFirstName.trim(),
      lastName: values.adminLastName.trim(),
      ...(employeeNumber !== "" ? { employeeNumber } : {}),
    },
  };
}

/** Whether the failed response was a zod 400 that names the timezone field. */
function namesTimezone(data: unknown): boolean {
  const details = (data as { details?: unknown } | null | undefined)?.details;
  if (!Array.isArray(details)) return false;
  return details.some((entry) => {
    const path = (entry as { path?: unknown } | null)?.path;
    return Array.isArray(path) && path.includes("timezone");
  });
}

/**
 * Maps a failed create to a form field, or null when it belongs to the dialog-level alert.
 * Keyed by the response `code` (409) and the zod `details[].path` (400) only.
 */
export function serverFieldProblem(
  error: unknown,
): { field: TenantFieldKey; problem: FieldProblem } | null {
  if (!(error instanceof OperatorApiError)) return null;
  if (error.status === 409 && error.code === "SLUG_TAKEN") {
    return {
      field: "slug",
      problem: { code: "SLUG_TAKEN", message: "Dieser Kurzname ist bereits vergeben." },
    };
  }
  if (error.status === 409 && error.code === "EMAIL_TAKEN") {
    return {
      field: "admin-email",
      problem: { code: "EMAIL_TAKEN", message: "Diese E-Mail-Adresse wird bereits verwendet." },
    };
  }
  if (error.status === 400 && namesTimezone(error.data)) {
    return {
      field: "timezone",
      problem: { code: "TIMEZONE_INVALID", message: "Ungültige Zeitzone." },
    };
  }
  return null;
}

/** Text of the dialog-level alert for every failure that is not a field problem. */
export function createFailureMessage(error: unknown): string {
  const status = (error as { status?: unknown } | null | undefined)?.status;
  if (typeof status !== "number") {
    return error instanceof TypeError
      ? "Keine Verbindung zum Server. Bitte erneut versuchen."
      : "Der Mandant konnte nicht angelegt werden. Bitte erneut versuchen.";
  }
  if (status === 429) return "Zu viele Anfragen. Bitte einen Moment warten und erneut versuchen.";
  if (status >= 500) return "Der Server hat einen Fehler gemeldet. Bitte erneut versuchen.";
  return "Der Mandant konnte nicht angelegt werden. Bitte die Eingaben prüfen und erneut versuchen.";
}
