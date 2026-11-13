// Issue #854 (D-854-03) - the pure half of Verwalten › Regeln › Benachrichtigungen & E-Mail: how each section
// reads its values from the settings endpoints, which messages its fields show and what its save puts on the
// wire. No runes and no `$app` imports on purpose; the section components
// (`lib/components/admin/benachrichtigungen/`) own the form state and the request.
//
// The server stays the authority for every rule (the Zod schemas of `PUT /settings/smtp`, `/security` and
// `/work`); the checks here only save a round trip and mirror the bounds the pages always showed.

import { messageCount, type FieldMessages } from "$lib/settings/arbeitszeit";

export { messageCount };

// ── E-Mail-Server (SMTP) ─────────────────────────────────────────────────────────────────────────

/** `GET /settings/smtp`. The password is never part of the answer, only whether one is stored. */
export interface SmtpConfig {
  smtpHost?: string | null;
  smtpPort?: number | null;
  smtpUser?: string | null;
  smtpPasswordSet?: boolean;
  smtpFromEmail?: string | null;
  smtpFromName?: string | null;
  smtpSecure?: boolean;
  /** The server's answer whether mail can be sent at all (Issue #847); read-only, never written back. */
  deliveryReady?: boolean;
}

export const DEFAULT_SMTP_PORT = 587;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type SmtpValues = {
  smtpHost: string;
  /** Null while the field is empty. */
  smtpPort: number | null;
  smtpUser: string;
  /** Write-only: always "" after a load or a save, filled only by typing. */
  smtpPassword: string;
  smtpFromEmail: string;
  smtpFromName: string;
  smtpSecure: boolean;
};
export type SmtpField = keyof SmtpValues;

export function smtpFrom(config: SmtpConfig): SmtpValues {
  return {
    smtpHost: config.smtpHost ?? "",
    smtpPort: config.smtpPort ?? DEFAULT_SMTP_PORT,
    smtpUser: config.smtpUser ?? "",
    smtpPassword: "",
    smtpFromEmail: config.smtpFromEmail ?? "",
    smtpFromName: config.smtpFromName ?? "",
    smtpSecure: config.smtpSecure ?? false,
  };
}

export function smtpMessages(values: SmtpValues): FieldMessages<SmtpField> {
  const messages: FieldMessages<SmtpField> = {};
  if (values.smtpHost.trim() === "") messages.smtpHost = "Gib den Servernamen ein.";
  const port = values.smtpPort;
  if (port === null || !Number.isInteger(port) || port < 1 || port > 65535) {
    messages.smtpPort = "Gib einen Port zwischen 1 und 65535 ein.";
  }
  if (values.smtpUser.trim() === "") messages.smtpUser = "Gib den Benutzernamen ein.";
  if (!EMAIL_SHAPE.test(values.smtpFromEmail.trim())) {
    messages.smtpFromEmail = "Gib eine gültige Absenderadresse ein.";
  }
  if (values.smtpFromName.trim() === "") messages.smtpFromName = "Gib den Absendernamen ein.";
  return messages;
}

/**
 * The body of the SMTP save, for `pickSection`. The password is sent ONLY when it was typed (the server
 * keeps the stored one otherwise); an empty field never overwrites it. Callers validate first
 * (`smtpMessages`).
 */
export function smtpWire(values: SmtpValues): Partial<Record<SmtpField, unknown>> {
  return {
    smtpHost: values.smtpHost.trim(),
    smtpPort: values.smtpPort,
    smtpUser: values.smtpUser.trim(),
    ...(values.smtpPassword !== "" ? { smtpPassword: values.smtpPassword } : {}),
    smtpFromEmail: values.smtpFromEmail.trim(),
    smtpFromName: values.smtpFromName.trim(),
    smtpSecure: values.smtpSecure,
  };
}

// ── E-Mail-Benachrichtigungen ────────────────────────────────────────────────────────────────────

export const EMAIL_TYPE_FIELDS = [
  "emailOnLeaveRequest",
  "emailOnLeaveDecision",
  "emailOnOvertimeWarning",
  "emailOnMissingEntries",
  "emailOnClockOutReminder",
  "emailOnMonthClose",
  "emailOnRetroEntry",
] as const;

export type EmailTypeField = (typeof EMAIL_TYPE_FIELDS)[number];
export type EmailField = "emailNotificationsEnabled" | EmailTypeField;

/** The labels of the notification types (display only; the keys are the control values). */
export const EMAIL_TYPE_LABELS: Record<EmailTypeField, string> = {
  emailOnLeaveRequest: "Neuer Urlaubsantrag",
  emailOnLeaveDecision: "Urlaub genehmigt / abgelehnt",
  emailOnOvertimeWarning: "Überstunden-Warnung",
  emailOnMissingEntries: "Fehlende Zeiteinträge",
  emailOnClockOutReminder: "Vergessene Stempelung",
  emailOnMonthClose: "Monatsabschluss",
  emailOnRetroEntry: "Zeitnachtrag",
};

/** The part of `GET /settings/security` the notification section reads. */
export type SecurityEmailConfig = Partial<Record<EmailField, boolean>>;

export type EmailValues = Record<EmailField, boolean>;

/** The stored values; the defaults match the API's (`DEFAULT_SECURITY_SETTINGS`). */
export function emailFrom(config: SecurityEmailConfig): EmailValues {
  return {
    emailNotificationsEnabled: config.emailNotificationsEnabled ?? false,
    emailOnLeaveRequest: config.emailOnLeaveRequest ?? true,
    emailOnLeaveDecision: config.emailOnLeaveDecision ?? true,
    emailOnOvertimeWarning: config.emailOnOvertimeWarning ?? false,
    emailOnMissingEntries: config.emailOnMissingEntries ?? false,
    emailOnClockOutReminder: config.emailOnClockOutReminder ?? false,
    emailOnMonthClose: config.emailOnMonthClose ?? true,
    emailOnRetroEntry: config.emailOnRetroEntry ?? true,
  };
}

export function emailWire(values: EmailValues): EmailValues {
  return { ...values };
}

// ── Erinnerungen ─────────────────────────────────────────────────────────────────────────────────

export const CLOCK_OUT_HOURS_MIN = 1;
export const CLOCK_OUT_HOURS_MAX = 48;
export const MISSING_DAYS_MIN = 1;
export const MISSING_DAYS_MAX = 90;
export const PENDING_LEAVE_HOURS_MIN = 1;
export const PENDING_LEAVE_HOURS_MAX = 720;
export const UPCOMING_ABSENCE_DAYS_MIN = 1;
export const UPCOMING_ABSENCE_DAYS_MAX = 30;

export const DEFAULT_CLOCK_OUT_HOURS = 10;
export const DEFAULT_MISSING_DAYS = 7;
export const DEFAULT_PENDING_LEAVE_HOURS = 48;
export const DEFAULT_UPCOMING_ABSENCE_DAYS = 3;

/** The part of `GET /settings/work` the reminder section reads. */
export interface ReminderConfig {
  clockOutReminderHours?: number;
  missingEntriesDays?: number;
  reminderPendingLeaveEnabled?: boolean;
  reminderPendingLeaveHours?: number;
  reminderUpcomingAbsenceEnabled?: boolean;
  reminderUpcomingAbsenceDays?: number;
}

export type ReminderValues = {
  /** Hours / days; null while the field is empty. */
  clockOutReminderHours: number | null;
  missingEntriesDays: number | null;
  reminderPendingLeaveEnabled: boolean;
  reminderPendingLeaveHours: number | null;
  reminderUpcomingAbsenceEnabled: boolean;
  reminderUpcomingAbsenceDays: number | null;
};
export type ReminderField = keyof ReminderValues;

export function remindersFrom(config: ReminderConfig): ReminderValues {
  return {
    clockOutReminderHours: config.clockOutReminderHours ?? DEFAULT_CLOCK_OUT_HOURS,
    missingEntriesDays: config.missingEntriesDays ?? DEFAULT_MISSING_DAYS,
    reminderPendingLeaveEnabled: config.reminderPendingLeaveEnabled ?? true,
    reminderPendingLeaveHours: config.reminderPendingLeaveHours ?? DEFAULT_PENDING_LEAVE_HOURS,
    reminderUpcomingAbsenceEnabled: config.reminderUpcomingAbsenceEnabled ?? true,
    reminderUpcomingAbsenceDays:
      config.reminderUpcomingAbsenceDays ?? DEFAULT_UPCOMING_ABSENCE_DAYS,
  };
}

function outsideRange(value: number | null, min: number, max: number): boolean {
  return value === null || !Number.isFinite(value) || value < min || value > max;
}

/**
 * The messages of the reminder fields. A threshold that belongs to a switched-off reminder is not shown
 * and therefore not checked (the save then sends its default, see `remindersWire`).
 */
export function remindersMessages(values: ReminderValues): FieldMessages<ReminderField> {
  const messages: FieldMessages<ReminderField> = {};
  if (outsideRange(values.clockOutReminderHours, CLOCK_OUT_HOURS_MIN, CLOCK_OUT_HOURS_MAX)) {
    messages.clockOutReminderHours = `Gib einen Wert zwischen ${CLOCK_OUT_HOURS_MIN} und ${CLOCK_OUT_HOURS_MAX} Stunden ein.`;
  }
  if (outsideRange(values.missingEntriesDays, MISSING_DAYS_MIN, MISSING_DAYS_MAX)) {
    messages.missingEntriesDays = `Gib einen Wert zwischen ${MISSING_DAYS_MIN} und ${MISSING_DAYS_MAX} Tagen ein.`;
  }
  if (
    values.reminderPendingLeaveEnabled &&
    outsideRange(values.reminderPendingLeaveHours, PENDING_LEAVE_HOURS_MIN, PENDING_LEAVE_HOURS_MAX)
  ) {
    messages.reminderPendingLeaveHours = `Gib einen Wert zwischen ${PENDING_LEAVE_HOURS_MIN} und ${PENDING_LEAVE_HOURS_MAX} Stunden ein.`;
  }
  if (
    values.reminderUpcomingAbsenceEnabled &&
    outsideRange(
      values.reminderUpcomingAbsenceDays,
      UPCOMING_ABSENCE_DAYS_MIN,
      UPCOMING_ABSENCE_DAYS_MAX,
    )
  ) {
    messages.reminderUpcomingAbsenceDays = `Gib einen Wert zwischen ${UPCOMING_ABSENCE_DAYS_MIN} und ${UPCOMING_ABSENCE_DAYS_MAX} Tagen ein.`;
  }
  return messages;
}

function wholeOr(value: number | null, min: number, max: number, fallback: number): number {
  return outsideRange(value, min, max) ? fallback : Math.trunc(value as number);
}

/**
 * The body of the reminder save, for `pickSection`. Whole numbers only; the API fields are `.optional()`,
 * never `.nullable()`, so an emptied threshold of a switched-off reminder falls back to its default instead
 * of sending null. Callers validate first (`remindersMessages`).
 */
export function remindersWire(values: ReminderValues): Record<ReminderField, unknown> {
  return {
    clockOutReminderHours: wholeOr(
      values.clockOutReminderHours,
      CLOCK_OUT_HOURS_MIN,
      CLOCK_OUT_HOURS_MAX,
      DEFAULT_CLOCK_OUT_HOURS,
    ),
    missingEntriesDays: wholeOr(
      values.missingEntriesDays,
      MISSING_DAYS_MIN,
      MISSING_DAYS_MAX,
      DEFAULT_MISSING_DAYS,
    ),
    reminderPendingLeaveEnabled: values.reminderPendingLeaveEnabled,
    reminderPendingLeaveHours: wholeOr(
      values.reminderPendingLeaveHours,
      PENDING_LEAVE_HOURS_MIN,
      PENDING_LEAVE_HOURS_MAX,
      DEFAULT_PENDING_LEAVE_HOURS,
    ),
    reminderUpcomingAbsenceEnabled: values.reminderUpcomingAbsenceEnabled,
    reminderUpcomingAbsenceDays: wholeOr(
      values.reminderUpcomingAbsenceDays,
      UPCOMING_ABSENCE_DAYS_MIN,
      UPCOMING_ABSENCE_DAYS_MAX,
      DEFAULT_UPCOMING_ABSENCE_DAYS,
    ),
  };
}
