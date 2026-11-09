/**
 * Issue #573 (D-01…D-05) — the ONE place where Zod's default validation texts become German.
 *
 * `z.config({ customError })` (registered by `registerGermanZodErrors()`, called once from
 * `app.ts`) replaces Zod's English DEFAULT texts only. A schema's own message (`.min(1, "…")`,
 * `refine(…, { message })`) keeps precedence — Zod resolves a schema-level error before the global
 * map — so every existing German custom text stays untouched. Zod's bundled German locale is not
 * used: it names TypeScript types and addresses the reader formally.
 *
 * `validationSummary()` builds the response `message` without any field KEY: a known field is named
 * by its German label, an unknown one only by its text. The keys stay machine-readable in
 * `details[].path` (for the web's field mapping, #843) and in the server log.
 */
import { z } from "zod";

/** A Zod 4 issue as the global error map receives it (only the fields we read). */
export interface ZodIssueLike {
  code?: string;
  input?: unknown;
  expected?: string;
  origin?: string;
  minimum?: number | bigint | Date;
  maximum?: number | bigint | Date;
  inclusive?: boolean;
  exact?: boolean;
  format?: string;
  divisor?: number | bigint;
  values?: readonly unknown[];
  keys?: readonly string[];
  message?: string;
}

export const GENERIC_INVALID = "Ungültige Eingabe.";

function num(v: unknown): string {
  if (v instanceof Date) return v.toLocaleDateString("de-DE", { timeZone: "UTC" });
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") return v.toLocaleString("de-DE");
  return String(v);
}

function expectedKind(expected: string | undefined): string {
  switch (expected) {
    case "number":
    case "int":
    case "bigint":
    case "nan":
      return "Bitte gib eine Zahl ein.";
    case "string":
      return "Bitte gib einen Text ein.";
    case "boolean":
      return "Bitte wähle Ja oder Nein.";
    case "array":
    case "set":
    case "tuple":
      return "Bitte gib eine Liste an.";
    case "date":
      return "Bitte gib ein gültiges Datum an.";
    case "object":
    case "record":
    case "map":
      return "Die Angaben sind unvollständig.";
    default:
      return GENERIC_INVALID;
  }
}

function sizeText(issue: ZodIssueLike, small: boolean): string {
  const bound = small ? issue.minimum : issue.maximum;
  const b = num(bound);
  const inclusive = issue.inclusive !== false;
  switch (issue.origin) {
    case "string":
      if (issue.exact) return `Genau ${b} Zeichen erforderlich.`;
      if (small && Number(bound) === 1) return "Pflichtfeld.";
      return small ? `Mindestens ${b} Zeichen erforderlich.` : `Höchstens ${b} Zeichen erlaubt.`;
    case "array":
    case "set":
      if (issue.exact) return `Genau ${b} Einträge erforderlich.`;
      if (small && Number(bound) === 1) return "Bitte wähle mindestens einen Eintrag.";
      return small ? `Mindestens ${b} Einträge erforderlich.` : `Höchstens ${b} Einträge erlaubt.`;
    case "date":
      return small
        ? `Das Datum darf nicht vor dem ${b} liegen.`
        : `Das Datum darf nicht nach dem ${b} liegen.`;
    case "file":
      return small ? "Die Datei ist zu klein." : "Die Datei ist zu groß.";
    default:
      // number, int, bigint and anything else with a numeric bound
      if (small)
        return inclusive
          ? `Der Wert muss mindestens ${b} sein.`
          : `Der Wert muss größer als ${b} sein.`;
      return inclusive
        ? `Der Wert darf höchstens ${b} sein.`
        : `Der Wert muss kleiner als ${b} sein.`;
  }
}

function formatText(format: string | undefined): string {
  switch (format) {
    case "email":
      return "Bitte gib eine gültige E-Mail-Adresse ein.";
    case "url":
      return "Bitte gib eine gültige Adresse (URL) ein.";
    case "uuid":
    case "guid":
    case "cuid":
    case "cuid2":
    case "ulid":
    case "nanoid":
      return "Ungültige Kennung.";
    case "datetime":
      return "Bitte gib einen gültigen Zeitpunkt an.";
    case "date":
      return "Bitte gib ein gültiges Datum an (JJJJ-MM-TT).";
    case "time":
      return "Bitte gib eine gültige Uhrzeit an (HH:MM).";
    case "ipv4":
    case "ipv6":
    case "cidrv4":
    case "cidrv6":
      return "Bitte gib eine gültige IP-Adresse an.";
    default:
      // regex, starts_with, ends_with, includes, base64, jwt, emoji, …
      return "Das Format ist ungültig.";
  }
}

/** The German text for one Zod issue. Never empty, never Zod's English default. */
export function germanZodMessage(issue: ZodIssueLike): string {
  // A missing value reaches several codes (invalid_type, invalid_value for an enum, …): it is
  // always a required field that was not sent.
  if (
    "input" in issue &&
    issue.input === undefined &&
    issue.code !== "unrecognized_keys" &&
    issue.code !== "custom"
  ) {
    return "Pflichtfeld.";
  }
  switch (issue.code) {
    case "invalid_type":
      if (issue.input === undefined) return "Pflichtfeld.";
      if (issue.input === null) return "Dieses Feld darf nicht leer sein.";
      return expectedKind(issue.expected);
    case "too_small":
      return sizeText(issue, true);
    case "too_big":
      return sizeText(issue, false);
    case "invalid_format":
      return formatText(issue.format);
    case "not_multiple_of":
      return `Der Wert muss ein Vielfaches von ${num(issue.divisor)} sein.`;
    case "invalid_value":
      return "Bitte wähle einen gültigen Wert.";
    case "unrecognized_keys":
      return issue.keys && issue.keys.length > 1 ? "Unbekannte Felder." : "Unbekanntes Feld.";
    case "invalid_union":
    case "invalid_key":
    case "invalid_element":
    case "custom":
    default:
      return GENERIC_INVALID;
  }
}

/**
 * German labels of the most common request fields, keyed by the LAST path segment. Only used to
 * name a field in the human summary; an unlisted field is simply not named.
 */
export const FIELD_LABELS: Readonly<Record<string, string>> = {
  email: "E-Mail",
  password: "Passwort",
  firstName: "Vorname",
  lastName: "Nachname",
  employeeNumber: "Personalnummer",
  hireDate: "Eintrittsdatum",
  exitDate: "Austrittsdatum",
  birthDate: "Geburtsdatum",
  role: "Rolle",
  name: "Name",
  date: "Datum",
  startDate: "Von",
  endDate: "Bis",
  from: "Von",
  to: "Bis",
  startTime: "Beginn",
  endTime: "Ende",
  validFrom: "Gültig ab",
  effectiveFrom: "Gültig ab",
  weeklyHours: "Wochenstunden",
  monthlyHours: "Monatsstunden",
  scheduleType: "Arbeitszeitmodell",
  workDays: "Arbeitstage",
  salonId: "Salon",
  homeSalonId: "Stammsalon",
  employeeId: "Mitarbeiter",
  reason: "Begründung",
  note: "Notiz",
  type: "Art",
  year: "Jahr",
  month: "Monat",
  days: "Tage",
  defaultDays: "Tage",
  totalDays: "Urlaubstage",
  federalState: "Bundesland",
};

export interface ValidationIssue {
  path: PropertyKey[];
  message: string;
}

/** The human summary of a failed validation: German labels and texts only, no field keys. */
export function validationSummary(issues: readonly ValidationIssue[]): string {
  const parts: string[] = [];
  for (const issue of issues) {
    const last = [...issue.path].reverse().find((p) => typeof p === "string") as string | undefined;
    const label = last ? FIELD_LABELS[last] : undefined;
    // A schema's own message often names its field already ("Begründung ist erforderlich"):
    // then the label would only repeat it.
    const named = label !== undefined && issue.message.toLowerCase().includes(label.toLowerCase());
    const text = label && !named ? `${label}: ${issue.message}` : issue.message;
    if (!parts.includes(text)) parts.push(text);
  }
  return parts.length > 0 ? parts.join("; ") : GENERIC_INVALID;
}

let registered = false;

/** Registers the German map as Zod's global error map (idempotent). */
export function registerGermanZodErrors(): void {
  if (registered) return;
  z.config({ customError: (issue) => germanZodMessage(issue as ZodIssueLike) });
  registered = true;
}
