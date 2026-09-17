/**
 * Phase 113b (D-03/D-16/D-17) — the file -> context-area assignment that AC1's "Abdeckung je
 * Kontextbereich" is aggregated over.
 *
 * WHAT THIS IS: every file `apps/api/vitest.config.ts` measures coverage for is assigned to
 * exactly one of seven named buckets — the four business contexts, the shared Unterbau
 * substrate, the composition layer, and framework/bootstrap infrastructure ("rahmen"). This
 * module is the SOLE source of that assignment; `scripts/measure-context-coverage.ts`
 * (plan 113B-02) aggregates `coverage/coverage-summary.json`'s per-file numbers through it.
 *
 * WHERE THE ASSIGNMENT COMES FROM: GitHub issue #99's "Modellzuordnung (41 Modelle)" table —
 * which Prisma model(s) a file actually queries, mapped through that table. Filename matching is
 * explicitly NOT evidence (113B-CONTEXT.md D-05) — every mapping below was derived by grepping
 * the file's own `prisma.<model>`/`tx.<model>` call sites, not by guessing from the file name.
 * Where a file touches models from several contexts, the entry's trailing comment records which
 * model it WRITES (the primary subject) or, for pure-helper files with no direct model access,
 * which context's vocabulary/importers it belongs to.
 *
 * `rahmen` IS AN ENUMERATED ALLOWLIST, NEVER A FALLTHROUGH. It exists only for genuine
 * framework/bootstrap/test-infrastructure files (`app.ts`, `config.ts`, `middleware/auth.ts`,
 * generic no-model utilities like `crypto.ts`/`with-advisory-lock.ts`, and the test-infra modules
 * under `src/__tests__/`). Per #99 ("keine Restkategorie") NO file under `src/routes/` or
 * `src/plugins/` may be `rahmen` — every route and plugin belongs to a real context, Unterbau, or
 * the composition layer. `komposition` is likewise narrow: `routes/dashboard.ts` and
 * `routes/reports.ts` (D-17, unconditional — they own no model and carry no Fachregel) plus
 * `utils/pdf.ts`, whose only caller is `reports.ts` and which contains pure PDF-layout rendering
 * of already-computed data — no Fachregel of its own.
 *
 * `services/clock/**` and `services/phorest/**` get the ONLY two prefix rules (D-16) — every file
 * under them ALSO has an explicit `CONTEXT_AREA_BY_FILE` entry today (so the exhaustiveness count
 * reflects the full measured set), but the prefix rule is what keeps a FUTURE new file under
 * either directory from silently falling through to `UnmappedFileError` before this map is
 * updated.
 *
 * A new file under `apps/api/src/` that does not match `CONTEXT_AREA_BY_FILE` and does not sit
 * under one of the two prefixes above turns `scripts/__tests__/context-area-map.test.ts` red —
 * add it here (or, if it's within `services/clock/`/`services/phorest/`, it is caught
 * automatically).
 */

import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** The seven buckets of the coverage baseline. Order is the table's display order. */
export type ContextArea =
  | "unterbau"
  | "zeiterfassung"
  | "abwesenheiten"
  | "schichtplanung"
  | "arbeitszeitkonto"
  | "rahmen"
  | "komposition";

export const CONTEXT_AREAS: readonly ContextArea[] = [
  "unterbau",
  "zeiterfassung",
  "abwesenheiten",
  "schichtplanung",
  "arbeitszeitkonto",
  "rahmen",
  "komposition",
];

/** The ONLY prefix rules allowed (D-16). Everything else is per-file. */
export const CONTEXT_AREA_BY_PREFIX: readonly { prefix: string; area: ContextArea }[] = [
  { prefix: "src/services/clock/", area: "zeiterfassung" },
  { prefix: "src/services/phorest/", area: "schichtplanung" },
];

/**
 * Explicit per-file assignment. Keys are POSIX paths relative to `apps/api`.
 *
 * Grouped by bucket, then roughly by directory, for reviewability — `assignContextArea` does not
 * care about the grouping, only about the flattened key/value pairs.
 */
export const CONTEXT_AREA_BY_FILE: Readonly<Record<string, ContextArea>> = {
  // ── rahmen — framework/bootstrap/test-infrastructure, enumerated, never a fallthrough ──────
  "src/app.ts": "rahmen",
  "src/config.ts": "rahmen",
  "src/middleware/auth.ts": "rahmen",
  "src/utils/test-database.ts": "rahmen", // sole source of the test-DB name pattern/marker/worker-count (CLAUDE.md) — test infra, not a business context
  "src/utils/with-advisory-lock.ts": "rahmen", // generic Postgres advisory-lock helper; imported by 8 plugins + integrations.ts across every context, owns no model
  "src/utils/crypto.ts": "rahmen", // generic crypto helper (hashing/encryption), no model, no single owning context
  "src/utils/release-notes.ts": "rahmen", // bakes docs/release-notes/*.md into the image at build time; app-wide, tenant-agnostic, no model
  "src/__tests__/setup.ts": "rahmen", // full-suite fixture seeding across every model; test infra
  "src/__tests__/test-dates.ts": "rahmen", // test-only date helpers, no model

  // ── komposition — D-17: dashboard.ts/reports.ts unconditionally, plus pdf.ts (no model, no
  //    Fachregel, reports.ts's only caller) ─────────────────────────────────────────────────
  "src/composition/dashboard.ts": "komposition", // 11 models read across contexts by design (D-17)
  "src/composition/reports.ts": "komposition", // 7 models read across contexts by design (D-17)
  "src/composition/pdf.ts": "komposition", // pure PDF-layout rendering of pre-computed data; sole caller is reports.ts; no Prisma access, no Fachregel

  // ── unterbau — Tenant/TenantConfig/User/RefreshToken/OtpToken/Invitation/Employee/
  //    WorkSchedule/PublicHoliday/SchoolHolidayPeriod/AuditLog/ApiKey/Notification ────────────
  "src/contexts/platform/api/activity.ts": "unterbau", // dashboard "Aktivität" widget backend; ADMIN scope is a direct AuditLog read, EMPLOYEE/MANAGER scope assembles the same kind of chronological trail from timeEntry/leaveRequest/saldoSnapshot — AuditLog's own domain generalised to the other event sources, not eligible for komposition (D-17 names only dashboard.ts/reports.ts)
  "src/contexts/platform/api/api-keys.ts": "unterbau", // writes ApiKey only
  "src/contexts/platform/api/audit-logs.ts": "unterbau", // reads AuditLog only
  "src/contexts/platform/api/auth.ts": "unterbau", // writes OtpToken/RefreshToken/User
  "src/contexts/platform/api/avatars.ts": "unterbau", // writes Employee.avatarUrl only
  "src/contexts/platform/api/employees.ts": "unterbau", // writes Employee/User primarily; the tx.* deletes of Absence/Break/LeaveEntitlement/LeaveRequest/OvertimeAccount/TimeEntry/WorkSchedule are cascade cleanup ON employee delete, not this file's primary subject
  "src/contexts/platform/api/holidays.ts": "unterbau", // writes PublicHoliday only
  "src/contexts/platform/api/imports.ts": "unterbau", // primarily bulk employee onboarding (creates Employee/User/WorkSchedule/OvertimeAccount, all Unterbau except the Arbeitszeitkonto side-effect); the /time-entries import endpoint reuses routes/time-entries.ts's own validateTimeEntryInvariants/updateOvertimeAccount helpers rather than duplicating TimeEntry write rules
  "src/contexts/platform/api/invitations.ts": "unterbau", // writes Invitation/User
  "src/contexts/platform/api/me.ts": "unterbau", // writes User only
  "src/contexts/platform/api/notifications.ts": "unterbau", // writes Notification only
  "src/contexts/platform/api/release-notes.ts": "unterbau", // app-wide, tenant-agnostic feature with no model; under src/routes/ so cannot be rahmen (#99: no route may be a fallthrough) — Unterbau is the closest fit as the shared, context-agnostic substrate
  "src/contexts/platform/api/settings.ts": "unterbau", // writes WorkSchedule/TenantConfig primarily (PUT /settings/work); tx.shift.deleteMany is a side effect of a schedule change, not the primary subject; LeaveEntitlement upsert is a bulk-apply side effect
  "src/contexts/platform/api/test-bootstrap.ts": "unterbau", // full-tenant dataset reset for e2e bootstrapping; under src/routes/ so cannot be rahmen despite being test-only — Tenant is the root model a full-tenant reset operates against, no single business context owns it
  "src/contexts/platform/api/admin/school-holidays.ts": "unterbau", // reads/writes SchoolHolidayPeriod (Unterbau model, matches the file name directly)
  "src/contexts/platform/plugins/audit.ts": "unterbau", // writes AuditLog — its own Unterbau model
  "src/contexts/platform/plugins/data-retention.ts": "unterbau", // annual DSGVO/legal retention job driven by TenantConfig.dataRetentionYears (Unterbau model); touches TimeEntry/LeaveRequest/Absence with equal weight (3 separate updateMany, no single primary subject) plus an AuditLog purge in the same file (unambiguously Unterbau) — no single business context owns a generic cross-context retention policy
  "src/contexts/platform/plugins/mailer.ts": "unterbau", // SMTP transport keyed off TenantConfig, no other model
  "src/contexts/platform/plugins/notify.ts": "unterbau", // writes Notification — its own Unterbau model
  "src/contexts/platform/plugins/prisma.ts": "unterbau", // decorates app.prisma; no model of its own, pure infra — under src/plugins/ so cannot be rahmen (#99: no plugin may be a fallthrough); Unterbau is the shared substrate every context sits on
  "src/contexts/platform/plugins/school-holidays-sync.ts": "unterbau", // writes SchoolHolidayPeriod
  "src/contexts/platform/plugins/storage.ts": "unterbau", // decorates app.storage (MinIO); no model, pure infra — same reasoning as prisma.ts
  "src/contexts/platform/plugins/token-cleanup.ts": "unterbau", // deletes stale OtpToken/RefreshToken
  "src/contexts/platform/facade/employee-scope.ts": "unterbau", // EmployeeScope discriminated union + employeeScopeWhere() (Phase 100B Plan 04, D-10) — Employee is Unterbau's own model; no Prisma call in this file
  "src/contexts/platform/anonymize.ts": "unterbau", // DSGVO Art. 17 anonymization; primary subject is Employee+User (CLAUDE.md "DSGVO Employee Deletion"), other models' notes/documents nulled as side effects
  "src/contexts/platform/audit-reason.ts": "unterbau", // shared "Begründung ist erforderlich" validation reused across every correction/storno field app-wide; audit-trail vocabulary, no model
  "src/contexts/platform/calculate-work-days.ts": "unterbau", // normalizes WorkSchedule.workDays — Unterbau's own model
  "src/contexts/platform/federal-state-iso.ts": "unterbau", // FederalState enum <-> ISO-3166-2, feeds PublicHoliday lookups (Unterbau model)
  "src/contexts/platform/holidays.ts": "unterbau", // German public-holiday calculation — PublicHoliday is Unterbau's own model
  "src/contexts/platform/month-first-date.ts": "unterbau", // WorkSchedule.validFrom month-1 rule — Unterbau's own model
  "src/contexts/platform/notification-email-policy.ts": "unterbau", // per-type email-toggle registry for Notification — Unterbau's own model
  "src/contexts/platform/password-policy.ts": "unterbau", // User/auth password rules
  "src/contexts/platform/school-holidays-client.ts": "unterbau", // fetches SchoolHolidayPeriod data from the external OpenHolidays/schulferien-api

  // ── zeiterfassung — TimeEntry/Break/RetroEntryRequest/TerminalApiKey/PresenceSource/
  //    PresenceDevice, plus services/clock/** (D-16 prefix rule) ─────────────────────────────
  "src/contexts/time-tracking/facade/time-entries.ts": "zeiterfassung", // Phase 100B Plan 08 — T1-T12, TimeEntry/Break's only external access path
  "src/contexts/time-tracking/facade/presence-devices.ts": "zeiterfassung", // Phase 100B Plan 09 (Wave 4, closing) — PresenceDevice's only external access path
  "src/contexts/time-tracking/api/admin-presence-sources.ts": "zeiterfassung", // writes PresenceDevice/PresenceSource
  "src/contexts/time-tracking/api/presence.ts": "zeiterfassung", // WiFi-presence-based clocking; reads PresenceDevice/PresenceSource, writes AuditLog as a side effect
  "src/contexts/time-tracking/api/retro-entry-requests.ts": "zeiterfassung", // writes RetroEntryRequest/TimeEntry
  "src/contexts/time-tracking/api/terminals.ts": "zeiterfassung", // writes TerminalApiKey
  "src/contexts/time-tracking/api/time-entries.ts": "zeiterfassung", // writes TimeEntry/Break primarily; overtimeAccount.upsert is the live-path saldo recompute side effect
  "src/contexts/time-tracking/plugins/attendance-checker.ts": "zeiterfassung", // 6 of 9 cron Features (1/2/3/7/8/9) are TimeEntry/Break watchdogs and its only DB write is timeEntry.update; Features 4/5/6 (leave reminders) are the minority
  "src/services/clock/audit-actor.ts": "zeiterfassung", // D-16 prefix rule (services/clock/**)
  "src/services/clock/consolidate.ts": "zeiterfassung", // D-16 prefix rule (services/clock/**)
  "src/services/clock/resolver.ts": "zeiterfassung", // D-16 prefix rule (services/clock/**)
  "src/services/clock/state-machine.ts": "zeiterfassung", // D-16 prefix rule (services/clock/**)
  "src/services/clock/types.ts": "zeiterfassung", // D-16 prefix rule (services/clock/**)
  "src/contexts/time-tracking/arbzg.ts": "zeiterfassung", // ArbZG §3/§4/§5 compliance checks over TimeEntry
  "src/contexts/time-tracking/break-constants.ts": "zeiterfassung", // Break-model constants
  "src/contexts/time-tracking/break-effective.ts": "zeiterfassung", // effective break-minutes calculation
  "src/contexts/time-tracking/find-unconfirmed-break-days.ts": "zeiterfassung", // AUTO/CONFIRMED/WAIVED break-status query over TimeEntry
  "src/contexts/time-tracking/invalid-reason.ts": "zeiterfassung", // TimeEntry.invalidReason string registry; 4 of 6 importers are Zeiterfassung
  "src/contexts/time-tracking/normalize-mac.ts": "zeiterfassung", // PresenceDevice MAC-address normalization
  "src/contexts/time-tracking/presence.ts": "zeiterfassung", // WiFi-presence detection helper feeding routes/presence.ts and the missing-entries gap detector
  "src/contexts/time-tracking/retro-config.ts": "zeiterfassung", // RetroEntryRequest tenant-config toggle

  // ── abwesenheiten — LeaveRequest/LeaveType/LeaveEntitlement/SpecialLeaveRule/Section9Credit/
  //    Absence/EmployeeVocationalSchoolPattern/CompanyShutdown/CompanyShutdownException ───────
  "src/contexts/absence/facade/leave-types.ts": "abwesenheiten", // Phase 100B Plan 10 (Wave 5) — LeaveType's only external access path
  "src/contexts/absence/facade/entitlements.ts": "abwesenheiten", // Phase 100B Plan 10 (Wave 5) — LeaveEntitlement's only external access path
  "src/contexts/absence/facade/vocational-school-patterns.ts": "abwesenheiten", // Phase 100B Plan 11 (Wave 5) — EmployeeVocationalSchoolPattern's only external access path
  "src/contexts/absence/facade/section9-credits.ts": "abwesenheiten", // Phase 100B Plan 11 (Wave 5) — Section9Credit's only external access path
  "src/contexts/absence/facade/absences.ts": "abwesenheiten", // Phase 100B Plan 12 (Wave 5, closing model) — Absence's only external access path
  "src/contexts/absence/api/company-shutdowns.ts": "abwesenheiten", // writes CompanyShutdown/CompanyShutdownException
  "src/contexts/absence/api/leave.ts": "abwesenheiten", // writes LeaveEntitlement/LeaveRequest/LeaveType/Section9Credit primarily; overtimeAccount/overtimeTransaction/timeEntry/shift writes are documented cross-context side effects of leave approval/cancellation
  "src/contexts/absence/api/section9-documents.ts": "abwesenheiten", // writes Section9Credit
  "src/contexts/absence/api/special-leave.ts": "abwesenheiten", // writes SpecialLeaveRule
  "src/contexts/absence/api/vocational-school-pattern.ts": "abwesenheiten", // writes EmployeeVocationalSchoolPattern
  "src/contexts/absence/api/vocational-school.ts": "abwesenheiten", // writes Absence
  "src/contexts/absence/plugins/carryover-warning.ts": "abwesenheiten", // BUrlG carry-over expiry reminders over LeaveEntitlement
  "src/contexts/absence/plugins/vocational-school-generator.ts": "abwesenheiten", // cron wrapper around utils/vocational-school-generator.ts's Absence generation
  "src/contexts/absence/bs-slot-resolver.ts": "abwesenheiten", // Berufsschule (VOCATIONAL_SCHOOL Absence) time-slot resolution
  "src/contexts/absence/correction-lock.ts": "abwesenheiten", // Phase 94 manager LeaveRequest correction guard
  "src/contexts/absence/find-karenz-overrun-days.ts": "abwesenheiten", // §5 EFZG Karenztage over LeaveRequest
  "src/contexts/absence/format-hm.ts": "abwesenheiten", // hours:minutes display formatting; sole importer is routes/leave.ts
  "src/contexts/absence/ical.ts": "abwesenheiten", // iCal export; sole importer is routes/leave.ts
  "src/contexts/absence/illness-carryover-guard.ts": "abwesenheiten", // sickness/Krankheit carry-over guard over LeaveRequest
  "src/contexts/absence/jarbschg.ts": "abwesenheiten", // JArbSchG youth-protection rules over Absence/EmployeeVocationalSchoolPattern
  "src/contexts/absence/leave-check.ts": "abwesenheiten", // Absence/LeaveRequest overlap checks
  "src/contexts/absence/leave-self-heal.ts": "abwesenheiten", // LeaveEntitlement/LeaveRequest/LeaveType self-heal
  "src/contexts/absence/leave-type.ts": "abwesenheiten", // LeaveTypeCode -> German display-name registry
  "src/contexts/absence/load-bs-slot-overrides.ts": "abwesenheiten", // EmployeeVocationalSchoolPattern slot overrides
  "src/contexts/absence/section9-credit-days.ts": "abwesenheiten", // Section9Credit day counting
  "src/contexts/absence/section9-detect.ts": "abwesenheiten", // § 9 BUrlG "krank im Urlaub" detection
  "src/contexts/absence/shift-leave-recalc-resolver.ts": "abwesenheiten", // writes LeaveRequest.daysProvisional when a roster change triggers recalculation (Phase 107) — LeaveRequest is the written model even though the trigger originates in Schichtplanung
  "src/contexts/absence/vacation-calc.ts": "abwesenheiten", // BUrlG vacation-entitlement calculation
  "src/contexts/absence/vocational-school-constants.ts": "abwesenheiten", // Berufsschule pattern constants
  "src/contexts/absence/vocational-school-generator.ts": "abwesenheiten", // writes Absence primarily; notification.create is a side effect
  "src/contexts/absence/vocational-school-pattern-order.ts": "abwesenheiten", // EmployeeVocationalSchoolPattern ordering helper

  // ── schichtplanung — Shift/ShiftTemplate/CoverageRule/EmployeeShiftPattern/
  //    EmployeeAvailability/PhorestStaffMapping/PhorestSyncRun/PhorestAppointment, plus
  //    services/phorest/** (D-16 prefix rule) ────────────────────────────────────────────────
  "src/contexts/scheduling/facade/shifts.ts": "schichtplanung", // Phase 100B Plan 05 — S1/S2/S3, Shift's only external access path
  "src/contexts/scheduling/facade/availability.ts": "schichtplanung", // Phase 100B Plan 05 — S4, EmployeeAvailability's only external access path
  "src/contexts/scheduling/api/availability.ts": "schichtplanung", // writes EmployeeAvailability
  "src/contexts/scheduling/api/integrations.ts": "schichtplanung", // writes PhorestStaffMapping (Phorest scheduling-integration settings)
  "src/contexts/scheduling/api/shift-patterns.ts": "schichtplanung", // writes EmployeeShiftPattern
  "src/contexts/scheduling/api/shifts.ts": "schichtplanung", // writes CoverageRule/ShiftTemplate/Shift
  "src/contexts/scheduling/plugins/scheduler.ts": "schichtplanung", // Phorest shift-sync cron (per apps/api ARCHITECTURE.md)
  "src/services/phorest/__tests__/helpers.ts": "schichtplanung", // D-16 prefix rule (services/phorest/**) — matched here explicitly so the per-file count reflects the full measured set
  "src/services/phorest/client.ts": "schichtplanung", // D-16 prefix rule (services/phorest/**)
  "src/services/phorest/sync-appointments.ts": "schichtplanung", // D-16 prefix rule (services/phorest/**)
  "src/services/phorest/sync-shifts.ts": "schichtplanung", // D-16 prefix rule (services/phorest/**)
  "src/services/phorest/types.ts": "schichtplanung", // D-16 prefix rule (services/phorest/**)
  "src/contexts/scheduling/get-current-shift.ts": "schichtplanung", // Shift lookup; sole importer routes/presence.ts, but the model concept is Shift itself
  "src/contexts/scheduling/shift-availability.ts": "schichtplanung", // EmployeeAvailability/Shift availability checks
  "src/contexts/scheduling/shift-cleanup.ts": "schichtplanung", // soft-deletes/flags Shift rows on VOCATIONAL_SCHOOL Absence creation — Shift is the model it manipulates
  "src/contexts/scheduling/shift-netto.ts": "schichtplanung", // net Shift-hours calculation
  "src/contexts/scheduling/tenant-availability.ts": "schichtplanung", // TenantConfig.availabilityEnabled toggle for the EmployeeAvailability feature
  "src/contexts/scheduling/time-arithmetic.ts": "schichtplanung", // Phorest Vor-/Nachbereitungszeit padding, sole consumer services/phorest/sync-shifts.ts

  // ── arbeitszeitkonto — SaldoSnapshot/OpeningBalance/OvertimeAccount/OvertimeTransaction/
  //    OvertimePlan ─────────────────────────────────────────────────────────────────────────
  "src/contexts/working-time-account/api/overtime.ts": "arbeitszeitkonto", // writes OpeningBalance/OvertimeAccount/OvertimeTransaction/SaldoSnapshot/OvertimePlan
  "src/contexts/working-time-account/plugins/auto-close-month.ts": "arbeitszeitkonto", // the cron close-path (CLAUDE.md "Saldo-Rechenpfade"); writes OvertimeAccount/SaldoSnapshot/TimeEntry
  "src/contexts/working-time-account/carry-over-base.ts": "arbeitszeitkonto", // OpeningBalance carry-over base
  "src/contexts/working-time-account/close-employee-month.ts": "arbeitszeitkonto", // pure Monatsabschluss saldo core (CLAUDE.md: "belongs to Arbeitszeitkonto and is NOT to be split")
  "src/contexts/working-time-account/close-month-data.ts": "arbeitszeitkonto", // data-gathering companion to close-employee-month.ts
  "src/contexts/working-time-account/confirmed-saldo.ts": "arbeitszeitkonto", // SaldoSnapshot confirmed-vs-forecast split (Phase 97)
  "src/contexts/working-time-account/facade/overtime-account.ts": "arbeitszeitkonto", // Phase 100B Plan 06 — W8-W15, OvertimeAccount/OvertimeTransaction's only external access path
  "src/contexts/working-time-account/facade/saldo-snapshot.ts": "arbeitszeitkonto", // Phase 100B Plan 07 — W1-W7, SaldoSnapshot's only external access path
  "src/contexts/working-time-account/find-missing-workdays.ts": "arbeitszeitkonto", // Soll-vs-Ist gap detector; 3 of 5 importers (auto-close-month/close-employee-month/overtime) are Arbeitszeitkonto's own saldo paths
  "src/contexts/working-time-account/missing-entries-window.ts": "arbeitszeitkonto", // window-size companion of find-missing-workdays.ts, same callers
  "src/contexts/working-time-account/month-saldo.ts": "arbeitszeitkonto", // core Soll-vs-Ist saldo calculation — Arbeitszeitkonto's own definition
  "src/contexts/working-time-account/negative-balance-tolerance.ts": "arbeitszeitkonto", // Überstundenabbau minus-hours tolerance (Phase 100)
  "src/contexts/working-time-account/recalculate-snapshots.ts": "arbeitszeitkonto", // SaldoSnapshot recompute across the effective range
  "src/contexts/working-time-account/saldo-chain-classification.ts": "arbeitszeitkonto", // SaldoSnapshot chain delta classification
  "src/contexts/working-time-account/saldo-chain-integrity.ts": "arbeitszeitkonto", // SaldoSnapshot chain integrity check (Phase 98)
  "src/contexts/working-time-account/saldo-snapshot-cleanup.ts": "arbeitszeitkonto", // writes AuditLog/SaldoSnapshot on snapshot cleanup
  "src/contexts/working-time-account/shift-based-saldo.ts": "arbeitszeitkonto", // SHIFT_BASED saldo calculation (113B-CONTEXT.md canonical refs: "SHIFT_BASED-Rechnung")
  "src/contexts/working-time-account/snapshot-lock.ts": "arbeitszeitkonto", // "is this month closed?" Monatsabschluss primitive, derived from TimeEntry.isLocked
  "src/contexts/working-time-account/snapshot-period.ts": "arbeitszeitkonto", // SaldoSnapshot period-boundary calculation
  "src/contexts/working-time-account/timezone.ts": "arbeitszeitkonto", // calcLeaveAbsenceMinutesTz() — CLAUDE.md: "belongs to Arbeitszeitkonto and is NOT to be split"
  "src/contexts/working-time-account/vocational-school-saldo.ts": "arbeitszeitkonto", // Berufsschule minute contribution to workedMinutes/expectedMinutes — feeds overtime.ts and auto-close-month.ts's saldo math
};

/** Explicit allowlist — the `rahmen` bucket is enumerated, never a fallthrough. */
export const RAHMEN_FILES: readonly string[] = Object.entries(CONTEXT_AREA_BY_FILE)
  .filter(([, area]) => area === "rahmen")
  .map(([path]) => path)
  .sort();

export class UnmappedFileError extends Error {
  constructor(relPath: string) {
    super(
      `context-area-map: "${relPath}" is not assigned to a context area. Add it to ` +
        `CONTEXT_AREA_BY_FILE in apps/api/scripts/context-area-map.ts (or, if it lives under ` +
        `src/services/clock/ or src/services/phorest/, it should already be caught by ` +
        `CONTEXT_AREA_BY_PREFIX — check the path is spelled exactly as vitest.config.ts's ` +
        `coverage.include produces it, relative to apps/api).`,
    );
    this.name = "UnmappedFileError";
  }
}

/** Throws `UnmappedFileError` for any path not covered by the three sources above. */
export function assignContextArea(relPath: string): ContextArea {
  const explicit = CONTEXT_AREA_BY_FILE[relPath];
  if (explicit) return explicit;

  for (const { prefix, area } of CONTEXT_AREA_BY_PREFIX) {
    if (relPath.startsWith(prefix)) return area;
  }

  throw new UnmappedFileError(relPath);
}

/**
 * The file set `apps/api/vitest.config.ts` measures, POSIX paths relative to `apps/api`.
 *
 * Mirrors `coverage.include: ["src/**\/*.ts"]` / `coverage.exclude: ["**\/*.test.ts", "**\/index.ts"]`
 * by hand (vitest's own glob matcher is not exposed as a standalone utility) — the exhaustiveness
 * test asserts those two arrays are still exactly this shape, so a future change to the coverage
 * scope fails the test instead of silently shrinking the mapped set out from under this function.
 */
export function coveredSourceFiles(apiRoot: string): string[] {
  const results: string[] = [];

  function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        if (entry === "node_modules") continue; // src/node_modules/.vite cache — never source
        walk(full);
        continue;
      }
      if (!entry.endsWith(".ts")) continue;
      if (entry.endsWith(".test.ts")) continue;
      if (entry === "index.ts") continue;
      results.push(relative(apiRoot, full).split("\\").join("/"));
    }
  }

  walk(join(apiRoot, "src"));
  return results.sort();
}
