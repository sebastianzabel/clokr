# Context Cut Map (Phase 99b, Issue #99)

Issue #99's fourth acceptance criterion is "Die Zuordnung ist im Repo dokumentiert, damit sie beim
nächsten Anlegen einer Datei greift" (the assignment is documented in the repo, so it applies the
next time a file is created). `.planning/` is gitignored, so this document is the ONLY place that
survives to answer "where does a new file go" after phase 99b's planning artefacts are gone.

Phase 99b is a **pure move**: every file under `apps/api/src/routes/`, `apps/api/src/utils/` and
`apps/api/src/plugins/` ends up in exactly one of Zeiterfassung, Abwesenheiten, Schichtplanung,
Arbeitszeitkonto, Unterbau, or the composition layer — no behaviour change, no signature change, no
renamed identifier. See `docs/adr/0001-drei-kontexte.md` for the context boundaries themselves and
`CLAUDE.md` § Context Boundaries for the rules that govern crossing them.

---

## 1. Where a new file goes

| Origin under `apps/api/src/`                      | Destination                                         |
| ------------------------------------------------- | --------------------------------------------------- |
| a Fastify route                                   | `apps/api/src/contexts/<context>/api/<name>.ts`     |
| a Fastify plugin                                  | `apps/api/src/contexts/<context>/plugins/<name>.ts` |
| anything else owned by one context                | `apps/api/src/contexts/<context>/<name>.ts` (flat)  |
| composition (owns no model, carries no Fachregel) | `apps/api/src/composition/<name>.ts`                |
| framework/bootstrap/test infrastructure           | stays under `apps/api/src/utils/` — see section 4   |

**This section is the rule the next new file follows.** All 159 moves below are already complete
(phase 99b landed in `main` on 2026-09-16) — the table records what happened, and section 1's rule
is what a new file follows going forward.

`apps/api/src/contexts/<context>/domain/`, `application/`, `infrastructure/` and `events/` — the
target picture issue #99's body sketches — are **NOT created by this phase**. Sorting a file into
one of those is interpretation, and this phase is a pure move (D-05). Where the placement is
obvious (a route belongs in `api/`), it is taken; everything else lies flat in the context root and
the inner layering follows later, in a phase that can actually reason about it.

**Why plugins get their own subdirectory instead of lying flat, too:** two DIFFERENT files can share
a basename across the `utils/`→flat and `plugins/`→`plugins/` split. The concrete case Phase 99b
hits is `plugins/vocational-school-generator.ts` (the cron wrapper) and
`utils/vocational-school-generator.ts` (the Absence generation itself) — both Abwesenheiten, both
named identically. A flat layout for both would force a rename to avoid a collision, and D-13
forbids exactly that kind of opportunistic edit inside a pure-move phase. The `plugins/`
subdirectory resolves the collision without touching either name.

---

## 2. The mapping

The machine-readable source of truth is `apps/api/scripts/context-area-map.ts`
(`CONTEXT_AREA_BY_FILE`), exhaustiveness-tested by
`apps/api/scripts/__tests__/context-area-map.test.ts` — every one of the 109 non-test files that
used to live under `routes/`, `utils/` and `plugins/` is keyed there against its now-current path,
and an unmapped file throws `UnmappedFileError`. That map assigns a CONTEXT AREA (the bucket); this
document's table below additionally states the concrete DESTINATION PATH each file moved to, which
is one level more specific and is what `apps/api/scripts/context-cut-move.ts` (the wave-1 codemod)
was populated from. The codemod's six `[from, to]` tables agreed LITERALLY with the table below at
every one of the six move commits (plan 99B-01's proof obligation P7) — the codemod itself is
deleted (plan 99B-08, its job was done once all six moves landed), so that comparison is now
historical rather than re-runnable, but the table below still describes the tree as it stands.

159 files move in total: 105 non-test source files and 54 co-located tests (D-07: a test stays next
to the code it exercises). Grouped by context, in the move order of section 3:

### komposition (99B-02) — 3 source + 3 test

| from                                                             | to                                                                    |
| ---------------------------------------------------------------- | --------------------------------------------------------------------- |
| `apps/api/src/routes/dashboard.ts`                               | `apps/api/src/composition/dashboard.ts`                               |
| `apps/api/src/routes/reports.ts`                                 | `apps/api/src/composition/reports.ts`                                 |
| `apps/api/src/utils/pdf.ts`                                      | `apps/api/src/composition/pdf.ts`                                     |
| `apps/api/src/routes/__tests__/dashboard.test.ts`                | `apps/api/src/composition/__tests__/dashboard.test.ts`                |
| `apps/api/src/routes/__tests__/dashboard-overtime-trend.test.ts` | `apps/api/src/composition/__tests__/dashboard-overtime-trend.test.ts` |
| `apps/api/src/routes/__tests__/reports.test.ts`                  | `apps/api/src/composition/__tests__/reports.test.ts`                  |

### schichtplanung (99B-03) — 11 source + 10 test

| from                                                              | to                                                                                     |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `apps/api/src/routes/availability.ts`                             | `apps/api/src/contexts/schichtplanung/api/availability.ts`                             |
| `apps/api/src/routes/integrations.ts`                             | `apps/api/src/contexts/schichtplanung/api/integrations.ts`                             |
| `apps/api/src/routes/shift-patterns.ts`                           | `apps/api/src/contexts/schichtplanung/api/shift-patterns.ts`                           |
| `apps/api/src/routes/shifts.ts`                                   | `apps/api/src/contexts/schichtplanung/api/shifts.ts`                                   |
| `apps/api/src/plugins/scheduler.ts`                               | `apps/api/src/contexts/schichtplanung/plugins/scheduler.ts`                            |
| `apps/api/src/utils/get-current-shift.ts`                         | `apps/api/src/contexts/schichtplanung/get-current-shift.ts`                            |
| `apps/api/src/utils/shift-availability.ts`                        | `apps/api/src/contexts/schichtplanung/shift-availability.ts`                           |
| `apps/api/src/utils/shift-cleanup.ts`                             | `apps/api/src/contexts/schichtplanung/shift-cleanup.ts`                                |
| `apps/api/src/utils/shift-netto.ts`                               | `apps/api/src/contexts/schichtplanung/shift-netto.ts`                                  |
| `apps/api/src/utils/tenant-availability.ts`                       | `apps/api/src/contexts/schichtplanung/tenant-availability.ts`                          |
| `apps/api/src/utils/time-arithmetic.ts`                           | `apps/api/src/contexts/schichtplanung/time-arithmetic.ts`                              |
| `apps/api/src/routes/__tests__/appointment-collisions.test.ts`    | `apps/api/src/contexts/schichtplanung/api/__tests__/appointment-collisions.test.ts`    |
| `apps/api/src/routes/__tests__/availability-toggle.test.ts`       | `apps/api/src/contexts/schichtplanung/api/__tests__/availability-toggle.test.ts`       |
| `apps/api/src/routes/__tests__/shift-arbzg.test.ts`               | `apps/api/src/contexts/schichtplanung/api/__tests__/shift-arbzg.test.ts`               |
| `apps/api/src/routes/__tests__/shift-unavailability-soft.test.ts` | `apps/api/src/contexts/schichtplanung/api/__tests__/shift-unavailability-soft.test.ts` |
| `apps/api/src/routes/__tests__/shifts-characterization.test.ts`   | `apps/api/src/contexts/schichtplanung/api/__tests__/shifts-characterization.test.ts`   |
| `apps/api/src/routes/__tests__/shifts-my-week.test.ts`            | `apps/api/src/contexts/schichtplanung/api/__tests__/shifts-my-week.test.ts`            |
| `apps/api/src/routes/__tests__/shifts-school-holiday.test.ts`     | `apps/api/src/contexts/schichtplanung/api/__tests__/shifts-school-holiday.test.ts`     |
| `apps/api/src/routes/__tests__/shifts.test.ts`                    | `apps/api/src/contexts/schichtplanung/api/__tests__/shifts.test.ts`                    |
| `apps/api/src/utils/__tests__/shift-netto.test.ts`                | `apps/api/src/contexts/schichtplanung/__tests__/shift-netto.test.ts`                   |
| `apps/api/src/utils/__tests__/time-arithmetic.test.ts`            | `apps/api/src/contexts/schichtplanung/__tests__/time-arithmetic.test.ts`               |

**services/phorest/ does NOT move** (D-17, section 4) — but `services/phorest/sync-shifts.ts`
imports `utils/time-arithmetic.ts`, so ITS import specifier is rewritten to point at
`contexts/schichtplanung/time-arithmetic.ts` even though `sync-shifts.ts` itself stays put.

### unterbau (99B-04) — 32 source (15 routes incl. nested `admin/`, 8 plugins, 9 utils) + 6 test

| from                                                               | to                                                                                |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `apps/api/src/routes/activity.ts`                                  | `apps/api/src/contexts/unterbau/api/activity.ts`                                  |
| `apps/api/src/routes/api-keys.ts`                                  | `apps/api/src/contexts/unterbau/api/api-keys.ts`                                  |
| `apps/api/src/routes/audit-logs.ts`                                | `apps/api/src/contexts/unterbau/api/audit-logs.ts`                                |
| `apps/api/src/routes/auth.ts`                                      | `apps/api/src/contexts/unterbau/api/auth.ts`                                      |
| `apps/api/src/routes/avatars.ts`                                   | `apps/api/src/contexts/unterbau/api/avatars.ts`                                   |
| `apps/api/src/routes/employees.ts`                                 | `apps/api/src/contexts/unterbau/api/employees.ts`                                 |
| `apps/api/src/routes/holidays.ts`                                  | `apps/api/src/contexts/unterbau/api/holidays.ts`                                  |
| `apps/api/src/routes/imports.ts`                                   | `apps/api/src/contexts/unterbau/api/imports.ts`                                   |
| `apps/api/src/routes/invitations.ts`                               | `apps/api/src/contexts/unterbau/api/invitations.ts`                               |
| `apps/api/src/routes/me.ts`                                        | `apps/api/src/contexts/unterbau/api/me.ts`                                        |
| `apps/api/src/routes/notifications.ts`                             | `apps/api/src/contexts/unterbau/api/notifications.ts`                             |
| `apps/api/src/routes/release-notes.ts`                             | `apps/api/src/contexts/unterbau/api/release-notes.ts`                             |
| `apps/api/src/routes/settings.ts`                                  | `apps/api/src/contexts/unterbau/api/settings.ts`                                  |
| `apps/api/src/routes/test-bootstrap.ts`                            | `apps/api/src/contexts/unterbau/api/test-bootstrap.ts`                            |
| `apps/api/src/routes/admin/school-holidays.ts`                     | `apps/api/src/contexts/unterbau/api/admin/school-holidays.ts`                     |
| `apps/api/src/plugins/audit.ts`                                    | `apps/api/src/contexts/unterbau/plugins/audit.ts`                                 |
| `apps/api/src/plugins/data-retention.ts`                           | `apps/api/src/contexts/unterbau/plugins/data-retention.ts`                        |
| `apps/api/src/plugins/mailer.ts`                                   | `apps/api/src/contexts/unterbau/plugins/mailer.ts`                                |
| `apps/api/src/plugins/notify.ts`                                   | `apps/api/src/contexts/unterbau/plugins/notify.ts`                                |
| `apps/api/src/plugins/prisma.ts`                                   | `apps/api/src/contexts/unterbau/plugins/prisma.ts`                                |
| `apps/api/src/plugins/school-holidays-sync.ts`                     | `apps/api/src/contexts/unterbau/plugins/school-holidays-sync.ts`                  |
| `apps/api/src/plugins/storage.ts`                                  | `apps/api/src/contexts/unterbau/plugins/storage.ts`                               |
| `apps/api/src/plugins/token-cleanup.ts`                            | `apps/api/src/contexts/unterbau/plugins/token-cleanup.ts`                         |
| `apps/api/src/utils/anonymize.ts`                                  | `apps/api/src/contexts/unterbau/anonymize.ts`                                     |
| `apps/api/src/utils/audit-reason.ts`                               | `apps/api/src/contexts/unterbau/audit-reason.ts`                                  |
| `apps/api/src/utils/calculate-work-days.ts`                        | `apps/api/src/contexts/unterbau/calculate-work-days.ts`                           |
| `apps/api/src/utils/federal-state-iso.ts`                          | `apps/api/src/contexts/unterbau/federal-state-iso.ts`                             |
| `apps/api/src/utils/holidays.ts`                                   | `apps/api/src/contexts/unterbau/holidays.ts`                                      |
| `apps/api/src/utils/month-first-date.ts`                           | `apps/api/src/contexts/unterbau/month-first-date.ts`                              |
| `apps/api/src/utils/notification-email-policy.ts`                  | `apps/api/src/contexts/unterbau/notification-email-policy.ts`                     |
| `apps/api/src/utils/password-policy.ts`                            | `apps/api/src/contexts/unterbau/password-policy.ts`                               |
| `apps/api/src/utils/school-holidays-client.ts`                     | `apps/api/src/contexts/unterbau/school-holidays-client.ts`                        |
| `apps/api/src/routes/__tests__/minijob.test.ts`                    | `apps/api/src/contexts/unterbau/api/__tests__/minijob.test.ts`                    |
| `apps/api/src/routes/__tests__/schedule-type-switch-guard.test.ts` | `apps/api/src/contexts/unterbau/api/__tests__/schedule-type-switch-guard.test.ts` |
| `apps/api/src/routes/__tests__/schedule-versioning.test.ts`        | `apps/api/src/contexts/unterbau/api/__tests__/schedule-versioning.test.ts`        |
| `apps/api/src/routes/__tests__/settings-schedule.test.ts`          | `apps/api/src/contexts/unterbau/api/__tests__/settings-schedule.test.ts`          |
| `apps/api/src/utils/__tests__/calculate-work-days.test.ts`         | `apps/api/src/contexts/unterbau/__tests__/calculate-work-days.test.ts`            |
| `apps/api/src/utils/__tests__/holidays.test.ts`                    | `apps/api/src/contexts/unterbau/__tests__/holidays.test.ts`                       |

**Two different `release-notes.ts` files exist.** `routes/release-notes.ts` is Unterbau and MOVES
(the table above). `utils/release-notes.ts` is bucket `rahmen` and does NOT move — see section 4.
Do not confuse the two when reading a diff.

**`routes/holidays.ts` and `utils/holidays.ts` both exist and both move**, to
`contexts/unterbau/api/holidays.ts` and `contexts/unterbau/holidays.ts` respectively — no collision
(different subdirectories), no rename (D-13 forbids one).

### zeiterfassung (99B-05) — 14 source (5 routes, 1 plugin, 8 utils) + 15 test

| from                                                               | to                                                                                     |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `apps/api/src/routes/admin-presence-sources.ts`                    | `apps/api/src/contexts/zeiterfassung/api/admin-presence-sources.ts`                    |
| `apps/api/src/routes/presence.ts`                                  | `apps/api/src/contexts/zeiterfassung/api/presence.ts`                                  |
| `apps/api/src/routes/retro-entry-requests.ts`                      | `apps/api/src/contexts/zeiterfassung/api/retro-entry-requests.ts`                      |
| `apps/api/src/routes/terminals.ts`                                 | `apps/api/src/contexts/zeiterfassung/api/terminals.ts`                                 |
| `apps/api/src/routes/time-entries.ts`                              | `apps/api/src/contexts/zeiterfassung/api/time-entries.ts`                              |
| `apps/api/src/plugins/attendance-checker.ts`                       | `apps/api/src/contexts/zeiterfassung/plugins/attendance-checker.ts`                    |
| `apps/api/src/utils/arbzg.ts`                                      | `apps/api/src/contexts/zeiterfassung/arbzg.ts`                                         |
| `apps/api/src/utils/break-constants.ts`                            | `apps/api/src/contexts/zeiterfassung/break-constants.ts`                               |
| `apps/api/src/utils/break-effective.ts`                            | `apps/api/src/contexts/zeiterfassung/break-effective.ts`                               |
| `apps/api/src/utils/find-unconfirmed-break-days.ts`                | `apps/api/src/contexts/zeiterfassung/find-unconfirmed-break-days.ts`                   |
| `apps/api/src/utils/invalid-reason.ts`                             | `apps/api/src/contexts/zeiterfassung/invalid-reason.ts`                                |
| `apps/api/src/utils/normalize-mac.ts`                              | `apps/api/src/contexts/zeiterfassung/normalize-mac.ts`                                 |
| `apps/api/src/utils/presence.ts`                                   | `apps/api/src/contexts/zeiterfassung/presence.ts`                                      |
| `apps/api/src/utils/retro-config.ts`                               | `apps/api/src/contexts/zeiterfassung/retro-config.ts`                                  |
| `apps/api/src/routes/__tests__/arbzg.test.ts`                      | `apps/api/src/contexts/zeiterfassung/__tests__/arbzg.test.ts`                          |
| `apps/api/src/utils/__tests__/invalid-reason.test.ts`              | `apps/api/src/contexts/zeiterfassung/__tests__/invalid-reason.test.ts`                 |
| `apps/api/src/routes/__tests__/breaks.test.ts`                     | `apps/api/src/contexts/zeiterfassung/api/__tests__/breaks.test.ts`                     |
| `apps/api/src/routes/__tests__/clock-in-resolver.test.ts`          | `apps/api/src/contexts/zeiterfassung/api/__tests__/clock-in-resolver.test.ts`          |
| `apps/api/src/routes/__tests__/clock-invalid-retro.route.test.ts`  | `apps/api/src/contexts/zeiterfassung/api/__tests__/clock-invalid-retro.route.test.ts`  |
| `apps/api/src/routes/__tests__/clock-out-break-minutes.test.ts`    | `apps/api/src/contexts/zeiterfassung/api/__tests__/clock-out-break-minutes.test.ts`    |
| `apps/api/src/routes/__tests__/clock-out-resolver.test.ts`         | `apps/api/src/contexts/zeiterfassung/api/__tests__/clock-out-resolver.test.ts`         |
| `apps/api/src/routes/__tests__/effective-schedule-by-date.test.ts` | `apps/api/src/contexts/zeiterfassung/api/__tests__/effective-schedule-by-date.test.ts` |
| `apps/api/src/routes/__tests__/nfc-punch-race.test.ts`             | `apps/api/src/contexts/zeiterfassung/api/__tests__/nfc-punch-race.test.ts`             |
| `apps/api/src/routes/__tests__/nfc-punch-resolver.test.ts`         | `apps/api/src/contexts/zeiterfassung/api/__tests__/nfc-punch-resolver.test.ts`         |
| `apps/api/src/routes/__tests__/nfc-punch.test.ts`                  | `apps/api/src/contexts/zeiterfassung/api/__tests__/nfc-punch.test.ts`                  |
| `apps/api/src/routes/__tests__/presence-resolver.test.ts`          | `apps/api/src/contexts/zeiterfassung/api/__tests__/presence-resolver.test.ts`          |
| `apps/api/src/routes/__tests__/terminals.test.ts`                  | `apps/api/src/contexts/zeiterfassung/api/__tests__/terminals.test.ts`                  |
| `apps/api/src/routes/__tests__/time-entries-validation.test.ts`    | `apps/api/src/contexts/zeiterfassung/api/__tests__/time-entries-validation.test.ts`    |
| `apps/api/src/routes/__tests__/time-entries.test.ts`               | `apps/api/src/contexts/zeiterfassung/api/__tests__/time-entries.test.ts`               |

**`routes/presence.ts` and `utils/presence.ts` both exist and both move**, to
`contexts/zeiterfassung/api/presence.ts` and `contexts/zeiterfassung/presence.ts` — same pattern as
`holidays.ts` above, no collision, no rename.

**`routes/__tests__/arbzg.test.ts` moves to the context ROOT `__tests__/`, not `api/__tests__/`** —
it imports `../utils/arbzg` and is a utility test that happened to live under `routes/__tests__`
(D-07: co-located with its SUBJECT, not with the directory it historically sat in).

### abwesenheiten (99B-06) — 26 source (6 routes, 2 plugins, 18 utils) + 5 test

| from                                                           | to                                                                                 |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `apps/api/src/routes/company-shutdowns.ts`                     | `apps/api/src/contexts/abwesenheiten/api/company-shutdowns.ts`                     |
| `apps/api/src/routes/leave.ts`                                 | `apps/api/src/contexts/abwesenheiten/api/leave.ts`                                 |
| `apps/api/src/routes/section9-documents.ts`                    | `apps/api/src/contexts/abwesenheiten/api/section9-documents.ts`                    |
| `apps/api/src/routes/special-leave.ts`                         | `apps/api/src/contexts/abwesenheiten/api/special-leave.ts`                         |
| `apps/api/src/routes/vocational-school-pattern.ts`             | `apps/api/src/contexts/abwesenheiten/api/vocational-school-pattern.ts`             |
| `apps/api/src/routes/vocational-school.ts`                     | `apps/api/src/contexts/abwesenheiten/api/vocational-school.ts`                     |
| `apps/api/src/plugins/carryover-warning.ts`                    | `apps/api/src/contexts/abwesenheiten/plugins/carryover-warning.ts`                 |
| `apps/api/src/plugins/vocational-school-generator.ts`          | `apps/api/src/contexts/abwesenheiten/plugins/vocational-school-generator.ts`       |
| `apps/api/src/utils/bs-slot-resolver.ts`                       | `apps/api/src/contexts/abwesenheiten/bs-slot-resolver.ts`                          |
| `apps/api/src/utils/correction-lock.ts`                        | `apps/api/src/contexts/abwesenheiten/correction-lock.ts`                           |
| `apps/api/src/utils/find-karenz-overrun-days.ts`               | `apps/api/src/contexts/abwesenheiten/find-karenz-overrun-days.ts`                  |
| `apps/api/src/utils/format-hm.ts`                              | `apps/api/src/contexts/abwesenheiten/format-hm.ts`                                 |
| `apps/api/src/utils/ical.ts`                                   | `apps/api/src/contexts/abwesenheiten/ical.ts`                                      |
| `apps/api/src/utils/illness-carryover-guard.ts`                | `apps/api/src/contexts/abwesenheiten/illness-carryover-guard.ts`                   |
| `apps/api/src/utils/jarbschg.ts`                               | `apps/api/src/contexts/abwesenheiten/jarbschg.ts`                                  |
| `apps/api/src/utils/leave-check.ts`                            | `apps/api/src/contexts/abwesenheiten/leave-check.ts`                               |
| `apps/api/src/utils/leave-self-heal.ts`                        | `apps/api/src/contexts/abwesenheiten/leave-self-heal.ts`                           |
| `apps/api/src/utils/leave-type.ts`                             | `apps/api/src/contexts/abwesenheiten/leave-type.ts`                                |
| `apps/api/src/utils/load-bs-slot-overrides.ts`                 | `apps/api/src/contexts/abwesenheiten/load-bs-slot-overrides.ts`                    |
| `apps/api/src/utils/section9-credit-days.ts`                   | `apps/api/src/contexts/abwesenheiten/section9-credit-days.ts`                      |
| `apps/api/src/utils/section9-detect.ts`                        | `apps/api/src/contexts/abwesenheiten/section9-detect.ts`                           |
| `apps/api/src/utils/shift-leave-recalc-resolver.ts`            | `apps/api/src/contexts/abwesenheiten/shift-leave-recalc-resolver.ts`               |
| `apps/api/src/utils/vacation-calc.ts`                          | `apps/api/src/contexts/abwesenheiten/vacation-calc.ts`                             |
| `apps/api/src/utils/vocational-school-constants.ts`            | `apps/api/src/contexts/abwesenheiten/vocational-school-constants.ts`               |
| `apps/api/src/utils/vocational-school-generator.ts`            | `apps/api/src/contexts/abwesenheiten/vocational-school-generator.ts`               |
| `apps/api/src/utils/vocational-school-pattern-order.ts`        | `apps/api/src/contexts/abwesenheiten/vocational-school-pattern-order.ts`           |
| `apps/api/src/routes/__tests__/leave-characterization.test.ts` | `apps/api/src/contexts/abwesenheiten/api/__tests__/leave-characterization.test.ts` |
| `apps/api/src/utils/__tests__/leave-check.test.ts`             | `apps/api/src/contexts/abwesenheiten/__tests__/leave-check.test.ts`                |
| `apps/api/src/utils/__tests__/leave-type.test.ts`              | `apps/api/src/contexts/abwesenheiten/__tests__/leave-type.test.ts`                 |
| `apps/api/src/utils/__tests__/section9-detect.test.ts`         | `apps/api/src/contexts/abwesenheiten/__tests__/section9-detect.test.ts`            |
| `apps/api/src/utils/__tests__/vacation-calc.test.ts`           | `apps/api/src/contexts/abwesenheiten/__tests__/vacation-calc.test.ts`              |

**THE COLLISION.** `plugins/vocational-school-generator.ts` (the cron wrapper) and
`utils/vocational-school-generator.ts` (the Absence generation itself) are two different files with
the same basename, both Abwesenheiten. They land at
`contexts/abwesenheiten/plugins/vocational-school-generator.ts` and
`contexts/abwesenheiten/vocational-school-generator.ts` — the `plugins/` subdirectory from section 1
exists precisely to resolve this without renaming either.

### arbeitszeitkonto (99B-07) — 19 source (1 route, 1 plugin, 17 utils) + 15 test

| from                                                                     | to                                                                                           |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `apps/api/src/routes/overtime.ts`                                        | `apps/api/src/contexts/arbeitszeitkonto/api/overtime.ts`                                     |
| `apps/api/src/plugins/auto-close-month.ts`                               | `apps/api/src/contexts/arbeitszeitkonto/plugins/auto-close-month.ts`                         |
| `apps/api/src/utils/carry-over-base.ts`                                  | `apps/api/src/contexts/arbeitszeitkonto/carry-over-base.ts`                                  |
| `apps/api/src/utils/close-employee-month.ts`                             | `apps/api/src/contexts/arbeitszeitkonto/close-employee-month.ts`                             |
| `apps/api/src/utils/close-month-data.ts`                                 | `apps/api/src/contexts/arbeitszeitkonto/close-month-data.ts`                                 |
| `apps/api/src/utils/confirmed-saldo.ts`                                  | `apps/api/src/contexts/arbeitszeitkonto/confirmed-saldo.ts`                                  |
| `apps/api/src/utils/find-missing-workdays.ts`                            | `apps/api/src/contexts/arbeitszeitkonto/find-missing-workdays.ts`                            |
| `apps/api/src/utils/missing-entries-window.ts`                           | `apps/api/src/contexts/arbeitszeitkonto/missing-entries-window.ts`                           |
| `apps/api/src/utils/month-saldo.ts`                                      | `apps/api/src/contexts/arbeitszeitkonto/month-saldo.ts`                                      |
| `apps/api/src/utils/negative-balance-tolerance.ts`                       | `apps/api/src/contexts/arbeitszeitkonto/negative-balance-tolerance.ts`                       |
| `apps/api/src/utils/recalculate-snapshots.ts`                            | `apps/api/src/contexts/arbeitszeitkonto/recalculate-snapshots.ts`                            |
| `apps/api/src/utils/saldo-chain-classification.ts`                       | `apps/api/src/contexts/arbeitszeitkonto/saldo-chain-classification.ts`                       |
| `apps/api/src/utils/saldo-chain-integrity.ts`                            | `apps/api/src/contexts/arbeitszeitkonto/saldo-chain-integrity.ts`                            |
| `apps/api/src/utils/saldo-snapshot-cleanup.ts`                           | `apps/api/src/contexts/arbeitszeitkonto/saldo-snapshot-cleanup.ts`                           |
| `apps/api/src/utils/shift-based-saldo.ts`                                | `apps/api/src/contexts/arbeitszeitkonto/shift-based-saldo.ts`                                |
| `apps/api/src/utils/snapshot-lock.ts`                                    | `apps/api/src/contexts/arbeitszeitkonto/snapshot-lock.ts`                                    |
| `apps/api/src/utils/snapshot-period.ts`                                  | `apps/api/src/contexts/arbeitszeitkonto/snapshot-period.ts`                                  |
| `apps/api/src/utils/timezone.ts`                                         | `apps/api/src/contexts/arbeitszeitkonto/timezone.ts`                                         |
| `apps/api/src/utils/vocational-school-saldo.ts`                          | `apps/api/src/contexts/arbeitszeitkonto/vocational-school-saldo.ts`                          |
| `apps/api/src/plugins/__tests__/auto-close-month.test.ts`                | `apps/api/src/contexts/arbeitszeitkonto/plugins/__tests__/auto-close-month.test.ts`          |
| `apps/api/src/routes/__tests__/opening-balance-endpoint.test.ts`         | `apps/api/src/contexts/arbeitszeitkonto/api/__tests__/opening-balance-endpoint.test.ts`      |
| `apps/api/src/routes/__tests__/opening-balance-seeding.test.ts`          | `apps/api/src/contexts/arbeitszeitkonto/api/__tests__/opening-balance-seeding.test.ts`       |
| `apps/api/src/routes/__tests__/saldo-snapshot.test.ts`                   | `apps/api/src/contexts/arbeitszeitkonto/api/__tests__/saldo-snapshot.test.ts`                |
| `apps/api/src/utils/__tests__/calc-leave-absence-minutes-tz.test.ts`     | `apps/api/src/contexts/arbeitszeitkonto/__tests__/calc-leave-absence-minutes-tz.test.ts`     |
| `apps/api/src/utils/__tests__/carry-over-base.test.ts`                   | `apps/api/src/contexts/arbeitszeitkonto/__tests__/carry-over-base.test.ts`                   |
| `apps/api/src/utils/__tests__/find-missing-workdays.test.ts`             | `apps/api/src/contexts/arbeitszeitkonto/__tests__/find-missing-workdays.test.ts`             |
| `apps/api/src/utils/__tests__/opening-balance-model.test.ts`             | `apps/api/src/contexts/arbeitszeitkonto/__tests__/opening-balance-model.test.ts`             |
| `apps/api/src/utils/__tests__/recalculate-snapshots.test.ts`             | `apps/api/src/contexts/arbeitszeitkonto/__tests__/recalculate-snapshots.test.ts`             |
| `apps/api/src/utils/__tests__/saldo-chain-classification.test.ts`        | `apps/api/src/contexts/arbeitszeitkonto/__tests__/saldo-chain-classification.test.ts`        |
| `apps/api/src/utils/__tests__/saldo-chain-integrity-calibration.test.ts` | `apps/api/src/contexts/arbeitszeitkonto/__tests__/saldo-chain-integrity-calibration.test.ts` |
| `apps/api/src/utils/__tests__/saldo-chain-integrity.test.ts`             | `apps/api/src/contexts/arbeitszeitkonto/__tests__/saldo-chain-integrity.test.ts`             |
| `apps/api/src/utils/__tests__/shift-based-saldo.test.ts`                 | `apps/api/src/contexts/arbeitszeitkonto/__tests__/shift-based-saldo.test.ts`                 |
| `apps/api/src/utils/__tests__/snapshot-lock.test.ts`                     | `apps/api/src/contexts/arbeitszeitkonto/__tests__/snapshot-lock.test.ts`                     |
| `apps/api/src/utils/__tests__/timezone.test.ts`                          | `apps/api/src/contexts/arbeitszeitkonto/__tests__/timezone.test.ts`                          |

After this table is applied, `apps/api/src/routes/` and `apps/api/src/plugins/` are EMPTY and must
be removed. `apps/api/src/utils/` survives with exactly 4 source files and 2 tests — the `rahmen`
set, section 4: `test-database.ts`, `with-advisory-lock.ts`, `crypto.ts`, `release-notes.ts`, plus
`__tests__/release-notes.test.ts` and `__tests__/with-advisory-lock.test.ts`.

### Machine-generated flat list (as generated by the now-deleted `context-cut-move.ts`)

Originally generated by `pnpm --filter @clokr/api exec tsx scripts/context-cut-move.ts
--print-all-pairs | sort` — the exact text plan 99B-01's own proof compared against with `diff`
(section 6, P7) at every one of the six move commits. `context-cut-move.ts` is deleted (plan
99B-08); the block below is the literal snapshot of its final output, kept as the as-built record.

```
apps/api/src/plugins/__tests__/auto-close-month.test.ts -> apps/api/src/contexts/arbeitszeitkonto/plugins/__tests__/auto-close-month.test.ts
apps/api/src/plugins/attendance-checker.ts -> apps/api/src/contexts/zeiterfassung/plugins/attendance-checker.ts
apps/api/src/plugins/audit.ts -> apps/api/src/contexts/unterbau/plugins/audit.ts
apps/api/src/plugins/auto-close-month.ts -> apps/api/src/contexts/arbeitszeitkonto/plugins/auto-close-month.ts
apps/api/src/plugins/carryover-warning.ts -> apps/api/src/contexts/abwesenheiten/plugins/carryover-warning.ts
apps/api/src/plugins/data-retention.ts -> apps/api/src/contexts/unterbau/plugins/data-retention.ts
apps/api/src/plugins/mailer.ts -> apps/api/src/contexts/unterbau/plugins/mailer.ts
apps/api/src/plugins/notify.ts -> apps/api/src/contexts/unterbau/plugins/notify.ts
apps/api/src/plugins/prisma.ts -> apps/api/src/contexts/unterbau/plugins/prisma.ts
apps/api/src/plugins/scheduler.ts -> apps/api/src/contexts/schichtplanung/plugins/scheduler.ts
apps/api/src/plugins/school-holidays-sync.ts -> apps/api/src/contexts/unterbau/plugins/school-holidays-sync.ts
apps/api/src/plugins/storage.ts -> apps/api/src/contexts/unterbau/plugins/storage.ts
apps/api/src/plugins/token-cleanup.ts -> apps/api/src/contexts/unterbau/plugins/token-cleanup.ts
apps/api/src/plugins/vocational-school-generator.ts -> apps/api/src/contexts/abwesenheiten/plugins/vocational-school-generator.ts
apps/api/src/routes/__tests__/appointment-collisions.test.ts -> apps/api/src/contexts/schichtplanung/api/__tests__/appointment-collisions.test.ts
apps/api/src/routes/__tests__/arbzg.test.ts -> apps/api/src/contexts/zeiterfassung/__tests__/arbzg.test.ts
apps/api/src/routes/__tests__/availability-toggle.test.ts -> apps/api/src/contexts/schichtplanung/api/__tests__/availability-toggle.test.ts
apps/api/src/routes/__tests__/breaks.test.ts -> apps/api/src/contexts/zeiterfassung/api/__tests__/breaks.test.ts
apps/api/src/routes/__tests__/clock-in-resolver.test.ts -> apps/api/src/contexts/zeiterfassung/api/__tests__/clock-in-resolver.test.ts
apps/api/src/routes/__tests__/clock-invalid-retro.route.test.ts -> apps/api/src/contexts/zeiterfassung/api/__tests__/clock-invalid-retro.route.test.ts
apps/api/src/routes/__tests__/clock-out-break-minutes.test.ts -> apps/api/src/contexts/zeiterfassung/api/__tests__/clock-out-break-minutes.test.ts
apps/api/src/routes/__tests__/clock-out-resolver.test.ts -> apps/api/src/contexts/zeiterfassung/api/__tests__/clock-out-resolver.test.ts
apps/api/src/routes/__tests__/dashboard-overtime-trend.test.ts -> apps/api/src/composition/__tests__/dashboard-overtime-trend.test.ts
apps/api/src/routes/__tests__/dashboard.test.ts -> apps/api/src/composition/__tests__/dashboard.test.ts
apps/api/src/routes/__tests__/effective-schedule-by-date.test.ts -> apps/api/src/contexts/zeiterfassung/api/__tests__/effective-schedule-by-date.test.ts
apps/api/src/routes/__tests__/leave-characterization.test.ts -> apps/api/src/contexts/abwesenheiten/api/__tests__/leave-characterization.test.ts
apps/api/src/routes/__tests__/minijob.test.ts -> apps/api/src/contexts/unterbau/api/__tests__/minijob.test.ts
apps/api/src/routes/__tests__/nfc-punch-race.test.ts -> apps/api/src/contexts/zeiterfassung/api/__tests__/nfc-punch-race.test.ts
apps/api/src/routes/__tests__/nfc-punch-resolver.test.ts -> apps/api/src/contexts/zeiterfassung/api/__tests__/nfc-punch-resolver.test.ts
apps/api/src/routes/__tests__/nfc-punch.test.ts -> apps/api/src/contexts/zeiterfassung/api/__tests__/nfc-punch.test.ts
apps/api/src/routes/__tests__/opening-balance-endpoint.test.ts -> apps/api/src/contexts/arbeitszeitkonto/api/__tests__/opening-balance-endpoint.test.ts
apps/api/src/routes/__tests__/opening-balance-seeding.test.ts -> apps/api/src/contexts/arbeitszeitkonto/api/__tests__/opening-balance-seeding.test.ts
apps/api/src/routes/__tests__/presence-resolver.test.ts -> apps/api/src/contexts/zeiterfassung/api/__tests__/presence-resolver.test.ts
apps/api/src/routes/__tests__/reports.test.ts -> apps/api/src/composition/__tests__/reports.test.ts
apps/api/src/routes/__tests__/saldo-snapshot.test.ts -> apps/api/src/contexts/arbeitszeitkonto/api/__tests__/saldo-snapshot.test.ts
apps/api/src/routes/__tests__/schedule-type-switch-guard.test.ts -> apps/api/src/contexts/unterbau/api/__tests__/schedule-type-switch-guard.test.ts
apps/api/src/routes/__tests__/schedule-versioning.test.ts -> apps/api/src/contexts/unterbau/api/__tests__/schedule-versioning.test.ts
apps/api/src/routes/__tests__/settings-schedule.test.ts -> apps/api/src/contexts/unterbau/api/__tests__/settings-schedule.test.ts
apps/api/src/routes/__tests__/shift-arbzg.test.ts -> apps/api/src/contexts/schichtplanung/api/__tests__/shift-arbzg.test.ts
apps/api/src/routes/__tests__/shift-unavailability-soft.test.ts -> apps/api/src/contexts/schichtplanung/api/__tests__/shift-unavailability-soft.test.ts
apps/api/src/routes/__tests__/shifts-characterization.test.ts -> apps/api/src/contexts/schichtplanung/api/__tests__/shifts-characterization.test.ts
apps/api/src/routes/__tests__/shifts-my-week.test.ts -> apps/api/src/contexts/schichtplanung/api/__tests__/shifts-my-week.test.ts
apps/api/src/routes/__tests__/shifts-school-holiday.test.ts -> apps/api/src/contexts/schichtplanung/api/__tests__/shifts-school-holiday.test.ts
apps/api/src/routes/__tests__/shifts.test.ts -> apps/api/src/contexts/schichtplanung/api/__tests__/shifts.test.ts
apps/api/src/routes/__tests__/terminals.test.ts -> apps/api/src/contexts/zeiterfassung/api/__tests__/terminals.test.ts
apps/api/src/routes/__tests__/time-entries-validation.test.ts -> apps/api/src/contexts/zeiterfassung/api/__tests__/time-entries-validation.test.ts
apps/api/src/routes/__tests__/time-entries.test.ts -> apps/api/src/contexts/zeiterfassung/api/__tests__/time-entries.test.ts
apps/api/src/routes/activity.ts -> apps/api/src/contexts/unterbau/api/activity.ts
apps/api/src/routes/admin-presence-sources.ts -> apps/api/src/contexts/zeiterfassung/api/admin-presence-sources.ts
apps/api/src/routes/admin/school-holidays.ts -> apps/api/src/contexts/unterbau/api/admin/school-holidays.ts
apps/api/src/routes/api-keys.ts -> apps/api/src/contexts/unterbau/api/api-keys.ts
apps/api/src/routes/audit-logs.ts -> apps/api/src/contexts/unterbau/api/audit-logs.ts
apps/api/src/routes/auth.ts -> apps/api/src/contexts/unterbau/api/auth.ts
apps/api/src/routes/availability.ts -> apps/api/src/contexts/schichtplanung/api/availability.ts
apps/api/src/routes/avatars.ts -> apps/api/src/contexts/unterbau/api/avatars.ts
apps/api/src/routes/company-shutdowns.ts -> apps/api/src/contexts/abwesenheiten/api/company-shutdowns.ts
apps/api/src/routes/dashboard.ts -> apps/api/src/composition/dashboard.ts
apps/api/src/routes/employees.ts -> apps/api/src/contexts/unterbau/api/employees.ts
apps/api/src/routes/holidays.ts -> apps/api/src/contexts/unterbau/api/holidays.ts
apps/api/src/routes/imports.ts -> apps/api/src/contexts/unterbau/api/imports.ts
apps/api/src/routes/integrations.ts -> apps/api/src/contexts/schichtplanung/api/integrations.ts
apps/api/src/routes/invitations.ts -> apps/api/src/contexts/unterbau/api/invitations.ts
apps/api/src/routes/leave.ts -> apps/api/src/contexts/abwesenheiten/api/leave.ts
apps/api/src/routes/me.ts -> apps/api/src/contexts/unterbau/api/me.ts
apps/api/src/routes/notifications.ts -> apps/api/src/contexts/unterbau/api/notifications.ts
apps/api/src/routes/overtime.ts -> apps/api/src/contexts/arbeitszeitkonto/api/overtime.ts
apps/api/src/routes/presence.ts -> apps/api/src/contexts/zeiterfassung/api/presence.ts
apps/api/src/routes/release-notes.ts -> apps/api/src/contexts/unterbau/api/release-notes.ts
apps/api/src/routes/reports.ts -> apps/api/src/composition/reports.ts
apps/api/src/routes/retro-entry-requests.ts -> apps/api/src/contexts/zeiterfassung/api/retro-entry-requests.ts
apps/api/src/routes/section9-documents.ts -> apps/api/src/contexts/abwesenheiten/api/section9-documents.ts
apps/api/src/routes/settings.ts -> apps/api/src/contexts/unterbau/api/settings.ts
apps/api/src/routes/shift-patterns.ts -> apps/api/src/contexts/schichtplanung/api/shift-patterns.ts
apps/api/src/routes/shifts.ts -> apps/api/src/contexts/schichtplanung/api/shifts.ts
apps/api/src/routes/special-leave.ts -> apps/api/src/contexts/abwesenheiten/api/special-leave.ts
apps/api/src/routes/terminals.ts -> apps/api/src/contexts/zeiterfassung/api/terminals.ts
apps/api/src/routes/test-bootstrap.ts -> apps/api/src/contexts/unterbau/api/test-bootstrap.ts
apps/api/src/routes/time-entries.ts -> apps/api/src/contexts/zeiterfassung/api/time-entries.ts
apps/api/src/routes/vocational-school-pattern.ts -> apps/api/src/contexts/abwesenheiten/api/vocational-school-pattern.ts
apps/api/src/routes/vocational-school.ts -> apps/api/src/contexts/abwesenheiten/api/vocational-school.ts
apps/api/src/utils/__tests__/calc-leave-absence-minutes-tz.test.ts -> apps/api/src/contexts/arbeitszeitkonto/__tests__/calc-leave-absence-minutes-tz.test.ts
apps/api/src/utils/__tests__/calculate-work-days.test.ts -> apps/api/src/contexts/unterbau/__tests__/calculate-work-days.test.ts
apps/api/src/utils/__tests__/carry-over-base.test.ts -> apps/api/src/contexts/arbeitszeitkonto/__tests__/carry-over-base.test.ts
apps/api/src/utils/__tests__/find-missing-workdays.test.ts -> apps/api/src/contexts/arbeitszeitkonto/__tests__/find-missing-workdays.test.ts
apps/api/src/utils/__tests__/holidays.test.ts -> apps/api/src/contexts/unterbau/__tests__/holidays.test.ts
apps/api/src/utils/__tests__/invalid-reason.test.ts -> apps/api/src/contexts/zeiterfassung/__tests__/invalid-reason.test.ts
apps/api/src/utils/__tests__/leave-check.test.ts -> apps/api/src/contexts/abwesenheiten/__tests__/leave-check.test.ts
apps/api/src/utils/__tests__/leave-type.test.ts -> apps/api/src/contexts/abwesenheiten/__tests__/leave-type.test.ts
apps/api/src/utils/__tests__/opening-balance-model.test.ts -> apps/api/src/contexts/arbeitszeitkonto/__tests__/opening-balance-model.test.ts
apps/api/src/utils/__tests__/recalculate-snapshots.test.ts -> apps/api/src/contexts/arbeitszeitkonto/__tests__/recalculate-snapshots.test.ts
apps/api/src/utils/__tests__/saldo-chain-classification.test.ts -> apps/api/src/contexts/arbeitszeitkonto/__tests__/saldo-chain-classification.test.ts
apps/api/src/utils/__tests__/saldo-chain-integrity-calibration.test.ts -> apps/api/src/contexts/arbeitszeitkonto/__tests__/saldo-chain-integrity-calibration.test.ts
apps/api/src/utils/__tests__/saldo-chain-integrity.test.ts -> apps/api/src/contexts/arbeitszeitkonto/__tests__/saldo-chain-integrity.test.ts
apps/api/src/utils/__tests__/section9-detect.test.ts -> apps/api/src/contexts/abwesenheiten/__tests__/section9-detect.test.ts
apps/api/src/utils/__tests__/shift-based-saldo.test.ts -> apps/api/src/contexts/arbeitszeitkonto/__tests__/shift-based-saldo.test.ts
apps/api/src/utils/__tests__/shift-netto.test.ts -> apps/api/src/contexts/schichtplanung/__tests__/shift-netto.test.ts
apps/api/src/utils/__tests__/snapshot-lock.test.ts -> apps/api/src/contexts/arbeitszeitkonto/__tests__/snapshot-lock.test.ts
apps/api/src/utils/__tests__/time-arithmetic.test.ts -> apps/api/src/contexts/schichtplanung/__tests__/time-arithmetic.test.ts
apps/api/src/utils/__tests__/timezone.test.ts -> apps/api/src/contexts/arbeitszeitkonto/__tests__/timezone.test.ts
apps/api/src/utils/__tests__/vacation-calc.test.ts -> apps/api/src/contexts/abwesenheiten/__tests__/vacation-calc.test.ts
apps/api/src/utils/anonymize.ts -> apps/api/src/contexts/unterbau/anonymize.ts
apps/api/src/utils/arbzg.ts -> apps/api/src/contexts/zeiterfassung/arbzg.ts
apps/api/src/utils/audit-reason.ts -> apps/api/src/contexts/unterbau/audit-reason.ts
apps/api/src/utils/break-constants.ts -> apps/api/src/contexts/zeiterfassung/break-constants.ts
apps/api/src/utils/break-effective.ts -> apps/api/src/contexts/zeiterfassung/break-effective.ts
apps/api/src/utils/bs-slot-resolver.ts -> apps/api/src/contexts/abwesenheiten/bs-slot-resolver.ts
apps/api/src/utils/calculate-work-days.ts -> apps/api/src/contexts/unterbau/calculate-work-days.ts
apps/api/src/utils/carry-over-base.ts -> apps/api/src/contexts/arbeitszeitkonto/carry-over-base.ts
apps/api/src/utils/close-employee-month.ts -> apps/api/src/contexts/arbeitszeitkonto/close-employee-month.ts
apps/api/src/utils/close-month-data.ts -> apps/api/src/contexts/arbeitszeitkonto/close-month-data.ts
apps/api/src/utils/confirmed-saldo.ts -> apps/api/src/contexts/arbeitszeitkonto/confirmed-saldo.ts
apps/api/src/utils/correction-lock.ts -> apps/api/src/contexts/abwesenheiten/correction-lock.ts
apps/api/src/utils/federal-state-iso.ts -> apps/api/src/contexts/unterbau/federal-state-iso.ts
apps/api/src/utils/find-karenz-overrun-days.ts -> apps/api/src/contexts/abwesenheiten/find-karenz-overrun-days.ts
apps/api/src/utils/find-missing-workdays.ts -> apps/api/src/contexts/arbeitszeitkonto/find-missing-workdays.ts
apps/api/src/utils/find-unconfirmed-break-days.ts -> apps/api/src/contexts/zeiterfassung/find-unconfirmed-break-days.ts
apps/api/src/utils/format-hm.ts -> apps/api/src/contexts/abwesenheiten/format-hm.ts
apps/api/src/utils/get-current-shift.ts -> apps/api/src/contexts/schichtplanung/get-current-shift.ts
apps/api/src/utils/holidays.ts -> apps/api/src/contexts/unterbau/holidays.ts
apps/api/src/utils/ical.ts -> apps/api/src/contexts/abwesenheiten/ical.ts
apps/api/src/utils/illness-carryover-guard.ts -> apps/api/src/contexts/abwesenheiten/illness-carryover-guard.ts
apps/api/src/utils/invalid-reason.ts -> apps/api/src/contexts/zeiterfassung/invalid-reason.ts
apps/api/src/utils/jarbschg.ts -> apps/api/src/contexts/abwesenheiten/jarbschg.ts
apps/api/src/utils/leave-check.ts -> apps/api/src/contexts/abwesenheiten/leave-check.ts
apps/api/src/utils/leave-self-heal.ts -> apps/api/src/contexts/abwesenheiten/leave-self-heal.ts
apps/api/src/utils/leave-type.ts -> apps/api/src/contexts/abwesenheiten/leave-type.ts
apps/api/src/utils/load-bs-slot-overrides.ts -> apps/api/src/contexts/abwesenheiten/load-bs-slot-overrides.ts
apps/api/src/utils/missing-entries-window.ts -> apps/api/src/contexts/arbeitszeitkonto/missing-entries-window.ts
apps/api/src/utils/month-first-date.ts -> apps/api/src/contexts/unterbau/month-first-date.ts
apps/api/src/utils/month-saldo.ts -> apps/api/src/contexts/arbeitszeitkonto/month-saldo.ts
apps/api/src/utils/negative-balance-tolerance.ts -> apps/api/src/contexts/arbeitszeitkonto/negative-balance-tolerance.ts
apps/api/src/utils/normalize-mac.ts -> apps/api/src/contexts/zeiterfassung/normalize-mac.ts
apps/api/src/utils/notification-email-policy.ts -> apps/api/src/contexts/unterbau/notification-email-policy.ts
apps/api/src/utils/password-policy.ts -> apps/api/src/contexts/unterbau/password-policy.ts
apps/api/src/utils/pdf.ts -> apps/api/src/composition/pdf.ts
apps/api/src/utils/presence.ts -> apps/api/src/contexts/zeiterfassung/presence.ts
apps/api/src/utils/recalculate-snapshots.ts -> apps/api/src/contexts/arbeitszeitkonto/recalculate-snapshots.ts
apps/api/src/utils/retro-config.ts -> apps/api/src/contexts/zeiterfassung/retro-config.ts
apps/api/src/utils/saldo-chain-classification.ts -> apps/api/src/contexts/arbeitszeitkonto/saldo-chain-classification.ts
apps/api/src/utils/saldo-chain-integrity.ts -> apps/api/src/contexts/arbeitszeitkonto/saldo-chain-integrity.ts
apps/api/src/utils/saldo-snapshot-cleanup.ts -> apps/api/src/contexts/arbeitszeitkonto/saldo-snapshot-cleanup.ts
apps/api/src/utils/school-holidays-client.ts -> apps/api/src/contexts/unterbau/school-holidays-client.ts
apps/api/src/utils/section9-credit-days.ts -> apps/api/src/contexts/abwesenheiten/section9-credit-days.ts
apps/api/src/utils/section9-detect.ts -> apps/api/src/contexts/abwesenheiten/section9-detect.ts
apps/api/src/utils/shift-availability.ts -> apps/api/src/contexts/schichtplanung/shift-availability.ts
apps/api/src/utils/shift-based-saldo.ts -> apps/api/src/contexts/arbeitszeitkonto/shift-based-saldo.ts
apps/api/src/utils/shift-cleanup.ts -> apps/api/src/contexts/schichtplanung/shift-cleanup.ts
apps/api/src/utils/shift-leave-recalc-resolver.ts -> apps/api/src/contexts/abwesenheiten/shift-leave-recalc-resolver.ts
apps/api/src/utils/shift-netto.ts -> apps/api/src/contexts/schichtplanung/shift-netto.ts
apps/api/src/utils/snapshot-lock.ts -> apps/api/src/contexts/arbeitszeitkonto/snapshot-lock.ts
apps/api/src/utils/snapshot-period.ts -> apps/api/src/contexts/arbeitszeitkonto/snapshot-period.ts
apps/api/src/utils/tenant-availability.ts -> apps/api/src/contexts/schichtplanung/tenant-availability.ts
apps/api/src/utils/time-arithmetic.ts -> apps/api/src/contexts/schichtplanung/time-arithmetic.ts
apps/api/src/utils/timezone.ts -> apps/api/src/contexts/arbeitszeitkonto/timezone.ts
apps/api/src/utils/vacation-calc.ts -> apps/api/src/contexts/abwesenheiten/vacation-calc.ts
apps/api/src/utils/vocational-school-constants.ts -> apps/api/src/contexts/abwesenheiten/vocational-school-constants.ts
apps/api/src/utils/vocational-school-generator.ts -> apps/api/src/contexts/abwesenheiten/vocational-school-generator.ts
apps/api/src/utils/vocational-school-pattern-order.ts -> apps/api/src/contexts/abwesenheiten/vocational-school-pattern-order.ts
apps/api/src/utils/vocational-school-saldo.ts -> apps/api/src/contexts/arbeitszeitkonto/vocational-school-saldo.ts
```

---

## 3. Move order, and why

`komposition` (0 in-edges) → `schichtplanung` → `unterbau` → `zeiterfassung` → `abwesenheiten` →
`arbeitszeitkonto` (most entangled: 17 internal edges plus 16 edges from operator scripts).

Measured by a full DFS over the 109-file graph, not sampled: **zero import cycles**. That is what
makes a strict linear order possible at all — if two contexts imported each other, no single-file
ordering could avoid a mid-sequence broken build.

One context per commit; the full suite plus the D-01 saldo golden run after each (D-09/D-10) — never
batched to the end of the phase. A defect introduced while moving context 2 and only discovered
after context 6 costs the whole point of splitting the work into six commits: a place to fall back
to.

## 4. What deliberately does NOT move

- **The four `rahmen` files stay at `apps/api/src/utils/`** (D-16): `test-database.ts`,
  `with-advisory-lock.ts`, `crypto.ts`, `release-notes.ts`. They are framework/test infrastructure,
  not business context.
  - `test-database.ts` has 14 external importers, all outside this phase's scope, and CLAUDE.md
    names it the sole place the test-DB name pattern/marker/worker-count may be stated.
  - `release-notes.ts` carries a depth-sensitive `resolve(__dirname, "../../../../docs/release-notes")`
    at line 63 AND is required by a literal `require('./dist/utils/release-notes')` in
    `apps/api/Dockerfile:221` — moving it would break the image build.
  - This is **NOT a Restkategorie** (residual/catch-all bucket). `rahmen` is an ENUMERATED allowlist
    in `apps/api/scripts/context-area-map.ts`'s `CONTEXT_AREA_BY_FILE`, guarded by a test that
    asserts no route and no plugin may ever be classified `rahmen` — the category is defined by the
    map, not by which directory a file happens to sit in.

- **`apps/api/src/services/clock/` and `apps/api/src/services/phorest/` stay where they are** (D-17).
  After this phase, Zeiterfassung lives in BOTH `contexts/zeiterfassung/` and `services/clock/`, and
  Schichtplanung in BOTH `contexts/schichtplanung/` and `services/phorest/`. Issue #99 names these
  two directories "the only places already cut along business lines — the model, not the exception".
  Moving them under `contexts/` is separate work with its own risk; the two-tree split for these two
  contexts is deliberate and temporary, recorded here so the next person who touches either
  directory recognizes it as intent, not an oversight.

- **`apps/api/src/__tests__/` (the ~160 centralized test files) stays put.** Only the import
  specifiers INSIDE those files are rewritten when they reference a moved file. Moving the files
  themselves would require classifying each one by business context, which is reorganization, not
  relocation, and out of this phase's pure-move scope (D-05).

## 5. The tool-sync checklist

Six artefacts are addressed by hard-wired path and MUST be updated in the SAME commit as the files
they name — a move commit that leaves one of them stale either goes red with a false finding, or,
worse, goes green with a disarmed control.

| Artefact                                                                                                                                | What breaks                                                                                                               | Loud or silent                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/scripts/lint-tenant-scoping-types.ts` `SCOPED_DIRS`                                                                           | scope points at a directory that no longer exists (or has fewer files than before)                                        | LOUD since plan 99B-01's Guard A/B — SILENT before it (GitHub #229)                                                                         |
| `apps/api/scripts/lint-tenant-scoping-exceptions.json` (`file` field, 23 entries across 10 files)                                       | every exception on a moved file's `file` stops matching; the gate reports an already-reviewed call as a brand-new finding | LOUD, but looks exactly like a real security finding — this is the #227-merge failure mode                                                  |
| `apps/api/scripts/context-area-map.ts` (`CONTEXT_AREA_BY_FILE` keys)                                                                    | `UnmappedFileError` thrown by `assignContextArea`                                                                         | LOUD                                                                                                                                        |
| `apps/api/scripts/__tests__/context-area-map.test.ts` + `apps/api/scripts/__tests__/measure-context-coverage.test.ts`                   | literal `src/routes/...` path assertions go stale                                                                         | LOUD                                                                                                                                        |
| `scripts/lint-comment-language-baseline.json` (224 entries, repo-relative path is the key's first segment)                              | every baselined German comment in a moved file reports as a brand-new violation                                           | LOUD                                                                                                                                        |
| `apps/api/scripts/measure-saldo-path-parity.ts:540-544` (4 of its 5 string-literal dynamic `import()`s point at files that move — D-19) | D-01's OWN proof tool throws `MODULE_NOT_FOUND` at runtime                                                                | LOUD only if `--check` is actually run — a forgotten path here disables the one tool that says WHAT differs, not merely that something does |

### `SCOPED_DIRS`'s final shape

`apps/api/scripts/lint-tenant-scoping-types.ts`'s `SCOPED_DIRS` grew by one entry per wave as each
context landed (plan 99B-01 through 99B-07) and reached its final, permanent seven-entry shape in
plan 99B-07, the commit that removed `apps/api/src/routes` for good:

```
apps/api/src/contexts/unterbau/api
apps/api/src/contexts/zeiterfassung/api
apps/api/src/contexts/abwesenheiten/api
apps/api/src/contexts/schichtplanung/api
apps/api/src/contexts/arbeitszeitkonto/api
apps/api/src/composition
apps/api/src/services
```

`apps/api/src/routes` — the eighth, pre-move entry — is gone, not merely renamed: plugins and every
context's flat non-`api/` files were never separately scanned by this gate (it only inspects each
context's `api/` subdirectory, plus `composition` and `services`), so there is no eighth successor
entry to add.

The #229 null guard (`MissingScopedDirError`) was DEMONSTRATED firing on exactly this failure mode
in plan 99B-07: `apps/api/src/routes` was temporarily restored as `SCOPED_DIRS[7]` after the
directory it names had already been deleted, `lint:tenant-scoping` was run, and it threw
`MissingScopedDirError` with a non-zero exit naming the missing directory — instead of the
pre-#229 behavior, which would have silently reported `0 in-scope call(s) ... OK` and exited 0. The
restored entry was then reverted from a pre-edit backup; the clean re-run reproduced the equality
baseline `485 in-scope call(s), 197 candidate(s) ... 53 exception(s) applied, 0 finding(s).`
byte-for-byte. This is the only wave in the phase where that exact trigger condition — a
`SCOPED_DIRS` entry naming a directory this phase has just deleted — could be reproduced for real,
because it is the wave where the directory actually disappeared.

## 6. Proof obligations

The commands every move plan (99B-02..07) runs, in order, with the exact expected output. Steps
that touch the per-worker test database (the full suite, and the saldo `--check`) must never
overlap — run one to completion before starting the other.

| #   | Command                                                                                                                                            | Expected                                                                                                                                                                                                                                                                                                                                                                    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | `pnpm --filter @clokr/api typecheck`                                                                                                               | exit 0                                                                                                                                                                                                                                                                                                                                                                      |
| P2  | `pnpm --filter @clokr/api exec eslint src/ --no-warn-ignored`                                                                                      | exit 0                                                                                                                                                                                                                                                                                                                                                                      |
| P3  | `npx prettier --check "apps/api/src/**/*.ts"`                                                                                                      | exit 0                                                                                                                                                                                                                                                                                                                                                                      |
| P4  | `pnpm --filter @clokr/api run lint:import-targets`                                                                                                 | exit 0                                                                                                                                                                                                                                                                                                                                                                      |
| P5  | `pnpm --filter @clokr/api run lint:tenant-scoping`                                                                                                 | exactly `485 in-scope call(s), 197 candidate(s) after the D-14 filter (inline-tenant-id: 46, inline-principal-field: 2, inline-relation-filter: 6, fetch-then-compare: 74, guard-fetch: 16), 53 exception(s) applied, 0 finding(s).` and exit 0 — **equality, never bare exit 0** (D-25): a gate whose `SCOPED_DIRS` lost an entry also exits 0, only the number reveals it |
| P6  | `pnpm run lint:comment-language`                                                                                                                   | `New: 0 violation(s)`, baseline still exactly 224 entries                                                                                                                                                                                                                                                                                                                   |
| P7  | `pnpm --filter @clokr/api test`, then the exact-count check against `MIN_FILES`/`MIN_TESTS` (249 / the value plan 99B-01 recorded, currently 2839) | green; files and tests EQUAL the recorded floor, not merely `>=` — fewer means tests were lost in the move, more means something was added that does not belong in a pure move                                                                                                                                                                                              |
| P8  | `pnpm --filter @clokr/api run test:setup && pnpm --filter @clokr/api exec tsx scripts/measure-saldo-path-parity.ts --check`                        | exit 0 — byte-identical against `apps/api/baselines/saldo-path-parity-baseline.json`; if it exits 2, the printed diff (scenario, path, field, before/after) IS the finding — never regenerate the baseline to make it green                                                                                                                                                 |
| P9  | `git log --follow --oneline <a moved file>`                                                                                                        | more than one entry, reaching back past the move commit (D-03)                                                                                                                                                                                                                                                                                                              |

An additional literal-agreement proof, specific to plan 99B-01 (Wave 1) rather than to each move
plan, ran at every one of the six move commits: `pnpm --filter @clokr/api exec tsx
scripts/context-cut-move.ts --print-all-pairs | sort` and a `grep -oE` extraction of this
document's own machine-generated block above, `diff`ed, printed nothing. `context-cut-move.ts` is
deleted (plan 99B-08); the block above is the final `--print-all-pairs` output, preserved as the
as-built record.

## 7. What this phase deliberately did NOT do

Pure move, nothing more (D-05). Named here so the next reader recognizes each as intent, not an
oversight left for them to clean up:

- **No context facades.** No `contexts/<context>/index.ts` — that's #100. Everything a route or
  plugin needs from another context is still imported by its concrete file path.
- **No machine-enforced boundaries.** Nothing stops a file in one context from importing another
  context's internals today — that's #101 (`eslint-plugin-boundaries` works on file paths, so it
  will slot in on top of this tree without another move, per D-15's finding).
- **No inner layering beyond the obvious.** `domain/`, `application/`, `infrastructure/`, `events/`
  — the target picture issue #99 sketches — were NOT created. Only the two splits that were
  unambiguous (a route → `api/`, a plugin → `plugins/`) were made; everything else lies flat in the
  context root (D-05).
- **`apps/api/src/__tests__/` (~160 centralized test files) was left in place**, uncategorized by
  context. Only the import specifiers inside those files were rewritten.
- **`apps/api/src/services/clock/` and `apps/api/src/services/phorest/` did not move** (D-17,
  section 4) — Zeiterfassung and Schichtplanung each now span two top-level trees, a deliberate and
  temporary split recorded in `docs/adr/0001-abweichungen.md`.
- **No documentation sweep beyond this document and the ADR entry above.** `CLAUDE.md` carries 26
  path references into the old `routes/`/`utils/`/`plugins/` layout (24 of which now point at
  moved files), and 14 further files under `docs/` carry at least one stale reference each. These
  are filed as a follow-up issue (99B-08, Task 2e) rather than fixed here, to keep this phase's own
  diff a pure move end to end; `CLAUDE.md`'s own edits additionally needed the project owner's
  sign-off (99B-08, Task 3), since it is the project's governing document.
