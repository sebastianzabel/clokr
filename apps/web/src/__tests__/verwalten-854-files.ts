// Test helper (not a `*.test.ts`) - the walkers and the migration list of the Verwalten pages (Issue
// #854, D-854-28). It only lists files; every guard that uses it states its own non-empty floor and
// carries a positive control.
//
// MIGRATED_854 is the single piece of migration state: a page plan appends the files it rebuilt, and
// `verwalten-pages-blocks-854.test.ts` (AC-1) and `section-titles-854.test.ts` (D-854-15) then
// enforce them. The ratchet register `lint-ui-classes-route-ratchet.json` only ever falls.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { APP_ROUTES } from "$lib/nav/routes";

import { SRC_ROOT, walkFiles } from "./design-source-files";

/**
 * Files rebuilt on the blocks of #843, paths relative to `apps/web/src/`. The three hub pages render
 * `HubPage` (a #844 block-only page) and were clean from the start.
 */
export const MIGRATED_854: readonly string[] = [
  "routes/(app)/verwalten/regeln/+page.svelte",
  "routes/(app)/verwalten/daten/+page.svelte",
  "routes/(app)/verwalten/system/+page.svelte",
  // Plan 854-02 (the Salons tracer): list, detail and the three panels of the detail.
  "routes/(app)/admin/salons/+page.svelte",
  "routes/(app)/admin/salons/[id]/+page.svelte",
  "lib/components/admin/OpeningHoursEditor.svelte",
  "lib/components/admin/SalonHolidays.svelte",
  "lib/components/admin/salons/SalonMasterDataForm.svelte",
  // Plan 854-07 (Regeln › Arbeitszeit & Verträge): the native page, its section frame and sections.
  "routes/(app)/verwalten/regeln/arbeitszeit/+page.svelte",
  "lib/components/admin/settings/SettingsGroup.svelte",
  "lib/components/admin/settings/ToggleField.svelte",
  "lib/components/admin/settings/WeekdayPicker.svelte",
  "lib/components/admin/arbeitszeit/BreaksSection.svelte",
  "lib/components/admin/arbeitszeit/RetroWindowSection.svelte",
  "lib/components/admin/arbeitszeit/WorkDaysSection.svelte",
  "lib/components/admin/arbeitszeit/CoreHoursSection.svelte",
  "lib/components/admin/arbeitszeit/VocationalSlotsSection.svelte",
  "lib/components/admin/arbeitszeit/DefaultHoursSection.svelte",
  "lib/components/admin/arbeitszeit/MaxNegativeSection.svelte",
  "lib/components/admin/arbeitszeit/ComplianceSection.svelte",
  "lib/components/admin/arbeitszeit/OpenEntriesSection.svelte",
  // First adopted by the Arbeitszeit page (plan 854-07): the bulk apply preview of Issue #568.
  "lib/components/admin/BulkApplyDialog.svelte",
  // Plan 854-08 (Regeln › Monatsabschluss): the native page and its two sections.
  "routes/(app)/verwalten/regeln/monatsabschluss/+page.svelte",
  "lib/components/admin/monatsabschluss/GapsSection.svelte",
  "lib/components/admin/monatsabschluss/BreakBlockSection.svelte",
  // Plan 854-08 (Regeln › Benachrichtigungen & E-Mail): the native page and its three sections.
  "routes/(app)/verwalten/regeln/benachrichtigungen/+page.svelte",
  "lib/components/admin/benachrichtigungen/SmtpSection.svelte",
  "lib/components/admin/benachrichtigungen/EmailSection.svelte",
  "lib/components/admin/benachrichtigungen/RemindersSection.svelte",
  // Plan 854-09 (Regeln › Dienstplan): the rebuilt page shell and its three panels.
  "routes/(app)/admin/shifts/+page.svelte",
  "lib/components/admin/dienstplan/ShiftTemplatesPanel.svelte",
  "lib/components/admin/dienstplan/CoverageRulesPanel.svelte",
  "lib/components/admin/dienstplan/WeekPatternsPanel.svelte",
  "lib/components/admin/dienstplan/DienstplanSettingsPanel.svelte",
  // Plan 854-11 (Regeln › Abwesenheiten, part I): the rebuilt vacation page and its three panels.
  "routes/(app)/admin/vacation/+page.svelte",
  "lib/components/admin/abwesenheiten/UrlaubPanel.svelte",
  "lib/components/admin/abwesenheiten/UebertragPanel.svelte",
  "lib/components/admin/abwesenheiten/SonderurlaubPanel.svelte",
  // Plan 854-12 (Regeln › Abwesenheiten, part II): the Betriebsurlaub tab.
  "lib/components/admin/abwesenheiten/BetriebsurlaubPanel.svelte",
  // Plan 854-13 (Regeln › Abwesenheiten, part III): the Urlaubsgrenzen & Sperren tab.
  "lib/components/admin/abwesenheiten/UrlaubsgrenzenPanel.svelte",
  "routes/(app)/admin/shutdowns/[id]/+page.svelte",
  // Plan 854-14 (System › Integrationen): the rebuilt page shell, its three panels and what they use.
  "routes/(app)/admin/integrations/+page.svelte",
  "lib/components/admin/integrationen/PresenceSourcesPanel.svelte",
  "lib/components/admin/integrationen/TerminalsPanel.svelte",
  "lib/components/admin/integrationen/ApiKeysPanel.svelte",
  "lib/components/admin/integrationen/OneTimeKey.svelte",
  "lib/components/admin/PairingGuide.svelte",
  "lib/components/admin/TerminalSalonCell.svelte",
  "lib/components/admin/ModuleHint.svelte",
  // Plan 854-15 (System › Allgemein): the rewritten System page and its four sections.
  "routes/(app)/admin/system/+page.svelte",
  "lib/components/admin/allgemein/CompanySection.svelte",
  "lib/components/admin/allgemein/TwoFactorSection.svelte",
  "lib/components/admin/allgemein/PasswordSection.svelte",
  "lib/components/admin/allgemein/SessionSection.svelte",
  // Plan 854-16 (System › Phorest): the rebuilt page shell and its two panels.
  "routes/(app)/admin/phorest/+page.svelte",
  "lib/components/admin/phorest/PhorestConnectionPanel.svelte",
  "lib/components/admin/phorest/PhorestSyncPanel.svelte",
  // Plan 854-16 (System › Branding & Themes): the rebuilt page.
  "routes/(app)/admin/themes/+page.svelte",
  // Plan 854-17 (System › Rollen & Rechte): the rebuilt page shell, both tabs, the editor, the assignment
  // dialog and the shared role-assignment block (the person tab and the create flow consume it).
  "routes/(app)/admin/roles/+page.svelte",
  "lib/components/admin/roles/RolesTab.svelte",
  "lib/components/admin/roles/RoleEditor.svelte",
  "lib/components/admin/roles/AssignmentsTab.svelte",
  "lib/components/admin/roles/AssignmentDialog.svelte",
  "lib/components/admin/roles/PersonRoleAssignments.svelte",
  // Plan 854-19 (Personen list): the page (selection and bulk changes came with plan 854-18, the old
  // create Modal went with this plan), the guided create dialog, the bulk role dialog and the Stammsalon field.
  "routes/(app)/admin/employees/+page.svelte",
  "lib/components/employees/CreatePersonDialog.svelte",
  "lib/components/employees/BulkRoleDialog.svelte",
  "lib/components/employees/HomeSalonField.svelte",
  // Plan 854-20 (Person detail, part I): the Person, Urlaub and Zugang tabs and the Salons section.
  "lib/components/employees/detail/PersonTab.svelte",
  "lib/components/employees/detail/UrlaubTab.svelte",
  "lib/components/employees/detail/ZugangTab.svelte",
  "lib/components/employees/SalonAssignmentsSection.svelte",
  // Plan 854-21 (Person detail, part II): the contract half of the Vertrag tab.
  "lib/components/employees/detail/VertragTab.svelte",
  // Plan 854-22 (Person detail, part III): the per-person override groups of the Vertrag tab.
  "lib/components/employees/detail/VertragOverrides.svelte",
  "lib/components/employees/detail/BerufsschuleSection.svelte",
  // The detail page itself: a shell over the five tab components, free of every legacy shell.
  "routes/(app)/admin/employees/[id]/+page.svelte",
  // Plan 854-23 (Daten › Protokoll): the list page with its filters and CSV export, and the retention section.
  "routes/(app)/admin/audit/+page.svelte",
  "routes/(app)/admin/audit/[id]/+page.svelte",
  "lib/components/admin/protokoll/RetentionSection.svelte",
  // Plan 854-24 (Daten › Export): the one page that starts the DATEV export, plus CSV, PDF, iCal, history, setup.
  "routes/(app)/admin/export/+page.svelte",
  // Plan 854-25 (Daten › CSV-Import, Support-Zugriffe): the import operation page, then the two support-access pages.
  "routes/(app)/admin/import/+page.svelte",
  "routes/(app)/admin/support-access/+page.svelte",
  "routes/(app)/admin/support-access/[id]/+page.svelte",
  "lib/components/admin/SupportAccessList.svelte",
  "lib/components/admin/SupportAccessDetail.svelte",
  // Plan 854-26 (Monatsabschluss): the close workflow page, its stepper and the months/persons tables.
  "routes/(app)/admin/month-close/+page.svelte",
  "lib/components/admin/monatsabschluss/CloseStepper.svelte",
  "lib/components/admin/monatsabschluss/MonthStatusTable.svelte",
  // The Zugang tab opens it (deactivation with a last working day); it renders Dialog directly.
  "lib/components/admin/DeactivateEmployeeDialog.svelte",
  // Plan 854-27 (Berichte I): the page shell with PageTabs over period-state and the period KPI strips.
  "routes/(app)/reports/+page.svelte",
  "lib/components/reports/PeriodKpis.svelte",
  // Plan 854-27 (Berichte I): the period bar (PeriodPicker), the range dialog and the Heute tab.
  "lib/components/reports/PeriodBar.svelte",
  "lib/components/reports/PeriodRangeDialog.svelte",
  "lib/components/reports/TodayAttendance.svelte",
  // Export dialog of Berichte: Dialog + List, no DATEV download (links to Daten > Export).
  "lib/components/reports/ExportDialog.svelte",
];

export interface VerwaltenFile {
  /** Path relative to `src/`, POSIX separators. */
  rel: string;
  /** Route key (`file ?? href`) for a route file; the file name below its root for a component. */
  key: string;
  text: string;
  /** True for the page file of a route-table entry (it carries the page head), false for detail sub-routes. */
  tableEntry: boolean;
}

/** The pages #853 owns although they sit below a Verwalten table entry's file directory. */
const OWNED_ELSEWHERE = ["routes/(app)/admin/availability/"];

/** The Verwalten Übersicht is #847, not a page of this phase. */
const OVERVIEW = "routes/(app)/verwalten/+page.svelte";

/** Same rule as `lint-ui.mjs` `isRedirectStub`: no template, only an `onMount(() => goto(` script. */
const REDIRECT_STUB_RE = /onMount\(\s*\(\s*\)\s*=>\s*goto\(/;
export function isRedirectStub(text: string): boolean {
  const template = text.replace(/<script[\s\S]*?<\/script>/g, "").trim();
  return template === "" && REDIRECT_STUB_RE.test(text);
}

function pageFilesBelow(dirRel: string): string[] {
  const dir = join(SRC_ROOT, dirRel);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter((f) => f === "+page.svelte" || f.endsWith("/+page.svelte"))
    .map((f) => `${dirRel}/${f}`.split("\\").join("/"));
}

/**
 * Every `+page.svelte` that renders a Verwalten URL: the file of each table entry of area `verwalten`
 * (not the Übersicht, not an `internal` page), every detail sub-route below such a directory, and
 * every page below `routes/(app)/verwalten/`. Redirect stubs and the pages #853 owns are skipped.
 */
export function verwaltenRouteFiles(): VerwaltenFile[] {
  const seen = new Map<string, VerwaltenFile>();
  const add = (rel: string, key: string, tableEntry: boolean) => {
    if (seen.has(rel) || rel === OVERVIEW) return;
    if (OWNED_ELSEWHERE.some((prefix) => rel.startsWith(prefix))) return;
    const abs = join(SRC_ROOT, rel);
    if (!existsSync(abs)) return;
    const text = readFileSync(abs, "utf8");
    if (isRedirectStub(text)) return;
    seen.set(rel, { rel, key, text, tableEntry });
  };

  for (const route of APP_ROUTES) {
    if (route.area !== "verwalten" || route.href === "/verwalten" || route.internal) continue;
    const key = route.file ?? route.href;
    const dirRel = `routes/(app)${key}`;
    add(`${dirRel}/+page.svelte`, key, true);
    for (const rel of pageFilesBelow(dirRel)) add(rel, rel, false);
  }
  for (const rel of pageFilesBelow("routes/(app)/verwalten")) add(rel, rel, false);
  return [...seen.values()].sort((a, b) => a.rel.localeCompare(b.rel));
}

/** The legacy shells that stay for the operator console and #853: migrated files must not import them. */
export const LEGACY_SHELLS = [
  "admin/Section.svelte",
  "admin/SectionStack.svelte",
  "admin/ListDetail.svelte",
  "admin/ToolPage.svelte",
] as const;

const COMPONENT_ROOTS = ["admin", "employees", "reports"] as const;

/** Every `.svelte` component below the three Verwalten component directories (tests and the shells excluded). */
export function verwaltenComponentFiles(): VerwaltenFile[] {
  const out: VerwaltenFile[] = [];
  for (const root of COMPONENT_ROOTS) {
    const dir = join(SRC_ROOT, "lib/components", root);
    if (!existsSync(dir)) continue;
    for (const f of walkFiles(dir, [".svelte"], { includeTests: false })) {
      if ((LEGACY_SHELLS as readonly string[]).includes(`${root}/${f.rel}`)) continue;
      out.push({
        rel: `lib/components/${root}/${f.rel}`,
        key: `${root}/${f.rel}`,
        text: f.text,
        tableEntry: false,
      });
    }
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}
