// Issue #854 (D-854-03) - the pure half of Verwalten › System › Allgemein: how each section reads its
// values from the settings endpoints, which messages its fields show and what its save puts on the wire. No
// runes and no `$app` imports on purpose; the section components (`lib/components/admin/allgemein/`) own the
// form state and the request.
//
// The server stays the authority for every rule (the Zod schemas of `PUT /settings/work` and `/security`);
// the checks here only save a round trip and mirror the bounds the page always showed.

import { messageCount, type FieldMessages } from "$lib/settings/arbeitszeit";

export { messageCount };

// ── Unternehmen & Region ─────────────────────────────────────────────────────────────────────────

/** The part of `GET /settings/work` the company section reads. */
export interface CompanyConfig {
  tenantName?: string;
  federalState?: string;
  timezone?: string;
}

export const FEDERAL_STATES: readonly { value: string; label: string }[] = [
  { value: "NIEDERSACHSEN", label: "Niedersachsen" },
  { value: "BADEN_WUERTTEMBERG", label: "Baden-Württemberg" },
  { value: "BAYERN", label: "Bayern" },
  { value: "BERLIN", label: "Berlin" },
  { value: "BRANDENBURG", label: "Brandenburg" },
  { value: "BREMEN", label: "Bremen" },
  { value: "HAMBURG", label: "Hamburg" },
  { value: "HESSEN", label: "Hessen" },
  { value: "MECKLENBURG_VORPOMMERN", label: "Mecklenburg-Vorpommern" },
  { value: "NORDRHEIN_WESTFALEN", label: "Nordrhein-Westfalen" },
  { value: "RHEINLAND_PFALZ", label: "Rheinland-Pfalz" },
  { value: "SCHLESWIG_HOLSTEIN", label: "Schleswig-Holstein" },
  { value: "SAARLAND", label: "Saarland" },
  { value: "SACHSEN", label: "Sachsen" },
  { value: "SACHSEN_ANHALT", label: "Sachsen-Anhalt" },
  { value: "THUERINGEN", label: "Thüringen" },
];

export const TIMEZONES: readonly string[] = [
  "Europe/Berlin",
  "Europe/Vienna",
  "Europe/Zurich",
  "Europe/Amsterdam",
  "Europe/Brussels",
  "Europe/Luxembourg",
  "Europe/Paris",
  "Europe/London",
  "Europe/Warsaw",
  "Europe/Prague",
  "Europe/Rome",
  "Europe/Madrid",
  "Europe/Stockholm",
  "Europe/Copenhagen",
  "Europe/Helsinki",
  "Europe/Athens",
  "Europe/Istanbul",
  "Europe/Moscow",
  "America/New_York",
  "America/Chicago",
  "America/Los_Angeles",
  "Asia/Tokyo",
  "Asia/Shanghai",
  "UTC",
];

export const DEFAULT_FEDERAL_STATE = "NIEDERSACHSEN";
export const DEFAULT_TIMEZONE = "Europe/Berlin";
export const TENANT_NAME_MAX = 200;

// Type aliases, not interfaces: countChanges/pickSection take `Record<string, unknown>`, which an
// interface (no implicit index signature) does not satisfy.
export type CompanyValues = { tenantName: string; federalState: string; timezone: string };
export type CompanyField = keyof CompanyValues;

export function companyFrom(config: CompanyConfig): CompanyValues {
  return {
    tenantName: config.tenantName ?? "",
    federalState: config.federalState ?? DEFAULT_FEDERAL_STATE,
    timezone: config.timezone ?? DEFAULT_TIMEZONE,
  };
}

export function companyMessages(values: CompanyValues): FieldMessages<CompanyField> {
  const messages: FieldMessages<CompanyField> = {};
  const name = values.tenantName.trim();
  if (name === "") messages.tenantName = "Gib den Namen des Unternehmens ein.";
  else if (name.length > TENANT_NAME_MAX) {
    messages.tenantName = `Der Name darf höchstens ${TENANT_NAME_MAX} Zeichen lang sein.`;
  }
  return messages;
}

export function companyWire(values: CompanyValues): Record<CompanyField, unknown> {
  return {
    tenantName: values.tenantName.trim(),
    federalState: values.federalState,
    timezone: values.timezone,
  };
}

// ── Sicherheit (GET/PUT /settings/security) ──────────────────────────────────────────────────────

/** The part of `GET /settings/security` the three security sections read. Every field is optional on the wire. */
export interface SecurityConfig {
  twoFaEnabled?: boolean;
  passwordMinLength?: number;
  passwordRequireUpper?: boolean;
  passwordRequireLower?: boolean;
  passwordRequireDigit?: boolean;
  passwordRequireSpecial?: boolean;
  sessionTimeoutMinutes?: number;
  refreshTokenDays?: number;
  rememberMeEnabled?: boolean;
  rememberMeDays?: number;
  maxSessionsPerUser?: number;
  loginMaxAttempts?: number;
  loginLockoutMinutes?: number;
}

function wholeIn(value: number | null, min: number, max: number): boolean {
  return value !== null && Number.isInteger(value) && value >= min && value <= max;
}

// ── Passwort-Richtlinie ──────────────────────────────────────────────────────────────────────────

export const PASSWORD_MIN_LENGTH_MIN = 8;
export const PASSWORD_MIN_LENGTH_MAX = 128;

export type PasswordValues = {
  /** Null while the field is empty. */
  passwordMinLength: number | null;
  passwordRequireUpper: boolean;
  passwordRequireLower: boolean;
  passwordRequireDigit: boolean;
  passwordRequireSpecial: boolean;
};
export type PasswordField = keyof PasswordValues;

export function passwordFrom(config: SecurityConfig): PasswordValues {
  return {
    passwordMinLength: config.passwordMinLength ?? 12,
    passwordRequireUpper: config.passwordRequireUpper ?? true,
    passwordRequireLower: config.passwordRequireLower ?? true,
    passwordRequireDigit: config.passwordRequireDigit ?? true,
    passwordRequireSpecial: config.passwordRequireSpecial ?? true,
  };
}

export function passwordMessages(values: PasswordValues): FieldMessages<PasswordField> {
  const messages: FieldMessages<PasswordField> = {};
  if (!wholeIn(values.passwordMinLength, PASSWORD_MIN_LENGTH_MIN, PASSWORD_MIN_LENGTH_MAX)) {
    messages.passwordMinLength = `Gib eine Länge zwischen ${PASSWORD_MIN_LENGTH_MIN} und ${PASSWORD_MIN_LENGTH_MAX} Zeichen ein.`;
  }
  return messages;
}

export function passwordWire(values: PasswordValues): Record<PasswordField, unknown> {
  return {
    passwordMinLength: values.passwordMinLength,
    passwordRequireUpper: values.passwordRequireUpper,
    passwordRequireLower: values.passwordRequireLower,
    passwordRequireDigit: values.passwordRequireDigit,
    passwordRequireSpecial: values.passwordRequireSpecial,
  };
}

// ── Sitzungen ────────────────────────────────────────────────────────────────────────────────────

/** Bounds of the Zod schema of `PUT /settings/security`, named once. */
export const SESSION_BOUNDS = {
  sessionTimeoutMinutes: { min: 0, max: 480, label: "Inaktivitäts-Timeout", unit: "Minuten" },
  refreshTokenDays: { min: 1, max: 90, label: "Sitzungsdauer", unit: "Tage" },
  rememberMeDays: { min: 1, max: 365, label: "Dauer von „Angemeldet bleiben“", unit: "Tage" },
  maxSessionsPerUser: { min: 0, max: 20, label: "Gleichzeitige Sitzungen", unit: "Sitzungen" },
  loginMaxAttempts: { min: 1, max: 20, label: "Fehlversuche bis zur Sperre", unit: "Versuche" },
  loginLockoutMinutes: { min: 1, max: 1440, label: "Sperrzeit", unit: "Minuten" },
} as const;

export type SessionValues = {
  sessionTimeoutMinutes: number | null;
  refreshTokenDays: number | null;
  rememberMeEnabled: boolean;
  rememberMeDays: number | null;
  maxSessionsPerUser: number | null;
  loginMaxAttempts: number | null;
  loginLockoutMinutes: number | null;
};
export type SessionField = keyof SessionValues;
export type SessionNumberField = keyof typeof SESSION_BOUNDS;

export function sessionFrom(config: SecurityConfig): SessionValues {
  return {
    sessionTimeoutMinutes: config.sessionTimeoutMinutes ?? 60,
    refreshTokenDays: config.refreshTokenDays ?? 7,
    rememberMeEnabled: config.rememberMeEnabled ?? true,
    rememberMeDays: config.rememberMeDays ?? 30,
    maxSessionsPerUser: config.maxSessionsPerUser ?? 0,
    loginMaxAttempts: config.loginMaxAttempts ?? 5,
    loginLockoutMinutes: config.loginLockoutMinutes ?? 15,
  };
}

export function sessionMessages(values: SessionValues): FieldMessages<SessionField> {
  const messages: FieldMessages<SessionField> = {};
  for (const field of Object.keys(SESSION_BOUNDS) as SessionNumberField[]) {
    const { min, max } = SESSION_BOUNDS[field];
    if (!wholeIn(values[field], min, max)) {
      messages[field] = `Gib einen Wert zwischen ${min} und ${max} ein.`;
    }
  }
  return messages;
}

export function sessionWire(values: SessionValues): Record<SessionField, unknown> {
  return {
    sessionTimeoutMinutes: values.sessionTimeoutMinutes,
    refreshTokenDays: values.refreshTokenDays,
    rememberMeEnabled: values.rememberMeEnabled,
    rememberMeDays: values.rememberMeDays,
    maxSessionsPerUser: values.maxSessionsPerUser,
    loginMaxAttempts: values.loginMaxAttempts,
    loginLockoutMinutes: values.loginLockoutMinutes,
  };
}
