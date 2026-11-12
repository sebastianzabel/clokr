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
const EXPORT_REQUIRES: PermissionAlternatives = [[Z("report:export")]];
const AUDIT_REQUIRES: PermissionAlternatives = [[Z("audit-log:read")]];
const PHOREST_REQUIRES: PermissionAlternatives = [[Z("integration:manage")]];

const SYSTEM_PAGE = "routes/(app)/admin/system/+page.svelte";
const VACATION_PAGE = "routes/(app)/admin/vacation/+page.svelte";

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
const FROM_SYSTEM = {
  page: ARBEITSZEIT_PAGE,
  source: "/admin/system",
  requires: SYSTEM_REQUIRES,
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
    id: "system-shift-hours",
    title: "Schichtprüfung gegen Öffnungszeiten",
    endpoint: "/settings/work",
    keys: ["shiftStoreHoursMode"],
  },
  {
    ...SYSTEM,
    id: "system-features",
    title: "Features",
    endpoint: "/settings/work",
    keys: ["availabilityEnabled", "vocationalSchoolAutoCleanupShifts", "defaultWorkDays"],
  },
  {
    ...SYSTEM,
    id: "system-breaks",
    title: "Monatsabschluss bei unbestätigten Pausen",
    endpoint: "/settings/work",
    keys: ["blockMonthCloseOnUnconfirmedBreak"],
  },
  {
    ...SYSTEM,
    id: "system-core-hours",
    title: "Kernarbeitszeit-Defaults (Gleitzeit)",
    endpoint: "/settings/work",
    keys: ["defaultCoreStart", "defaultCoreEnd", "defaultCoreDays"],
  },
  {
    ...SYSTEM,
    id: "system-close-month-gaps",
    title: "Monatsabschluss mit Lücken",
    endpoint: "/settings/work",
    keys: ["closeMonthWithGapsAllowed"],
  },
  {
    ...SYSTEM,
    id: "system-retro-window",
    title: "Rückwirkende Einträge",
    endpoint: "/settings/work",
    keys: ["retroEntryWindowDays"],
  },
  {
    ...SYSTEM,
    id: "system-bs-slots",
    title: "Berufsschule — Zeitgutschrift",
    endpoint: "/settings/work",
    keys: [
      "bsSlotFirstLongDayMinutes",
      "bsSlotSecondLongDayMinutes",
      "bsSlotShortDayMinutes",
      "bsSlotBlockWeekMinutes",
    ],
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
  {
    ...SYSTEM,
    id: "system-email-notifications",
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
    dynamicPayload: true,
  },
  {
    ...SYSTEM,
    id: "system-smtp",
    title: "E-Mail / SMTP",
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
  },
  // Management sections: lists with their own endpoints, no configuration keys.
  { ...SYSTEM, id: "system-terminals", title: "NFC-Terminals", endpoint: null, keys: [] },
  { ...SYSTEM, id: "system-api-keys", title: "API Keys", endpoint: null, keys: [] },

  // ── /admin/vacation ────────────────────────────────────────────────────────────────────────────
  // One page-wide save today (`saveGlobal`, one button); the bulk-apply body keys ride in the same PUT. The
  // page plans split it into sections of their own, one section per save.
  {
    id: "vacation-global",
    page: "/verwalten/regeln/urlaub",
    title: "Standards und Regeln",
    endpoint: "/settings/work",
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
      "carryOverDeadlineDay",
      "carryOverDeadlineMonth",
      "defaultVacationDays",
      "defaultApprenticeVacationDays",
      "arbzgEnabled",
      "applyToExisting",
      "applyEmployeeIds",
      "previewFingerprint",
      "effectiveFrom",
      "clockOutReminderHours",
      "missingEntriesDays",
      "autoDeleteOpenHours",
      "christmasEveRule",
      "newYearsEveRule",
      "holidayRulesValidFromYear",
      "vacationLeadTimeDays",
      "vacationMaxAdvanceMonths",
      "halfDayAllowed",
      "leavePlanDeadlineLocksWishes",
      "sickSelfReport",
      "sickNoteRequiredAfterDays",
      "autoCalcPartTimeVacation",
      "fullTimeWorkDaysPerWeek",
      "enforceMinVacation",
      "carryOverRequiresReason",
      "vacationReminderStartMonth",
      "carryoverWarningEnabled",
      "carryoverWarningThresholds",
      "reminderPendingLeaveHours",
      "reminderUpcomingAbsenceDays",
      "reminderPendingLeaveEnabled",
      "reminderUpcomingAbsenceEnabled",
      "reminderShiftStartEnabled",
      "reminderShiftEndEnabled",
      "reminderDayCloseEnabled",
      "reminderOffsetMinutes",
      "reminderDayCloseTime",
    ],
    source: "/admin/vacation",
    requires: VACATION_REQUIRES,
    renderedBy: VACATION_PAGE,
  },
  {
    // The second request of `saveGlobal`, on the security endpoint.
    id: "vacation-max-negative",
    page: "/verwalten/regeln/urlaub",
    title: "Negativer Überstundensaldo",
    endpoint: "/settings/security",
    keys: ["maxNegativeBalanceMinutes"],
    source: "/admin/vacation",
    requires: VACATION_REQUIRES,
    renderedBy: VACATION_PAGE,
  },
  {
    id: "vacation-special-leave",
    page: "/verwalten/regeln/urlaub",
    title: "Sonderurlaubs-Regeln",
    endpoint: null,
    keys: [],
    // The pre-#854 page /admin/special-leave redirects here (alias with `to`); it carries the same gate.
    source: "/admin/special-leave",
    requires: VACATION_REQUIRES,
    renderedBy: VACATION_PAGE,
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
