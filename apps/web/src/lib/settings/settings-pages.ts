/**
 * Issue #854 (D-854-03) — the settings registry: every writable tenant setting belongs to exactly ONE section of
 * exactly ONE page. A section names the page it is shown on, the endpoint that saves it, the keys it sends, the
 * pre-#844 page it came from and the permission alternatives that open it.
 *
 * It holds the CURRENT placement (the pre-#854 pages `/admin/system`, `/admin/vacation`, `/admin/export`,
 * `/admin/audit`, `/admin/phorest`). Moving a setting to another page is an edit of this file plus markup; the
 * page plans do that one section at a time. `settings-pages-854.test.ts` reads this file and the sources and fails
 * on a key in two places, a key the API schema of its endpoint would strip (the `vocationalSchoolAutoCleanupShifts`
 * bug of D-854-20), a save that sends a foreign field, and a page gate that is wider or narrower than the union of
 * its sections (D-854-05: nobody loses access to a setting, nobody gains access to one).
 *
 * Permissions: a section keeps the alternatives of the page it came from (`requires`); a page that receives
 * sections from several old pages opens under the union of them (`pageAlternatives`). The API's 403 stays the
 * authority — this is a UX gate like the route table.
 */
import { holdsAlternatives, type PermissionAlternatives } from "$lib/nav/routes";
import type { PermissionHolder } from "$lib/permissions";

/** The endpoints that write tenant settings (the whole surface, research §2a). `null` = a management section
 *  that has no configuration keys of its own (lists and dialogs with their own endpoints). */
export type SettingsEndpoint =
  "/settings/work" | "/settings/security" | "/settings/smtp" | "/integrations/phorest/config";

export interface SettingsSection {
  /** Stable id (`<page>-<topic>`), referenced by `settingsSection(id)` and `pickSection`. */
  id: string;
  /** Route-table href of the page that shows the section. */
  page: string;
  /** Section heading, German, sentence case (D-854-15). */
  title: string;
  /** The endpoint that saves the section, or null for a management section without config keys. */
  endpoint: SettingsEndpoint | null;
  /** Every key the section's save sends. A key lives in exactly one section of the whole registry. */
  keys: readonly string[];
  /** The pre-#854 route file the section came from; its pinned pre-844 alternatives are `requires`. */
  source: string;
  /** Permission alternatives that open the section (= those of `source`, D-854-05). */
  requires: PermissionAlternatives;
  /** Path below `apps/web/src` of the file that sends the section's PUT (the route page or a component it imports). */
  renderedBy: string;
  /** The save builds its body with a computed key (`{ [flag]: next }`); the scan then checks the section's keys
   *  against the file instead of an object literal. */
  dynamicPayload?: true;
}

const Z = (resourceAction: string) => `${resourceAction}:ZUGEWIESEN`;

// The pinned pre-844 alternatives of each source page (apps/web/src/lib/nav/__tests__/fixtures/pre-844-route-permissions.json);
// the order matches the route table so `pageAlternatives` equals a route's `requires`.
const SYSTEM_REQUIRES: PermissionAlternatives = [
  [Z("tenant-settings:read")],
  [Z("tenant-settings:update")],
  [Z("terminal:manage")],
  [Z("api-key:manage")],
];
const VACATION_REQUIRES: PermissionAlternatives = [
  [Z("tenant-settings:update")],
  [Z("leave-config:manage")],
];
const SHUTDOWN_REQUIRES: PermissionAlternatives = [[Z("company-shutdown:manage")]];
// The leave-limit routes decide per handler (leave-limit:manage or leave-request:approve), see the pre-844 pin.
const LEAVE_LIMITS_REQUIRES: PermissionAlternatives = [
  [Z("leave-limit:manage")],
  [Z("leave-request:approve")],
];
const EXPORT_REQUIRES: PermissionAlternatives = [[Z("report:export")]];
const AUDIT_REQUIRES: PermissionAlternatives = [[Z("audit-log:read")]];
const PHOREST_REQUIRES: PermissionAlternatives = [[Z("integration:manage")]];
const SHIFTS_REQUIRES: PermissionAlternatives = [
  [Z("shift-config:manage"), Z("shift:read"), Z("shift-pattern:read")],
];

const SYSTEM_PAGE = "routes/(app)/admin/system/+page.svelte";

const SYSTEM = {
  page: "/verwalten/system/allgemein",
  source: "/admin/system",
  requires: SYSTEM_REQUIRES,
  renderedBy: SYSTEM_PAGE,
} as const;

// Plan 854-07: the working-time defaults of the System and Urlaub pages live on Regeln › Arbeitszeit &
// Verträge. A moved section keeps `source` and `requires` of the page it came from (D-854-05) and names
// the component that renders and saves it.
const ARBEITSZEIT_PAGE = "/verwalten/regeln/arbeitszeit";
const ARBEITSZEIT_DIR = "lib/components/admin/arbeitszeit";
const FROM_VACATION = {
  page: ARBEITSZEIT_PAGE,
  source: "/admin/vacation",
  requires: VACATION_REQUIRES,
} as const;
const FROM_SYSTEM = {
  page: ARBEITSZEIT_PAGE,
  source: "/admin/system",
  requires: SYSTEM_REQUIRES,
} as const;

// Plan 854-08: the closing settings of the System page live on Regeln › Monatsabschluss (the settings, not
// the close workflow of Verwalten › Monatsabschluss).
const MONATSABSCHLUSS_PAGE = "/verwalten/regeln/monatsabschluss";
const MONATSABSCHLUSS_DIR = "lib/components/admin/monatsabschluss";
const MONATSABSCHLUSS_FROM_SYSTEM = {
  page: MONATSABSCHLUSS_PAGE,
  source: "/admin/system",
  requires: SYSTEM_REQUIRES,
} as const;

// Plan 854-08: mail server, e-mail switches (System) and reminders (Urlaub) live on Regeln › Benachrichtigungen
// & E-Mail; each section keeps the alternatives of the page it came from.
const BENACHRICHTIGUNGEN_PAGE = "/verwalten/regeln/benachrichtigungen";
const BENACHRICHTIGUNGEN_DIR = "lib/components/admin/benachrichtigungen";

// Plan 854-09: the shift configuration of /admin/shifts lives on Regeln › Dienstplan as three management
// panels (lists with their own endpoints, no configuration keys); plan 854-10 adds the settings of System and
// Urlaub (opening-hours binding, availability, Berufsschul clean-up, shift reminders) as the „Einstellungen“ tab;
// the System „Features“ section is gone.
const DIENSTPLAN_PAGE = "/verwalten/regeln/dienstplan";
const DIENSTPLAN_DIR = "lib/components/admin/dienstplan";
const FROM_SHIFTS = {
  page: DIENSTPLAN_PAGE,
  source: "/admin/shifts",
  requires: SHIFTS_REQUIRES,
} as const;
const DIENSTPLAN_FROM_SYSTEM = {
  page: DIENSTPLAN_PAGE,
  source: "/admin/system",
  requires: SYSTEM_REQUIRES,
} as const;
const DIENSTPLAN_FROM_VACATION = {
  page: DIENSTPLAN_PAGE,
  source: "/admin/vacation",
  requires: VACATION_REQUIRES,
} as const;

// Plan 854-11: the vacation page itself, rewritten in place as Regeln › Abwesenheiten (route file /admin/vacation).
const ABWESENHEITEN_PAGE = "/verwalten/regeln/abwesenheiten";
const ABWESENHEITEN_DIR = "lib/components/admin/abwesenheiten";
const ABWESENHEITEN = {
  page: ABWESENHEITEN_PAGE,
  source: "/admin/vacation",
  requires: VACATION_REQUIRES,
} as const;

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  // ── Regeln › Arbeitszeit & Verträge ────────────────────────────────────────────────────────────
  {
    ...FROM_SYSTEM,
    id: "arbeitszeit-pausen",
    title: "Pausen",
    endpoint: "/settings/work",
    keys: [
      "autoBreakEnabled",
      "defaultBreakStart",
      "defaultBreakOver6h",
      "defaultBreakOver9h",
      "enforceBreakConfirmation",
    ],
    renderedBy: `${ARBEITSZEIT_DIR}/BreaksSection.svelte`,
  },
  {
    ...FROM_SYSTEM,
    id: "arbeitszeit-rueckwirkend",
    title: "Rückwirkende Einträge",
    endpoint: "/settings/work",
    keys: ["retroEntryWindowDays"],
    renderedBy: `${ARBEITSZEIT_DIR}/RetroWindowSection.svelte`,
  },
  {
    ...FROM_SYSTEM,
    id: "arbeitszeit-arbeitstage",
    title: "Arbeitstage",
    endpoint: "/settings/work",
    keys: ["defaultWorkDays"],
    renderedBy: `${ARBEITSZEIT_DIR}/WorkDaysSection.svelte`,
  },
  {
    ...FROM_SYSTEM,
    id: "arbeitszeit-gleitzeit",
    title: "Gleitzeit",
    endpoint: "/settings/work",
    keys: ["defaultCoreStart", "defaultCoreEnd", "defaultCoreDays"],
    renderedBy: `${ARBEITSZEIT_DIR}/CoreHoursSection.svelte`,
  },
  {
    ...FROM_SYSTEM,
    id: "arbeitszeit-berufsschule",
    title: "Berufsschule",
    endpoint: "/settings/work",
    keys: [
      "bsSlotFirstLongDayMinutes",
      "bsSlotSecondLongDayMinutes",
      "bsSlotShortDayMinutes",
      "bsSlotBlockWeekMinutes",
    ],
    renderedBy: `${ARBEITSZEIT_DIR}/VocationalSlotsSection.svelte`,
  },
  {
    ...FROM_VACATION,
    id: "arbeitszeit-standard",
    title: "Standard-Arbeitszeit",
    endpoint: "/settings/work",
    // The last four ride along only for a confirmed bulk apply (Issue #568): the server's own selection.
    keys: [
      "defaultWeeklyHours",
      "defaultMondayHours",
      "defaultTuesdayHours",
      "defaultWednesdayHours",
      "defaultThursdayHours",
      "defaultFridayHours",
      "defaultSaturdayHours",
      "defaultSundayHours",
      "overtimeThreshold",
      "allowOvertimePayout",
      "applyToExisting",
      "applyEmployeeIds",
      "previewFingerprint",
      "effectiveFrom",
    ],
    renderedBy: `${ARBEITSZEIT_DIR}/DefaultHoursSection.svelte`,
  },
  {
    ...FROM_VACATION,
    id: "arbeitszeit-ueberstunden",
    title: "Überstunden",
    endpoint: "/settings/security",
    keys: ["maxNegativeBalanceMinutes"],
    renderedBy: `${ARBEITSZEIT_DIR}/MaxNegativeSection.svelte`,
  },
  {
    ...FROM_VACATION,
    id: "arbeitszeit-compliance",
    title: "ArbZG-Prüfung",
    endpoint: "/settings/work",
    keys: ["arbzgEnabled"],
    renderedBy: `${ARBEITSZEIT_DIR}/ComplianceSection.svelte`,
  },
  {
    ...FROM_VACATION,
    id: "arbeitszeit-offene-eintraege",
    title: "Offene Einträge",
    endpoint: "/settings/work",
    keys: ["autoDeleteOpenHours"],
    renderedBy: `${ARBEITSZEIT_DIR}/OpenEntriesSection.svelte`,
  },

  // ── Regeln › Monatsabschluss ───────────────────────────────────────────────────────────────────
  {
    ...MONATSABSCHLUSS_FROM_SYSTEM,
    id: "monatsabschluss-luecken",
    title: "Monatsabschluss mit Lücken",
    endpoint: "/settings/work",
    keys: ["closeMonthWithGapsAllowed"],
    renderedBy: `${MONATSABSCHLUSS_DIR}/GapsSection.svelte`,
  },
  {
    ...MONATSABSCHLUSS_FROM_SYSTEM,
    id: "monatsabschluss-pausen",
    title: "Offene Pausenbefunde",
    endpoint: "/settings/work",
    keys: ["blockMonthCloseOnUnconfirmedBreak"],
    renderedBy: `${MONATSABSCHLUSS_DIR}/BreakBlockSection.svelte`,
  },

  // ── Regeln › Benachrichtigungen & E-Mail ───────────────────────────────────────────────────────
  {
    page: BENACHRICHTIGUNGEN_PAGE,
    source: "/admin/system",
    requires: SYSTEM_REQUIRES,
    id: "benachrichtigungen-smtp",
    title: "E-Mail-Server",
    endpoint: "/settings/smtp",
    keys: [
      "smtpHost",
      "smtpPort",
      "smtpUser",
      "smtpPassword",
      "smtpFromEmail",
      "smtpFromName",
      "smtpSecure",
    ],
    renderedBy: `${BENACHRICHTIGUNGEN_DIR}/SmtpSection.svelte`,
  },
  {
    page: BENACHRICHTIGUNGEN_PAGE,
    source: "/admin/system",
    requires: SYSTEM_REQUIRES,
    id: "benachrichtigungen-email",
    title: "E-Mail-Benachrichtigungen",
    endpoint: "/settings/security",
    keys: [
      "emailNotificationsEnabled",
      "emailOnLeaveRequest",
      "emailOnLeaveDecision",
      "emailOnOvertimeWarning",
      "emailOnMissingEntries",
      "emailOnClockOutReminder",
      "emailOnMonthClose",
      "emailOnRetroEntry",
    ],
    renderedBy: `${BENACHRICHTIGUNGEN_DIR}/EmailSection.svelte`,
  },
  {
    page: BENACHRICHTIGUNGEN_PAGE,
    source: "/admin/vacation",
    requires: VACATION_REQUIRES,
    id: "benachrichtigungen-erinnerungen",
    title: "Erinnerungen",
    endpoint: "/settings/work",
    keys: [
      "clockOutReminderHours",
      "missingEntriesDays",
      "reminderPendingLeaveEnabled",
      "reminderPendingLeaveHours",
      "reminderUpcomingAbsenceEnabled",
      "reminderUpcomingAbsenceDays",
    ],
    renderedBy: `${BENACHRICHTIGUNGEN_DIR}/RemindersSection.svelte`,
  },

  // ── Regeln › Dienstplan ────────────────────────────────────────────────────────────────────────
  // The three panels are management sections (lists with their own endpoints, no configuration keys); the
  // four settings sections of the „Einstellungen“ tab came from System and Urlaub (plan 854-10). The order
  // below is the order of the page's union gate (`pageAlternatives`).
  {
    ...FROM_SHIFTS,
    id: "dienstplan-vorlagen",
    title: "Schichtvorlagen",
    endpoint: null,
    keys: [],
    renderedBy: `${DIENSTPLAN_DIR}/ShiftTemplatesPanel.svelte`,
  },
  {
    ...FROM_SHIFTS,
    id: "dienstplan-bedarf",
    title: "Bedarfsregeln",
    endpoint: null,
    keys: [],
    renderedBy: `${DIENSTPLAN_DIR}/CoverageRulesPanel.svelte`,
  },
  {
    ...FROM_SHIFTS,
    id: "dienstplan-muster",
    title: "Wochenmuster",
    endpoint: null,
    keys: [],
    renderedBy: `${DIENSTPLAN_DIR}/WeekPatternsPanel.svelte`,
  },
  {
    ...DIENSTPLAN_FROM_SYSTEM,
    id: "dienstplan-oeffnungszeiten",
    title: "Schichten und Öffnungszeiten",
    endpoint: "/settings/work",
    keys: ["shiftStoreHoursMode"],
    renderedBy: `${DIENSTPLAN_DIR}/DienstplanSettingsPanel.svelte`,
  },
  {
    ...DIENSTPLAN_FROM_SYSTEM,
    id: "dienstplan-verfuegbarkeit",
    title: "Verfügbarkeiten",
    endpoint: "/settings/work",
    keys: ["availabilityEnabled"],
    renderedBy: `${DIENSTPLAN_DIR}/DienstplanSettingsPanel.svelte`,
  },
  {
    ...DIENSTPLAN_FROM_SYSTEM,
    id: "dienstplan-berufsschule",
    title: "Berufsschule und Schichten",
    endpoint: "/settings/work",
    keys: ["vocationalSchoolAutoCleanupShifts"],
    renderedBy: `${DIENSTPLAN_DIR}/DienstplanSettingsPanel.svelte`,
  },
  {
    ...DIENSTPLAN_FROM_VACATION,
    id: "dienstplan-erinnerungen",
    title: "Schicht-Erinnerungen",
    endpoint: "/settings/work",
    keys: [
      "reminderShiftStartEnabled",
      "reminderShiftEndEnabled",
      "reminderDayCloseEnabled",
      "reminderOffsetMinutes",
      "reminderDayCloseTime",
    ],
    renderedBy: `${DIENSTPLAN_DIR}/DienstplanSettingsPanel.svelte`,
  },

  // ── /admin/system ──────────────────────────────────────────────────────────────────────────────
  {
    ...SYSTEM,
    id: "system-company",
    title: "Unternehmen & Region",
    endpoint: "/settings/work",
    keys: ["tenantName", "federalState", "timezone"],
  },
  {
    ...SYSTEM,
    id: "system-two-fa",
    title: "Sicherheit",
    endpoint: "/settings/security",
    keys: ["twoFaEnabled"],
  },
  {
    ...SYSTEM,
    id: "system-session",
    title: "Session-Management",
    endpoint: "/settings/security",
    keys: [
      "sessionTimeoutMinutes",
      "refreshTokenDays",
      "rememberMeEnabled",
      "rememberMeDays",
      "maxSessionsPerUser",
      "loginMaxAttempts",
      "loginLockoutMinutes",
    ],
  },
  {
    ...SYSTEM,
    id: "system-password",
    title: "Passwort-Richtlinie",
    endpoint: "/settings/security",
    keys: [
      "passwordMinLength",
      "passwordRequireUpper",
      "passwordRequireLower",
      "passwordRequireDigit",
      "passwordRequireSpecial",
    ],
  },
  // Management sections: lists with their own endpoints, no configuration keys.
  { ...SYSTEM, id: "system-terminals", title: "NFC-Terminals", endpoint: null, keys: [] },
  { ...SYSTEM, id: "system-api-keys", title: "API Keys", endpoint: null, keys: [] },

  // ── Regeln › Abwesenheiten ─────────────────────────────────────────────────────────────────────
  // The vacation, sick-leave, holiday-rule and carry-over settings of the former Urlaubsverwaltung, one section
  // per concern (plan 854-11; its page-wide save is gone). Betriebsurlaub and Urlaubsgrenzen joined the page in
  // plans 854-12 and 854-13. The working-time defaults, ArbZG, open entries and the negative-balance limit left
  // the old page for Regeln › Arbeitszeit & Verträge (plan 854-07), the reminders for Benachrichtigungen and
  // Dienstplan (plan 854-08, 854-10).
  {
    ...ABWESENHEITEN,
    id: "abwesenheiten-anspruch",
    title: "Urlaubsanspruch",
    endpoint: "/settings/work",
    keys: [
      "defaultVacationDays",
      "defaultApprenticeVacationDays",
      "autoCalcPartTimeVacation",
      "fullTimeWorkDaysPerWeek",
      "enforceMinVacation",
    ],
    renderedBy: `${ABWESENHEITEN_DIR}/UrlaubPanel.svelte`,
  },
  {
    ...ABWESENHEITEN,
    id: "abwesenheiten-antraege",
    title: "Urlaubsanträge",
    endpoint: "/settings/work",
    keys: [
      "vacationLeadTimeDays",
      "vacationMaxAdvanceMonths",
      "halfDayAllowed",
      "leavePlanDeadlineLocksWishes",
    ],
    renderedBy: `${ABWESENHEITEN_DIR}/UrlaubPanel.svelte`,
  },
  {
    ...ABWESENHEITEN,
    id: "abwesenheiten-krankheit",
    title: "Krankmeldung",
    endpoint: "/settings/work",
    keys: ["sickSelfReport", "sickNoteRequiredAfterDays"],
    renderedBy: `${ABWESENHEITEN_DIR}/UrlaubPanel.svelte`,
  },
  {
    ...ABWESENHEITEN,
    id: "abwesenheiten-feiertage",
    title: "Heiligabend und Silvester",
    endpoint: "/settings/work",
    keys: ["christmasEveRule", "newYearsEveRule", "holidayRulesValidFromYear"],
    renderedBy: `${ABWESENHEITEN_DIR}/UrlaubPanel.svelte`,
  },
  {
    ...ABWESENHEITEN,
    id: "abwesenheiten-uebertrag",
    title: "Übertrag ins neue Jahr",
    endpoint: "/settings/work",
    keys: ["carryOverDeadlineDay", "carryOverDeadlineMonth", "carryOverRequiresReason"],
    renderedBy: `${ABWESENHEITEN_DIR}/UebertragPanel.svelte`,
  },
  {
    ...ABWESENHEITEN,
    id: "abwesenheiten-verfallswarnung",
    title: "Warnung vor Verfall",
    endpoint: "/settings/work",
    // `vacationReminderStartMonth` is the month the reminders about expiring leave start (EuGH C-684/16).
    keys: ["vacationReminderStartMonth", "carryoverWarningEnabled", "carryoverWarningThresholds"],
    renderedBy: `${ABWESENHEITEN_DIR}/UebertragPanel.svelte`,
  },
  {
    ...ABWESENHEITEN,
    id: "abwesenheiten-sonderurlaub",
    title: "Sonderurlaubs-Regeln",
    endpoint: null,
    keys: [],
    // The pre-#854 page /admin/special-leave redirects here (alias with `to`); it carries the same gate.
    source: "/admin/special-leave",
    renderedBy: `${ABWESENHEITEN_DIR}/SonderurlaubPanel.svelte`,
  },

  // Plan 854-12: the company shutdowns of the former /admin/shutdowns list, a tab of the Abwesenheiten page. The
  // list acts at once (create in a Dialog, delete behind a confirmation); a shutdown's detail is a sub-route.
  {
    page: ABWESENHEITEN_PAGE,
    id: "abwesenheiten-betriebsurlaub",
    title: "Betriebsurlaub",
    endpoint: null,
    keys: [],
    source: "/admin/shutdowns",
    requires: SHUTDOWN_REQUIRES,
    renderedBy: `${ABWESENHEITEN_DIR}/BetriebsurlaubPanel.svelte`,
  },

  // Plan 854-13: the leave limits and blackouts (#836) of the former /admin/leave-limits page, the last tab of the
  // Abwesenheiten page. Rules are created and edited in a Dialog and act at once; a removed rule stays traceable.
  {
    page: ABWESENHEITEN_PAGE,
    id: "abwesenheiten-urlaubsgrenzen",
    title: "Urlaubsgrenzen & Sperren",
    endpoint: null,
    keys: [],
    source: "/admin/leave-limits",
    requires: LEAVE_LIMITS_REQUIRES,
    renderedBy: `${ABWESENHEITEN_DIR}/UrlaubsgrenzenPanel.svelte`,
  },

  // ── /admin/export ──────────────────────────────────────────────────────────────────────────────
  {
    id: "export-datev",
    page: "/verwalten/daten/datev",
    title: "DATEV-Nummern",
    endpoint: "/settings/work",
    keys: [
      "datevNormalstundenNr",
      "datevUrlaubNr",
      "datevKrankNr",
      "datevSonderurlaubNr",
      "datevBeraterNr",
      "datevMandantenNr",
    ],
    source: "/admin/export",
    requires: EXPORT_REQUIRES,
    renderedBy: "routes/(app)/admin/export/+page.svelte",
  },

  // ── /admin/audit ───────────────────────────────────────────────────────────────────────────────
  {
    id: "audit-retention",
    page: "/verwalten/daten/protokoll",
    title: "Aufbewahrung",
    endpoint: "/settings/work",
    keys: ["dataRetentionYears"],
    source: "/admin/audit",
    requires: AUDIT_REQUIRES,
    renderedBy: "routes/(app)/admin/audit/+page.svelte",
  },

  // ── /admin/phorest ─────────────────────────────────────────────────────────────────────────────
  {
    id: "phorest-config",
    page: "/verwalten/system/phorest",
    title: "Verbindung und Import",
    endpoint: "/integrations/phorest/config",
    // `branchId` is sent only while exactly one salon is active (Issue #65, D-20).
    keys: [
      "phorestBusinessId",
      "phorestUsername",
      "phorestPassword",
      "phorestAutoSync",
      "phorestSyncCron",
      "phorestSyncWindowDays",
      "phorestPrepMinutes",
      "phorestWrapupMinutes",
      "branchId",
    ],
    source: "/admin/phorest",
    requires: PHOREST_REQUIRES,
    renderedBy: "routes/(app)/admin/phorest/+page.svelte",
  },
];

/** The section with `id`; throws on an unknown id so a typo fails loudly instead of selecting nothing. */
export function settingsSection(id: string): SettingsSection {
  const section = SETTINGS_SECTIONS.find((entry) => entry.id === id);
  if (section === undefined) throw new Error(`Unknown settings section: ${id}`);
  return section;
}

/** The sections shown on the page `href` (route-table href), in registry order. */
export function sectionsOfPage(href: string): SettingsSection[] {
  return SETTINGS_SECTIONS.filter((section) => section.page === href);
}

/** The permission alternatives a page opens under: the union of its sections' alternatives (D-854-05),
 *  deduplicated, in registry order. Empty for a page without sections. */
export function pageAlternatives(href: string): PermissionAlternatives {
  const seen = new Set<string>();
  const union: (readonly string[])[] = [];
  for (const section of sectionsOfPage(href)) {
    for (const alternative of section.requires) {
      const key = [...alternative].sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      union.push(alternative);
    }
  }
  return union;
}

/** May `user` open the section? Holding one of the section's own alternatives is enough, so a page that
 *  merges sections of several old pages never shows a person a section they could not open before. */
export function mayOpenSection(
  user: PermissionHolder | null | undefined,
  section: SettingsSection,
): boolean {
  return holdsAlternatives(user, section.requires);
}
