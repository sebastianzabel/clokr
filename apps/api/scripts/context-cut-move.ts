#!/usr/bin/env -S pnpm exec tsx
/**
 * Phase 99b Plan 01 (Wave 1), Task 2b — the codemod every move plan (99B-02..07) runs (D-21).
 *
 * ── TEMPORARY FILE ─────────────────────────────────────────────────────────────────────────────
 * This script exists only to perform the six context-cut moves of phase 99b (issue #99). Plan
 * 99B-08 (wave 8) DELETES it once the last context has moved — it has no purpose once
 * `apps/api/src/routes` and `apps/api/src/plugins` are gone.
 *
 * ── What it does ───────────────────────────────────────────────────────────────────────────────
 * Given a context name, it:
 *   1. `git mv`s every `[from, to]` pair in that context's table below — NEVER a raw filesystem
 *      rename and never delete-and-recreate (D-03), so `git log --follow` survives the move.
 *   2. Rewrites every relative import specifier (in the same four forms
 *      `check-import-targets.ts` resolves: `from "..."`, dynamic `import("...")`, `vi.mock("...")`,
 *      `typeof import("...")`) that points at a moved file, in EVERY file under `apps/api/src`,
 *      `apps/api/scripts` and `apps/api/vitest*.ts` — including a moved file rewriting its OWN
 *      imports of other moved files.
 *
 * The six `[from, to]` tables below are copied VERBATIM from `docs/context-cut-map.md` section 2
 * (Task 3 of this same plan) — the two must agree literally; `--print-all-pairs` is what plan
 * 99B-01's Task 3 diffs against the doc to prove it. No globbing, no derivation: an explicit table
 * is what makes the diff reviewable and a typo a loud failure instead of a silent one.
 *
 * ── Resolution / rewrite rule ──────────────────────────────────────────────────────────────────
 * For every relative specifier in an importer file: resolve it (via `check-import-targets.ts`'s own
 * `resolveSpecifier`) against the importer's ORIGINAL location. If the resolved file is in the move
 * table, recompute the specifier as a POSIX relative path from the importer's FINAL location (its
 * own `to` entry if the importer itself moves, otherwise its unchanged original directory) to the
 * target's FINAL location. `./` is prefixed when the result does not already start with `.`, and a
 * plain `.ts` extension is stripped to match the repo's dominant style — UNLESS the original
 * specifier used an explicit NodeNext-style `.js`/`.mjs`/`.cjs` extension (a handful of files do,
 * e.g. `src/routes/test-bootstrap.ts`'s `"../config.js"`), in which case that same extension is
 * kept on the rewritten path, because changing it would be a stylistic edit D-13 forbids, not a
 * pure move.
 *
 * A specifier that resolves to nothing at all is left alone and reported as unresolved — never
 * guessed at. That is `check-import-targets.ts`'s job to catch, not this tool's to paper over.
 *
 * Text edits are applied to each file's CURRENT (pre-move) content, by exact character offset
 * (`check-import-targets.ts`'s `extractSpecifierNodes`-shaped occurrences carry `start`/`end` of
 * just the specifier text, quotes excluded) — so a moved file's own outgoing imports are corrected
 * before the file is relocated, and `git mv` afterward carries the corrected content with it.
 *
 * ── `--dry-run` ────────────────────────────────────────────────────────────────────────────────
 * Prints the full plan (moves + importer rewrites + any unresolved specifiers) and touches nothing.
 * Exits non-zero if the plan would leave any specifier unresolved — the same "never silently
 * incomplete" posture as `check-import-targets.ts`.
 *
 * ── `--print-all-pairs` ────────────────────────────────────────────────────────────────────────
 * Prints every `[from, to]` pair across all six tables, one per line as `from -> to`, sorted. This
 * is the machine-readable side of the doc/codemod agreement Task 3 proves with a `diff`.
 *
 * This module has no side effects on import — `main()` is guarded exactly like
 * `scripts/lint-tenant-scoping.ts:337` (Issue #203).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  discoverCheckedFiles,
  extractSpecifiers,
  resolveSpecifier,
  EXPLICIT_JS_EXTENSION,
  type SpecifierOccurrence,
} from "./check-import-targets";

// ── The six move tables (verbatim from docs/context-cut-map.md section 2) ────────────────────────

export type MovePair = { from: string; to: string };

// komposition (99B-02) — 3 source + 3 test = 6 pairs.
export const KOMPOSITION: readonly MovePair[] = [
  { from: "apps/api/src/routes/dashboard.ts", to: "apps/api/src/composition/dashboard.ts" },
  { from: "apps/api/src/routes/reports.ts", to: "apps/api/src/composition/reports.ts" },
  { from: "apps/api/src/utils/pdf.ts", to: "apps/api/src/composition/pdf.ts" },
  {
    from: "apps/api/src/routes/__tests__/dashboard.test.ts",
    to: "apps/api/src/composition/__tests__/dashboard.test.ts",
  },
  {
    from: "apps/api/src/routes/__tests__/dashboard-overtime-trend.test.ts",
    to: "apps/api/src/composition/__tests__/dashboard-overtime-trend.test.ts",
  },
  {
    from: "apps/api/src/routes/__tests__/reports.test.ts",
    to: "apps/api/src/composition/__tests__/reports.test.ts",
  },
];

// schichtplanung (99B-03) — 11 source + 10 test = 21 pairs.
export const SCHICHTPLANUNG: readonly MovePair[] = [
  {
    from: "apps/api/src/routes/availability.ts",
    to: "apps/api/src/contexts/schichtplanung/api/availability.ts",
  },
  {
    from: "apps/api/src/routes/integrations.ts",
    to: "apps/api/src/contexts/schichtplanung/api/integrations.ts",
  },
  {
    from: "apps/api/src/routes/shift-patterns.ts",
    to: "apps/api/src/contexts/schichtplanung/api/shift-patterns.ts",
  },
  {
    from: "apps/api/src/routes/shifts.ts",
    to: "apps/api/src/contexts/schichtplanung/api/shifts.ts",
  },
  {
    from: "apps/api/src/plugins/scheduler.ts",
    to: "apps/api/src/contexts/schichtplanung/plugins/scheduler.ts",
  },
  {
    from: "apps/api/src/utils/get-current-shift.ts",
    to: "apps/api/src/contexts/schichtplanung/get-current-shift.ts",
  },
  {
    from: "apps/api/src/utils/shift-availability.ts",
    to: "apps/api/src/contexts/schichtplanung/shift-availability.ts",
  },
  {
    from: "apps/api/src/utils/shift-cleanup.ts",
    to: "apps/api/src/contexts/schichtplanung/shift-cleanup.ts",
  },
  {
    from: "apps/api/src/utils/shift-netto.ts",
    to: "apps/api/src/contexts/schichtplanung/shift-netto.ts",
  },
  {
    from: "apps/api/src/utils/tenant-availability.ts",
    to: "apps/api/src/contexts/schichtplanung/tenant-availability.ts",
  },
  {
    from: "apps/api/src/utils/time-arithmetic.ts",
    to: "apps/api/src/contexts/schichtplanung/time-arithmetic.ts",
  },
  {
    from: "apps/api/src/routes/__tests__/appointment-collisions.test.ts",
    to: "apps/api/src/contexts/schichtplanung/api/__tests__/appointment-collisions.test.ts",
  },
  {
    from: "apps/api/src/routes/__tests__/availability-toggle.test.ts",
    to: "apps/api/src/contexts/schichtplanung/api/__tests__/availability-toggle.test.ts",
  },
  {
    from: "apps/api/src/routes/__tests__/shift-arbzg.test.ts",
    to: "apps/api/src/contexts/schichtplanung/api/__tests__/shift-arbzg.test.ts",
  },
  {
    from: "apps/api/src/routes/__tests__/shift-unavailability-soft.test.ts",
    to: "apps/api/src/contexts/schichtplanung/api/__tests__/shift-unavailability-soft.test.ts",
  },
  {
    from: "apps/api/src/routes/__tests__/shifts-characterization.test.ts",
    to: "apps/api/src/contexts/schichtplanung/api/__tests__/shifts-characterization.test.ts",
  },
  {
    from: "apps/api/src/routes/__tests__/shifts-my-week.test.ts",
    to: "apps/api/src/contexts/schichtplanung/api/__tests__/shifts-my-week.test.ts",
  },
  {
    from: "apps/api/src/routes/__tests__/shifts-school-holiday.test.ts",
    to: "apps/api/src/contexts/schichtplanung/api/__tests__/shifts-school-holiday.test.ts",
  },
  {
    from: "apps/api/src/routes/__tests__/shifts.test.ts",
    to: "apps/api/src/contexts/schichtplanung/api/__tests__/shifts.test.ts",
  },
  {
    from: "apps/api/src/utils/__tests__/shift-netto.test.ts",
    to: "apps/api/src/contexts/schichtplanung/__tests__/shift-netto.test.ts",
  },
  {
    from: "apps/api/src/utils/__tests__/time-arithmetic.test.ts",
    to: "apps/api/src/contexts/schichtplanung/__tests__/time-arithmetic.test.ts",
  },
];

// unterbau (99B-04) — 32 source (15 routes incl. nested admin/, 8 plugins, 9 utils) + 6 test = 38.
export const UNTERBAU: readonly MovePair[] = [
  { from: "apps/api/src/routes/activity.ts", to: "apps/api/src/contexts/unterbau/api/activity.ts" },
  { from: "apps/api/src/routes/api-keys.ts", to: "apps/api/src/contexts/unterbau/api/api-keys.ts" },
  {
    from: "apps/api/src/routes/audit-logs.ts",
    to: "apps/api/src/contexts/unterbau/api/audit-logs.ts",
  },
  { from: "apps/api/src/routes/auth.ts", to: "apps/api/src/contexts/unterbau/api/auth.ts" },
  { from: "apps/api/src/routes/avatars.ts", to: "apps/api/src/contexts/unterbau/api/avatars.ts" },
  {
    from: "apps/api/src/routes/employees.ts",
    to: "apps/api/src/contexts/unterbau/api/employees.ts",
  },
  { from: "apps/api/src/routes/holidays.ts", to: "apps/api/src/contexts/unterbau/api/holidays.ts" },
  { from: "apps/api/src/routes/imports.ts", to: "apps/api/src/contexts/unterbau/api/imports.ts" },
  {
    from: "apps/api/src/routes/invitations.ts",
    to: "apps/api/src/contexts/unterbau/api/invitations.ts",
  },
  { from: "apps/api/src/routes/me.ts", to: "apps/api/src/contexts/unterbau/api/me.ts" },
  {
    from: "apps/api/src/routes/notifications.ts",
    to: "apps/api/src/contexts/unterbau/api/notifications.ts",
  },
  {
    from: "apps/api/src/routes/release-notes.ts",
    to: "apps/api/src/contexts/unterbau/api/release-notes.ts",
  },
  { from: "apps/api/src/routes/settings.ts", to: "apps/api/src/contexts/unterbau/api/settings.ts" },
  {
    from: "apps/api/src/routes/test-bootstrap.ts",
    to: "apps/api/src/contexts/unterbau/api/test-bootstrap.ts",
  },
  {
    from: "apps/api/src/routes/admin/school-holidays.ts",
    to: "apps/api/src/contexts/unterbau/api/admin/school-holidays.ts",
  },
  { from: "apps/api/src/plugins/audit.ts", to: "apps/api/src/contexts/unterbau/plugins/audit.ts" },
  {
    from: "apps/api/src/plugins/data-retention.ts",
    to: "apps/api/src/contexts/unterbau/plugins/data-retention.ts",
  },
  {
    from: "apps/api/src/plugins/mailer.ts",
    to: "apps/api/src/contexts/unterbau/plugins/mailer.ts",
  },
  {
    from: "apps/api/src/plugins/notify.ts",
    to: "apps/api/src/contexts/unterbau/plugins/notify.ts",
  },
  {
    from: "apps/api/src/plugins/prisma.ts",
    to: "apps/api/src/contexts/unterbau/plugins/prisma.ts",
  },
  {
    from: "apps/api/src/plugins/school-holidays-sync.ts",
    to: "apps/api/src/contexts/unterbau/plugins/school-holidays-sync.ts",
  },
  {
    from: "apps/api/src/plugins/storage.ts",
    to: "apps/api/src/contexts/unterbau/plugins/storage.ts",
  },
  {
    from: "apps/api/src/plugins/token-cleanup.ts",
    to: "apps/api/src/contexts/unterbau/plugins/token-cleanup.ts",
  },
  { from: "apps/api/src/utils/anonymize.ts", to: "apps/api/src/contexts/unterbau/anonymize.ts" },
  {
    from: "apps/api/src/utils/audit-reason.ts",
    to: "apps/api/src/contexts/unterbau/audit-reason.ts",
  },
  {
    from: "apps/api/src/utils/calculate-work-days.ts",
    to: "apps/api/src/contexts/unterbau/calculate-work-days.ts",
  },
  {
    from: "apps/api/src/utils/federal-state-iso.ts",
    to: "apps/api/src/contexts/unterbau/federal-state-iso.ts",
  },
  { from: "apps/api/src/utils/holidays.ts", to: "apps/api/src/contexts/unterbau/holidays.ts" },
  {
    from: "apps/api/src/utils/month-first-date.ts",
    to: "apps/api/src/contexts/unterbau/month-first-date.ts",
  },
  {
    from: "apps/api/src/utils/notification-email-policy.ts",
    to: "apps/api/src/contexts/unterbau/notification-email-policy.ts",
  },
  {
    from: "apps/api/src/utils/password-policy.ts",
    to: "apps/api/src/contexts/unterbau/password-policy.ts",
  },
  {
    from: "apps/api/src/utils/school-holidays-client.ts",
    to: "apps/api/src/contexts/unterbau/school-holidays-client.ts",
  },
  {
    from: "apps/api/src/routes/__tests__/minijob.test.ts",
    to: "apps/api/src/contexts/unterbau/api/__tests__/minijob.test.ts",
  },
  {
    from: "apps/api/src/routes/__tests__/schedule-type-switch-guard.test.ts",
    to: "apps/api/src/contexts/unterbau/api/__tests__/schedule-type-switch-guard.test.ts",
  },
  {
    from: "apps/api/src/routes/__tests__/schedule-versioning.test.ts",
    to: "apps/api/src/contexts/unterbau/api/__tests__/schedule-versioning.test.ts",
  },
  {
    from: "apps/api/src/routes/__tests__/settings-schedule.test.ts",
    to: "apps/api/src/contexts/unterbau/api/__tests__/settings-schedule.test.ts",
  },
  {
    from: "apps/api/src/utils/__tests__/calculate-work-days.test.ts",
    to: "apps/api/src/contexts/unterbau/__tests__/calculate-work-days.test.ts",
  },
  {
    from: "apps/api/src/utils/__tests__/holidays.test.ts",
    to: "apps/api/src/contexts/unterbau/__tests__/holidays.test.ts",
  },
];

// zeiterfassung (99B-05) — 14 source (5 routes, 1 plugin, 8 utils) + 15 test = 29.
export const ZEITERFASSUNG: readonly MovePair[] = [
  {
    from: "apps/api/src/routes/admin-presence-sources.ts",
    to: "apps/api/src/contexts/zeiterfassung/api/admin-presence-sources.ts",
  },
  {
    from: "apps/api/src/routes/presence.ts",
    to: "apps/api/src/contexts/zeiterfassung/api/presence.ts",
  },
  {
    from: "apps/api/src/routes/retro-entry-requests.ts",
    to: "apps/api/src/contexts/zeiterfassung/api/retro-entry-requests.ts",
  },
  {
    from: "apps/api/src/routes/terminals.ts",
    to: "apps/api/src/contexts/zeiterfassung/api/terminals.ts",
  },
  {
    from: "apps/api/src/routes/time-entries.ts",
    to: "apps/api/src/contexts/zeiterfassung/api/time-entries.ts",
  },
  {
    from: "apps/api/src/plugins/attendance-checker.ts",
    to: "apps/api/src/contexts/zeiterfassung/plugins/attendance-checker.ts",
  },
  { from: "apps/api/src/utils/arbzg.ts", to: "apps/api/src/contexts/zeiterfassung/arbzg.ts" },
  {
    from: "apps/api/src/utils/break-constants.ts",
    to: "apps/api/src/contexts/zeiterfassung/break-constants.ts",
  },
  {
    from: "apps/api/src/utils/break-effective.ts",
    to: "apps/api/src/contexts/zeiterfassung/break-effective.ts",
  },
  {
    from: "apps/api/src/utils/find-unconfirmed-break-days.ts",
    to: "apps/api/src/contexts/zeiterfassung/find-unconfirmed-break-days.ts",
  },
  {
    from: "apps/api/src/utils/invalid-reason.ts",
    to: "apps/api/src/contexts/zeiterfassung/invalid-reason.ts",
  },
  {
    from: "apps/api/src/utils/normalize-mac.ts",
    to: "apps/api/src/contexts/zeiterfassung/normalize-mac.ts",
  },
  { from: "apps/api/src/utils/presence.ts", to: "apps/api/src/contexts/zeiterfassung/presence.ts" },
  {
    from: "apps/api/src/utils/retro-config.ts",
    to: "apps/api/src/contexts/zeiterfassung/retro-config.ts",
  },
  {
    from: "apps/api/src/routes/__tests__/arbzg.test.ts",
    to: "apps/api/src/contexts/zeiterfassung/__tests__/arbzg.test.ts",
  },
  {
    from: "apps/api/src/utils/__tests__/invalid-reason.test.ts",
    to: "apps/api/src/contexts/zeiterfassung/__tests__/invalid-reason.test.ts",
  },
  {
    from: "apps/api/src/routes/__tests__/breaks.test.ts",
    to: "apps/api/src/contexts/zeiterfassung/api/__tests__/breaks.test.ts",
  },
  {
    from: "apps/api/src/routes/__tests__/clock-in-resolver.test.ts",
    to: "apps/api/src/contexts/zeiterfassung/api/__tests__/clock-in-resolver.test.ts",
  },
  {
    from: "apps/api/src/routes/__tests__/clock-invalid-retro.route.test.ts",
    to: "apps/api/src/contexts/zeiterfassung/api/__tests__/clock-invalid-retro.route.test.ts",
  },
  {
    from: "apps/api/src/routes/__tests__/clock-out-break-minutes.test.ts",
    to: "apps/api/src/contexts/zeiterfassung/api/__tests__/clock-out-break-minutes.test.ts",
  },
  {
    from: "apps/api/src/routes/__tests__/clock-out-resolver.test.ts",
    to: "apps/api/src/contexts/zeiterfassung/api/__tests__/clock-out-resolver.test.ts",
  },
  {
    from: "apps/api/src/routes/__tests__/effective-schedule-by-date.test.ts",
    to: "apps/api/src/contexts/zeiterfassung/api/__tests__/effective-schedule-by-date.test.ts",
  },
  {
    from: "apps/api/src/routes/__tests__/nfc-punch-race.test.ts",
    to: "apps/api/src/contexts/zeiterfassung/api/__tests__/nfc-punch-race.test.ts",
  },
  {
    from: "apps/api/src/routes/__tests__/nfc-punch-resolver.test.ts",
    to: "apps/api/src/contexts/zeiterfassung/api/__tests__/nfc-punch-resolver.test.ts",
  },
  {
    from: "apps/api/src/routes/__tests__/nfc-punch.test.ts",
    to: "apps/api/src/contexts/zeiterfassung/api/__tests__/nfc-punch.test.ts",
  },
  {
    from: "apps/api/src/routes/__tests__/presence-resolver.test.ts",
    to: "apps/api/src/contexts/zeiterfassung/api/__tests__/presence-resolver.test.ts",
  },
  {
    from: "apps/api/src/routes/__tests__/terminals.test.ts",
    to: "apps/api/src/contexts/zeiterfassung/api/__tests__/terminals.test.ts",
  },
  {
    from: "apps/api/src/routes/__tests__/time-entries-validation.test.ts",
    to: "apps/api/src/contexts/zeiterfassung/api/__tests__/time-entries-validation.test.ts",
  },
  {
    from: "apps/api/src/routes/__tests__/time-entries.test.ts",
    to: "apps/api/src/contexts/zeiterfassung/api/__tests__/time-entries.test.ts",
  },
];

// abwesenheiten (99B-06) — 26 source (6 routes, 2 plugins, 18 utils) + 5 test = 31.
export const ABWESENHEITEN: readonly MovePair[] = [
  {
    from: "apps/api/src/routes/company-shutdowns.ts",
    to: "apps/api/src/contexts/abwesenheiten/api/company-shutdowns.ts",
  },
  { from: "apps/api/src/routes/leave.ts", to: "apps/api/src/contexts/abwesenheiten/api/leave.ts" },
  {
    from: "apps/api/src/routes/section9-documents.ts",
    to: "apps/api/src/contexts/abwesenheiten/api/section9-documents.ts",
  },
  {
    from: "apps/api/src/routes/special-leave.ts",
    to: "apps/api/src/contexts/abwesenheiten/api/special-leave.ts",
  },
  {
    from: "apps/api/src/routes/vocational-school-pattern.ts",
    to: "apps/api/src/contexts/abwesenheiten/api/vocational-school-pattern.ts",
  },
  {
    from: "apps/api/src/routes/vocational-school.ts",
    to: "apps/api/src/contexts/abwesenheiten/api/vocational-school.ts",
  },
  {
    from: "apps/api/src/plugins/carryover-warning.ts",
    to: "apps/api/src/contexts/abwesenheiten/plugins/carryover-warning.ts",
  },
  {
    from: "apps/api/src/plugins/vocational-school-generator.ts",
    to: "apps/api/src/contexts/abwesenheiten/plugins/vocational-school-generator.ts",
  },
  {
    from: "apps/api/src/utils/bs-slot-resolver.ts",
    to: "apps/api/src/contexts/abwesenheiten/bs-slot-resolver.ts",
  },
  {
    from: "apps/api/src/utils/correction-lock.ts",
    to: "apps/api/src/contexts/abwesenheiten/correction-lock.ts",
  },
  {
    from: "apps/api/src/utils/find-karenz-overrun-days.ts",
    to: "apps/api/src/contexts/abwesenheiten/find-karenz-overrun-days.ts",
  },
  {
    from: "apps/api/src/utils/format-hm.ts",
    to: "apps/api/src/contexts/abwesenheiten/format-hm.ts",
  },
  { from: "apps/api/src/utils/ical.ts", to: "apps/api/src/contexts/abwesenheiten/ical.ts" },
  {
    from: "apps/api/src/utils/illness-carryover-guard.ts",
    to: "apps/api/src/contexts/abwesenheiten/illness-carryover-guard.ts",
  },
  { from: "apps/api/src/utils/jarbschg.ts", to: "apps/api/src/contexts/abwesenheiten/jarbschg.ts" },
  {
    from: "apps/api/src/utils/leave-check.ts",
    to: "apps/api/src/contexts/abwesenheiten/leave-check.ts",
  },
  {
    from: "apps/api/src/utils/leave-self-heal.ts",
    to: "apps/api/src/contexts/abwesenheiten/leave-self-heal.ts",
  },
  {
    from: "apps/api/src/utils/leave-type.ts",
    to: "apps/api/src/contexts/abwesenheiten/leave-type.ts",
  },
  {
    from: "apps/api/src/utils/load-bs-slot-overrides.ts",
    to: "apps/api/src/contexts/abwesenheiten/load-bs-slot-overrides.ts",
  },
  {
    from: "apps/api/src/utils/section9-credit-days.ts",
    to: "apps/api/src/contexts/abwesenheiten/section9-credit-days.ts",
  },
  {
    from: "apps/api/src/utils/section9-detect.ts",
    to: "apps/api/src/contexts/abwesenheiten/section9-detect.ts",
  },
  {
    from: "apps/api/src/utils/shift-leave-recalc-resolver.ts",
    to: "apps/api/src/contexts/abwesenheiten/shift-leave-recalc-resolver.ts",
  },
  {
    from: "apps/api/src/utils/vacation-calc.ts",
    to: "apps/api/src/contexts/abwesenheiten/vacation-calc.ts",
  },
  {
    from: "apps/api/src/utils/vocational-school-constants.ts",
    to: "apps/api/src/contexts/abwesenheiten/vocational-school-constants.ts",
  },
  {
    from: "apps/api/src/utils/vocational-school-generator.ts",
    to: "apps/api/src/contexts/abwesenheiten/vocational-school-generator.ts",
  },
  {
    from: "apps/api/src/utils/vocational-school-pattern-order.ts",
    to: "apps/api/src/contexts/abwesenheiten/vocational-school-pattern-order.ts",
  },
  {
    from: "apps/api/src/routes/__tests__/leave-characterization.test.ts",
    to: "apps/api/src/contexts/abwesenheiten/api/__tests__/leave-characterization.test.ts",
  },
  {
    from: "apps/api/src/utils/__tests__/leave-check.test.ts",
    to: "apps/api/src/contexts/abwesenheiten/__tests__/leave-check.test.ts",
  },
  {
    from: "apps/api/src/utils/__tests__/leave-type.test.ts",
    to: "apps/api/src/contexts/abwesenheiten/__tests__/leave-type.test.ts",
  },
  {
    from: "apps/api/src/utils/__tests__/section9-detect.test.ts",
    to: "apps/api/src/contexts/abwesenheiten/__tests__/section9-detect.test.ts",
  },
  {
    from: "apps/api/src/utils/__tests__/vacation-calc.test.ts",
    to: "apps/api/src/contexts/abwesenheiten/__tests__/vacation-calc.test.ts",
  },
];

// arbeitszeitkonto (99B-07) — 19 source (1 route, 1 plugin, 17 utils) + 15 test = 34.
export const ARBEITSZEITKONTO: readonly MovePair[] = [
  {
    from: "apps/api/src/routes/overtime.ts",
    to: "apps/api/src/contexts/arbeitszeitkonto/api/overtime.ts",
  },
  {
    from: "apps/api/src/plugins/auto-close-month.ts",
    to: "apps/api/src/contexts/arbeitszeitkonto/plugins/auto-close-month.ts",
  },
  {
    from: "apps/api/src/utils/carry-over-base.ts",
    to: "apps/api/src/contexts/arbeitszeitkonto/carry-over-base.ts",
  },
  {
    from: "apps/api/src/utils/close-employee-month.ts",
    to: "apps/api/src/contexts/arbeitszeitkonto/close-employee-month.ts",
  },
  {
    from: "apps/api/src/utils/close-month-data.ts",
    to: "apps/api/src/contexts/arbeitszeitkonto/close-month-data.ts",
  },
  {
    from: "apps/api/src/utils/confirmed-saldo.ts",
    to: "apps/api/src/contexts/arbeitszeitkonto/confirmed-saldo.ts",
  },
  {
    from: "apps/api/src/utils/find-missing-workdays.ts",
    to: "apps/api/src/contexts/arbeitszeitkonto/find-missing-workdays.ts",
  },
  {
    from: "apps/api/src/utils/missing-entries-window.ts",
    to: "apps/api/src/contexts/arbeitszeitkonto/missing-entries-window.ts",
  },
  {
    from: "apps/api/src/utils/month-saldo.ts",
    to: "apps/api/src/contexts/arbeitszeitkonto/month-saldo.ts",
  },
  {
    from: "apps/api/src/utils/negative-balance-tolerance.ts",
    to: "apps/api/src/contexts/arbeitszeitkonto/negative-balance-tolerance.ts",
  },
  {
    from: "apps/api/src/utils/recalculate-snapshots.ts",
    to: "apps/api/src/contexts/arbeitszeitkonto/recalculate-snapshots.ts",
  },
  {
    from: "apps/api/src/utils/saldo-chain-classification.ts",
    to: "apps/api/src/contexts/arbeitszeitkonto/saldo-chain-classification.ts",
  },
  {
    from: "apps/api/src/utils/saldo-chain-integrity.ts",
    to: "apps/api/src/contexts/arbeitszeitkonto/saldo-chain-integrity.ts",
  },
  {
    from: "apps/api/src/utils/saldo-snapshot-cleanup.ts",
    to: "apps/api/src/contexts/arbeitszeitkonto/saldo-snapshot-cleanup.ts",
  },
  {
    from: "apps/api/src/utils/shift-based-saldo.ts",
    to: "apps/api/src/contexts/arbeitszeitkonto/shift-based-saldo.ts",
  },
  {
    from: "apps/api/src/utils/snapshot-lock.ts",
    to: "apps/api/src/contexts/arbeitszeitkonto/snapshot-lock.ts",
  },
  {
    from: "apps/api/src/utils/snapshot-period.ts",
    to: "apps/api/src/contexts/arbeitszeitkonto/snapshot-period.ts",
  },
  {
    from: "apps/api/src/utils/timezone.ts",
    to: "apps/api/src/contexts/arbeitszeitkonto/timezone.ts",
  },
  {
    from: "apps/api/src/utils/vocational-school-saldo.ts",
    to: "apps/api/src/contexts/arbeitszeitkonto/vocational-school-saldo.ts",
  },
  {
    from: "apps/api/src/plugins/__tests__/auto-close-month.test.ts",
    to: "apps/api/src/contexts/arbeitszeitkonto/plugins/__tests__/auto-close-month.test.ts",
  },
  {
    from: "apps/api/src/routes/__tests__/opening-balance-endpoint.test.ts",
    to: "apps/api/src/contexts/arbeitszeitkonto/api/__tests__/opening-balance-endpoint.test.ts",
  },
  {
    from: "apps/api/src/routes/__tests__/opening-balance-seeding.test.ts",
    to: "apps/api/src/contexts/arbeitszeitkonto/api/__tests__/opening-balance-seeding.test.ts",
  },
  {
    from: "apps/api/src/routes/__tests__/saldo-snapshot.test.ts",
    to: "apps/api/src/contexts/arbeitszeitkonto/api/__tests__/saldo-snapshot.test.ts",
  },
  {
    from: "apps/api/src/utils/__tests__/calc-leave-absence-minutes-tz.test.ts",
    to: "apps/api/src/contexts/arbeitszeitkonto/__tests__/calc-leave-absence-minutes-tz.test.ts",
  },
  {
    from: "apps/api/src/utils/__tests__/carry-over-base.test.ts",
    to: "apps/api/src/contexts/arbeitszeitkonto/__tests__/carry-over-base.test.ts",
  },
  {
    from: "apps/api/src/utils/__tests__/find-missing-workdays.test.ts",
    to: "apps/api/src/contexts/arbeitszeitkonto/__tests__/find-missing-workdays.test.ts",
  },
  {
    from: "apps/api/src/utils/__tests__/opening-balance-model.test.ts",
    to: "apps/api/src/contexts/arbeitszeitkonto/__tests__/opening-balance-model.test.ts",
  },
  {
    from: "apps/api/src/utils/__tests__/recalculate-snapshots.test.ts",
    to: "apps/api/src/contexts/arbeitszeitkonto/__tests__/recalculate-snapshots.test.ts",
  },
  {
    from: "apps/api/src/utils/__tests__/saldo-chain-classification.test.ts",
    to: "apps/api/src/contexts/arbeitszeitkonto/__tests__/saldo-chain-classification.test.ts",
  },
  {
    from: "apps/api/src/utils/__tests__/saldo-chain-integrity-calibration.test.ts",
    to: "apps/api/src/contexts/arbeitszeitkonto/__tests__/saldo-chain-integrity-calibration.test.ts",
  },
  {
    from: "apps/api/src/utils/__tests__/saldo-chain-integrity.test.ts",
    to: "apps/api/src/contexts/arbeitszeitkonto/__tests__/saldo-chain-integrity.test.ts",
  },
  {
    from: "apps/api/src/utils/__tests__/shift-based-saldo.test.ts",
    to: "apps/api/src/contexts/arbeitszeitkonto/__tests__/shift-based-saldo.test.ts",
  },
  {
    from: "apps/api/src/utils/__tests__/snapshot-lock.test.ts",
    to: "apps/api/src/contexts/arbeitszeitkonto/__tests__/snapshot-lock.test.ts",
  },
  {
    from: "apps/api/src/utils/__tests__/timezone.test.ts",
    to: "apps/api/src/contexts/arbeitszeitkonto/__tests__/timezone.test.ts",
  },
];

export const CONTEXTS: Readonly<Record<string, readonly MovePair[]>> = {
  komposition: KOMPOSITION,
  schichtplanung: SCHICHTPLANUNG,
  unterbau: UNTERBAU,
  zeiterfassung: ZEITERFASSUNG,
  abwesenheiten: ABWESENHEITEN,
  arbeitszeitkonto: ARBEITSZEITKONTO,
};

// ── Plan construction ──────────────────────────────────────────────────────────────────────────

export type SpecifierEdit = {
  start: number;
  end: number;
  oldSpecifier: string;
  newSpecifier: string;
  line: number;
};

export type FileRewrite = { absPath: string; relPath: string; edits: SpecifierEdit[] };

export type UnresolvedSpecifier = { file: string; line: number; specifier: string };

export type MovePlan = {
  context: string;
  moves: MovePair[];
  rewrites: FileRewrite[];
  unresolved: UnresolvedSpecifier[];
};

function formatRewrittenSpecifier(
  importerFinalDir: string,
  targetFinalAbs: string,
  originalSpecifier: string,
): string {
  let rel = path.relative(importerFinalDir, targetFinalAbs).split(path.sep).join("/");
  if (!rel.startsWith(".")) rel = `./${rel}`;
  const jsExtMatch = EXPLICIT_JS_EXTENSION.exec(originalSpecifier);
  if (jsExtMatch) {
    // Preserve the original NodeNext-style explicit extension — D-13 forbids a stylistic change.
    return rel.replace(/\.ts$/, "") + jsExtMatch[0];
  }
  return rel.replace(/\.ts$/, "");
}

/** Builds the full move+rewrite plan for `context` against the tree currently on disk. Performs
 * NO filesystem mutation — pure analysis, so it is safe to call for `--dry-run`. */
export function buildPlan(repoRoot: string, context: string): MovePlan {
  const moves = CONTEXTS[context];
  if (!moves) {
    throw new Error(
      `context-cut-move: unknown context "${context}". Known: ${Object.keys(CONTEXTS).join(", ")}`,
    );
  }

  const moveMap = new Map<string, string>(); // abs old path -> abs new path
  for (const { from, to } of moves) {
    const absFrom = path.resolve(repoRoot, from);
    if (!fs.existsSync(absFrom)) {
      throw new Error(`context-cut-move: source file does not exist: ${from}`);
    }
    moveMap.set(absFrom, path.resolve(repoRoot, to));
  }

  const apiRoot = path.join(repoRoot, "apps/api");
  const importerFiles = discoverCheckedFiles(apiRoot);

  const rewrites: FileRewrite[] = [];
  const unresolved: UnresolvedSpecifier[] = [];

  for (const absFile of importerFiles) {
    const relPath = path.relative(repoRoot, absFile).split(path.sep).join("/");
    const text = fs.readFileSync(absFile, "utf8");
    const sourceFile = ts.createSourceFile(absFile, text, ts.ScriptTarget.Latest, true);
    const occurrences: SpecifierOccurrence[] = extractSpecifiers(sourceFile, relPath);

    const edits: SpecifierEdit[] = [];
    for (const occ of occurrences) {
      const resolvedAbs = resolveSpecifier(absFile, occ.specifier);
      if (!resolvedAbs) {
        // Not this tool's job — check-import-targets.ts is what flags a genuinely broken
        // specifier. Here it just means "not a specifier this codemod needs to touch".
        continue;
      }
      const targetNew = moveMap.get(resolvedAbs);
      if (!targetNew) continue; // resolves fine, but not one of THIS context's moved files

      const importerNew = moveMap.get(absFile) ?? absFile;
      const importerFinalDir = path.dirname(importerNew);
      const newSpecifier = formatRewrittenSpecifier(importerFinalDir, targetNew, occ.specifier);
      if (newSpecifier === occ.specifier) continue; // depth happened to stay identical

      edits.push({
        start: occ.start,
        end: occ.end,
        oldSpecifier: occ.specifier,
        newSpecifier,
        line: occ.line,
      });
    }

    if (edits.length > 0) {
      rewrites.push({ absPath: absFile, relPath, edits });
    }
  }

  return { context, moves: [...moves], rewrites, unresolved };
}

// ── Plan application ───────────────────────────────────────────────────────────────────────────

/** Applies `plan`: rewrites every importer's text in place (by exact offset, highest offset first
 * so earlier offsets stay valid), THEN `git mv`s every pair. Text edits happen BEFORE the move so a
 * moved file's own outgoing imports are corrected before `git mv` relocates it (D-03: `git mv`,
 * never a raw filesystem rename, never delete-and-recreate). */
export function applyPlan(repoRoot: string, plan: MovePlan): void {
  for (const rewrite of plan.rewrites) {
    let text = fs.readFileSync(rewrite.absPath, "utf8");
    const sortedEdits = [...rewrite.edits].sort((a, b) => b.start - a.start);
    for (const edit of sortedEdits) {
      text = text.slice(0, edit.start) + edit.newSpecifier + text.slice(edit.end);
    }
    fs.writeFileSync(rewrite.absPath, text);
  }

  for (const { from, to } of plan.moves) {
    const absTo = path.resolve(repoRoot, to);
    fs.mkdirSync(path.dirname(absTo), { recursive: true });
    execSync(`git mv ${JSON.stringify(from)} ${JSON.stringify(to)}`, {
      cwd: repoRoot,
      stdio: "pipe",
    });
  }
}

// ── CLI entry ──────────────────────────────────────────────────────────────────────────────────

function resolveRepoRoot(): string {
  const scriptDir = import.meta.dirname ?? path.resolve(new URL(import.meta.url).pathname, "..");
  let dir = scriptDir;
  for (let i = 0; i < 10 && dir !== "/"; i++) {
    if (fs.existsSync(path.resolve(dir, "apps", "api"))) return dir;
    dir = path.resolve(dir, "..");
  }
  return execSync("git rev-parse --show-toplevel").toString().trim();
}

function printPlan(plan: MovePlan): void {
  console.log(
    `[context-cut-move] context "${plan.context}": ${plan.moves.length} git mv pair(s), ` +
      `${plan.rewrites.length} importer file(s) to rewrite.\n`,
  );
  for (const { from, to } of plan.moves) {
    console.log(`  git mv ${from} -> ${to}`);
  }
  console.log("");
  for (const rewrite of plan.rewrites) {
    console.log(`  rewrite ${rewrite.relPath} (${rewrite.edits.length} specifier(s)):`);
    for (const edit of rewrite.edits) {
      console.log(`    :${edit.line}  "${edit.oldSpecifier}" -> "${edit.newSpecifier}"`);
    }
  }
  if (plan.unresolved.length > 0) {
    console.error(`\n  ${plan.unresolved.length} unresolved specifier(s):`);
    for (const u of plan.unresolved) {
      console.error(`    ${u.file}:${u.line} -> ${u.specifier}`);
    }
  }
}

function printAllPairs(): void {
  const all = Object.values(CONTEXTS)
    .flat()
    .map((pair) => `${pair.from} -> ${pair.to}`)
    .sort();
  for (const line of all) console.log(line);
}

function main(): void {
  if (process.argv.includes("--print-all-pairs")) {
    printAllPairs();
    return;
  }

  const context = process.argv[2];
  const dryRun = process.argv.includes("--dry-run");

  if (!context || !(context in CONTEXTS)) {
    console.error(
      `Usage: tsx scripts/context-cut-move.ts <context> [--dry-run]\n` +
        `Known contexts: ${Object.keys(CONTEXTS).join(", ")}`,
    );
    process.exitCode = 1;
    return;
  }

  const repoRoot = resolveRepoRoot();
  const plan = buildPlan(repoRoot, context);
  printPlan(plan);

  if (plan.unresolved.length > 0) {
    console.error(`\n[context-cut-move] aborting: unresolved specifiers present.`);
    process.exitCode = 1;
    return;
  }

  if (dryRun) {
    console.log(`\n[context-cut-move] --dry-run: nothing was touched.`);
    return;
  }

  applyPlan(repoRoot, plan);
  console.log(
    `\n[context-cut-move] applied: ${plan.moves.length} file(s) moved, ` +
      `${plan.rewrites.length} file(s) rewritten.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
