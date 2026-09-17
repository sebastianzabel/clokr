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

## 0. Directory naming (D-27/D-28)

The five business-context directories under `apps/api/src/contexts/` carry **English** names — a
follow-up commit (99b-09) renamed them after the move itself had landed, so the move diff and the
rename diff stay separately reviewable (D-29). `CLAUDE.md` § Language requires English for code,
and directory names are identifiers, not user-facing text; the rest of the tree (`contexts`,
`composition`, `services`, `api`, `plugins`) was already English, so a path like
`contexts/abwesenheiten/api/leave.ts` switched language mid-path.

The Fachbegriff (used throughout this document, ADR 0001 and the tickets) and the directory it maps
to diverge on purpose — German domain vocabulary stays in prose, only the identifier changed:

| Kontext (Fachsprache) | Verzeichnis                                   |
| --------------------- | --------------------------------------------- |
| Unterbau              | `apps/api/src/contexts/platform/`             |
| Zeiterfassung         | `apps/api/src/contexts/time-tracking/`        |
| Abwesenheiten         | `apps/api/src/contexts/absence/`              |
| Schichtplanung        | `apps/api/src/contexts/scheduling/`           |
| Arbeitszeitkonto      | `apps/api/src/contexts/working-time-account/` |

Everywhere else below, section headings and prose keep the Fachbegriff (`### schichtplanung
(99B-03)`, "Zeiterfassung", …) exactly as phase 99b wrote them — only concrete file paths were
updated to the English directory names. Use the table above to translate between the two.

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

| from                                                              | to                                                                                 |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `apps/api/src/routes/availability.ts`                             | `apps/api/src/contexts/scheduling/api/availability.ts`                             |
| `apps/api/src/routes/integrations.ts`                             | `apps/api/src/contexts/scheduling/api/integrations.ts`                             |
| `apps/api/src/routes/shift-patterns.ts`                           | `apps/api/src/contexts/scheduling/api/shift-patterns.ts`                           |
| `apps/api/src/routes/shifts.ts`                                   | `apps/api/src/contexts/scheduling/api/shifts.ts`                                   |
| `apps/api/src/plugins/scheduler.ts`                               | `apps/api/src/contexts/scheduling/plugins/scheduler.ts`                            |
| `apps/api/src/utils/get-current-shift.ts`                         | `apps/api/src/contexts/scheduling/get-current-shift.ts`                            |
| `apps/api/src/utils/shift-availability.ts`                        | `apps/api/src/contexts/scheduling/shift-availability.ts`                           |
| `apps/api/src/utils/shift-cleanup.ts`                             | `apps/api/src/contexts/scheduling/shift-cleanup.ts`                                |
| `apps/api/src/utils/shift-netto.ts`                               | `apps/api/src/contexts/scheduling/shift-netto.ts`                                  |
| `apps/api/src/utils/tenant-availability.ts`                       | `apps/api/src/contexts/scheduling/tenant-availability.ts`                          |
| `apps/api/src/utils/time-arithmetic.ts`                           | `apps/api/src/contexts/scheduling/time-arithmetic.ts`                              |
| `apps/api/src/routes/__tests__/appointment-collisions.test.ts`    | `apps/api/src/contexts/scheduling/api/__tests__/appointment-collisions.test.ts`    |
| `apps/api/src/routes/__tests__/availability-toggle.test.ts`       | `apps/api/src/contexts/scheduling/api/__tests__/availability-toggle.test.ts`       |
| `apps/api/src/routes/__tests__/shift-arbzg.test.ts`               | `apps/api/src/contexts/scheduling/api/__tests__/shift-arbzg.test.ts`               |
| `apps/api/src/routes/__tests__/shift-unavailability-soft.test.ts` | `apps/api/src/contexts/scheduling/api/__tests__/shift-unavailability-soft.test.ts` |
| `apps/api/src/routes/__tests__/shifts-characterization.test.ts`   | `apps/api/src/contexts/scheduling/api/__tests__/shifts-characterization.test.ts`   |
| `apps/api/src/routes/__tests__/shifts-my-week.test.ts`            | `apps/api/src/contexts/scheduling/api/__tests__/shifts-my-week.test.ts`            |
| `apps/api/src/routes/__tests__/shifts-school-holiday.test.ts`     | `apps/api/src/contexts/scheduling/api/__tests__/shifts-school-holiday.test.ts`     |
| `apps/api/src/routes/__tests__/shifts.test.ts`                    | `apps/api/src/contexts/scheduling/api/__tests__/shifts.test.ts`                    |
| `apps/api/src/utils/__tests__/shift-netto.test.ts`                | `apps/api/src/contexts/scheduling/__tests__/shift-netto.test.ts`                   |
| `apps/api/src/utils/__tests__/time-arithmetic.test.ts`            | `apps/api/src/contexts/scheduling/__tests__/time-arithmetic.test.ts`               |

**services/phorest/ does NOT move** (D-17, section 4) — but `services/phorest/sync-shifts.ts`
imports `utils/time-arithmetic.ts`, so ITS import specifier is rewritten to point at
`contexts/scheduling/time-arithmetic.ts` even though `sync-shifts.ts` itself stays put.

### unterbau (99B-04) — 32 source (15 routes incl. nested `admin/`, 8 plugins, 9 utils) + 6 test

| from                                                               | to                                                                                |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `apps/api/src/routes/activity.ts`                                  | `apps/api/src/contexts/platform/api/activity.ts`                                  |
| `apps/api/src/routes/api-keys.ts`                                  | `apps/api/src/contexts/platform/api/api-keys.ts`                                  |
| `apps/api/src/routes/audit-logs.ts`                                | `apps/api/src/contexts/platform/api/audit-logs.ts`                                |
| `apps/api/src/routes/auth.ts`                                      | `apps/api/src/contexts/platform/api/auth.ts`                                      |
| `apps/api/src/routes/avatars.ts`                                   | `apps/api/src/contexts/platform/api/avatars.ts`                                   |
| `apps/api/src/routes/employees.ts`                                 | `apps/api/src/contexts/platform/api/employees.ts`                                 |
| `apps/api/src/routes/holidays.ts`                                  | `apps/api/src/contexts/platform/api/holidays.ts`                                  |
| `apps/api/src/routes/imports.ts`                                   | `apps/api/src/contexts/platform/api/imports.ts`                                   |
| `apps/api/src/routes/invitations.ts`                               | `apps/api/src/contexts/platform/api/invitations.ts`                               |
| `apps/api/src/routes/me.ts`                                        | `apps/api/src/contexts/platform/api/me.ts`                                        |
| `apps/api/src/routes/notifications.ts`                             | `apps/api/src/contexts/platform/api/notifications.ts`                             |
| `apps/api/src/routes/release-notes.ts`                             | `apps/api/src/contexts/platform/api/release-notes.ts`                             |
| `apps/api/src/routes/settings.ts`                                  | `apps/api/src/contexts/platform/api/settings.ts`                                  |
| `apps/api/src/routes/test-bootstrap.ts`                            | `apps/api/src/contexts/platform/api/test-bootstrap.ts`                            |
| `apps/api/src/routes/admin/school-holidays.ts`                     | `apps/api/src/contexts/platform/api/admin/school-holidays.ts`                     |
| `apps/api/src/plugins/audit.ts`                                    | `apps/api/src/contexts/platform/plugins/audit.ts`                                 |
| `apps/api/src/plugins/data-retention.ts`                           | `apps/api/src/contexts/platform/plugins/data-retention.ts`                        |
| `apps/api/src/plugins/mailer.ts`                                   | `apps/api/src/contexts/platform/plugins/mailer.ts`                                |
| `apps/api/src/plugins/notify.ts`                                   | `apps/api/src/contexts/platform/plugins/notify.ts`                                |
| `apps/api/src/plugins/prisma.ts`                                   | `apps/api/src/contexts/platform/plugins/prisma.ts`                                |
| `apps/api/src/plugins/school-holidays-sync.ts`                     | `apps/api/src/contexts/platform/plugins/school-holidays-sync.ts`                  |
| `apps/api/src/plugins/storage.ts`                                  | `apps/api/src/contexts/platform/plugins/storage.ts`                               |
| `apps/api/src/plugins/token-cleanup.ts`                            | `apps/api/src/contexts/platform/plugins/token-cleanup.ts`                         |
| `apps/api/src/utils/anonymize.ts`                                  | `apps/api/src/contexts/platform/anonymize.ts`                                     |
| `apps/api/src/utils/audit-reason.ts`                               | `apps/api/src/contexts/platform/audit-reason.ts`                                  |
| `apps/api/src/utils/calculate-work-days.ts`                        | `apps/api/src/contexts/platform/calculate-work-days.ts`                           |
| `apps/api/src/utils/federal-state-iso.ts`                          | `apps/api/src/contexts/platform/federal-state-iso.ts`                             |
| `apps/api/src/utils/holidays.ts`                                   | `apps/api/src/contexts/platform/holidays.ts`                                      |
| `apps/api/src/utils/month-first-date.ts`                           | `apps/api/src/contexts/platform/month-first-date.ts`                              |
| `apps/api/src/utils/notification-email-policy.ts`                  | `apps/api/src/contexts/platform/notification-email-policy.ts`                     |
| `apps/api/src/utils/password-policy.ts`                            | `apps/api/src/contexts/platform/password-policy.ts`                               |
| `apps/api/src/utils/school-holidays-client.ts`                     | `apps/api/src/contexts/platform/school-holidays-client.ts`                        |
| `apps/api/src/routes/__tests__/minijob.test.ts`                    | `apps/api/src/contexts/platform/api/__tests__/minijob.test.ts`                    |
| `apps/api/src/routes/__tests__/schedule-type-switch-guard.test.ts` | `apps/api/src/contexts/platform/api/__tests__/schedule-type-switch-guard.test.ts` |
| `apps/api/src/routes/__tests__/schedule-versioning.test.ts`        | `apps/api/src/contexts/platform/api/__tests__/schedule-versioning.test.ts`        |
| `apps/api/src/routes/__tests__/settings-schedule.test.ts`          | `apps/api/src/contexts/platform/api/__tests__/settings-schedule.test.ts`          |
| `apps/api/src/utils/__tests__/calculate-work-days.test.ts`         | `apps/api/src/contexts/platform/__tests__/calculate-work-days.test.ts`            |
| `apps/api/src/utils/__tests__/holidays.test.ts`                    | `apps/api/src/contexts/platform/__tests__/holidays.test.ts`                       |

**Two different `release-notes.ts` files exist.** `routes/release-notes.ts` is Unterbau and MOVES
(the table above). `utils/release-notes.ts` is bucket `rahmen` and does NOT move — see section 4.
Do not confuse the two when reading a diff.

**`routes/holidays.ts` and `utils/holidays.ts` both exist and both move**, to
`contexts/platform/api/holidays.ts` and `contexts/platform/holidays.ts` respectively — no collision
(different subdirectories), no rename (D-13 forbids one).

### zeiterfassung (99B-05) — 14 source (5 routes, 1 plugin, 8 utils) + 15 test

| from                                                               | to                                                                                     |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `apps/api/src/routes/admin-presence-sources.ts`                    | `apps/api/src/contexts/time-tracking/api/admin-presence-sources.ts`                    |
| `apps/api/src/routes/presence.ts`                                  | `apps/api/src/contexts/time-tracking/api/presence.ts`                                  |
| `apps/api/src/routes/retro-entry-requests.ts`                      | `apps/api/src/contexts/time-tracking/api/retro-entry-requests.ts`                      |
| `apps/api/src/routes/terminals.ts`                                 | `apps/api/src/contexts/time-tracking/api/terminals.ts`                                 |
| `apps/api/src/routes/time-entries.ts`                              | `apps/api/src/contexts/time-tracking/api/time-entries.ts`                              |
| `apps/api/src/plugins/attendance-checker.ts`                       | `apps/api/src/contexts/time-tracking/plugins/attendance-checker.ts`                    |
| `apps/api/src/utils/arbzg.ts`                                      | `apps/api/src/contexts/time-tracking/arbzg.ts`                                         |
| `apps/api/src/utils/break-constants.ts`                            | `apps/api/src/contexts/time-tracking/break-constants.ts`                               |
| `apps/api/src/utils/break-effective.ts`                            | `apps/api/src/contexts/time-tracking/break-effective.ts`                               |
| `apps/api/src/utils/find-unconfirmed-break-days.ts`                | `apps/api/src/contexts/time-tracking/find-unconfirmed-break-days.ts`                   |
| `apps/api/src/utils/invalid-reason.ts`                             | `apps/api/src/contexts/time-tracking/invalid-reason.ts`                                |
| `apps/api/src/utils/normalize-mac.ts`                              | `apps/api/src/contexts/time-tracking/normalize-mac.ts`                                 |
| `apps/api/src/utils/presence.ts`                                   | `apps/api/src/contexts/time-tracking/presence.ts`                                      |
| `apps/api/src/utils/retro-config.ts`                               | `apps/api/src/contexts/time-tracking/retro-config.ts`                                  |
| `apps/api/src/routes/__tests__/arbzg.test.ts`                      | `apps/api/src/contexts/time-tracking/__tests__/arbzg.test.ts`                          |
| `apps/api/src/utils/__tests__/invalid-reason.test.ts`              | `apps/api/src/contexts/time-tracking/__tests__/invalid-reason.test.ts`                 |
| `apps/api/src/routes/__tests__/breaks.test.ts`                     | `apps/api/src/contexts/time-tracking/api/__tests__/breaks.test.ts`                     |
| `apps/api/src/routes/__tests__/clock-in-resolver.test.ts`          | `apps/api/src/contexts/time-tracking/api/__tests__/clock-in-resolver.test.ts`          |
| `apps/api/src/routes/__tests__/clock-invalid-retro.route.test.ts`  | `apps/api/src/contexts/time-tracking/api/__tests__/clock-invalid-retro.route.test.ts`  |
| `apps/api/src/routes/__tests__/clock-out-break-minutes.test.ts`    | `apps/api/src/contexts/time-tracking/api/__tests__/clock-out-break-minutes.test.ts`    |
| `apps/api/src/routes/__tests__/clock-out-resolver.test.ts`         | `apps/api/src/contexts/time-tracking/api/__tests__/clock-out-resolver.test.ts`         |
| `apps/api/src/routes/__tests__/effective-schedule-by-date.test.ts` | `apps/api/src/contexts/time-tracking/api/__tests__/effective-schedule-by-date.test.ts` |
| `apps/api/src/routes/__tests__/nfc-punch-race.test.ts`             | `apps/api/src/contexts/time-tracking/api/__tests__/nfc-punch-race.test.ts`             |
| `apps/api/src/routes/__tests__/nfc-punch-resolver.test.ts`         | `apps/api/src/contexts/time-tracking/api/__tests__/nfc-punch-resolver.test.ts`         |
| `apps/api/src/routes/__tests__/nfc-punch.test.ts`                  | `apps/api/src/contexts/time-tracking/api/__tests__/nfc-punch.test.ts`                  |
| `apps/api/src/routes/__tests__/presence-resolver.test.ts`          | `apps/api/src/contexts/time-tracking/api/__tests__/presence-resolver.test.ts`          |
| `apps/api/src/routes/__tests__/terminals.test.ts`                  | `apps/api/src/contexts/time-tracking/api/__tests__/terminals.test.ts`                  |
| `apps/api/src/routes/__tests__/time-entries-validation.test.ts`    | `apps/api/src/contexts/time-tracking/api/__tests__/time-entries-validation.test.ts`    |
| `apps/api/src/routes/__tests__/time-entries.test.ts`               | `apps/api/src/contexts/time-tracking/api/__tests__/time-entries.test.ts`               |

**`routes/presence.ts` and `utils/presence.ts` both exist and both move**, to
`contexts/time-tracking/api/presence.ts` and `contexts/time-tracking/presence.ts` — same pattern as
`holidays.ts` above, no collision, no rename.

**`routes/__tests__/arbzg.test.ts` moves to the context ROOT `__tests__/`, not `api/__tests__/`** —
it imports `../utils/arbzg` and is a utility test that happened to live under `routes/__tests__`
(D-07: co-located with its SUBJECT, not with the directory it historically sat in).

### abwesenheiten (99B-06) — 26 source (6 routes, 2 plugins, 18 utils) + 5 test

| from                                                           | to                                                                           |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `apps/api/src/routes/company-shutdowns.ts`                     | `apps/api/src/contexts/absence/api/company-shutdowns.ts`                     |
| `apps/api/src/routes/leave.ts`                                 | `apps/api/src/contexts/absence/api/leave.ts`                                 |
| `apps/api/src/routes/section9-documents.ts`                    | `apps/api/src/contexts/absence/api/section9-documents.ts`                    |
| `apps/api/src/routes/special-leave.ts`                         | `apps/api/src/contexts/absence/api/special-leave.ts`                         |
| `apps/api/src/routes/vocational-school-pattern.ts`             | `apps/api/src/contexts/absence/api/vocational-school-pattern.ts`             |
| `apps/api/src/routes/vocational-school.ts`                     | `apps/api/src/contexts/absence/api/vocational-school.ts`                     |
| `apps/api/src/plugins/carryover-warning.ts`                    | `apps/api/src/contexts/absence/plugins/carryover-warning.ts`                 |
| `apps/api/src/plugins/vocational-school-generator.ts`          | `apps/api/src/contexts/absence/plugins/vocational-school-generator.ts`       |
| `apps/api/src/utils/bs-slot-resolver.ts`                       | `apps/api/src/contexts/absence/bs-slot-resolver.ts`                          |
| `apps/api/src/utils/correction-lock.ts`                        | `apps/api/src/contexts/absence/correction-lock.ts`                           |
| `apps/api/src/utils/find-karenz-overrun-days.ts`               | `apps/api/src/contexts/absence/find-karenz-overrun-days.ts`                  |
| `apps/api/src/utils/format-hm.ts`                              | `apps/api/src/contexts/absence/format-hm.ts`                                 |
| `apps/api/src/utils/ical.ts`                                   | `apps/api/src/contexts/absence/ical.ts`                                      |
| `apps/api/src/utils/illness-carryover-guard.ts`                | `apps/api/src/contexts/absence/illness-carryover-guard.ts`                   |
| `apps/api/src/utils/jarbschg.ts`                               | `apps/api/src/contexts/absence/jarbschg.ts`                                  |
| `apps/api/src/utils/leave-check.ts`                            | `apps/api/src/contexts/absence/leave-check.ts`                               |
| `apps/api/src/utils/leave-self-heal.ts`                        | `apps/api/src/contexts/absence/leave-self-heal.ts`                           |
| `apps/api/src/utils/leave-type.ts`                             | `apps/api/src/contexts/absence/leave-type.ts`                                |
| `apps/api/src/utils/load-bs-slot-overrides.ts`                 | `apps/api/src/contexts/absence/load-bs-slot-overrides.ts`                    |
| `apps/api/src/utils/section9-credit-days.ts`                   | `apps/api/src/contexts/absence/section9-credit-days.ts`                      |
| `apps/api/src/utils/section9-detect.ts`                        | `apps/api/src/contexts/absence/section9-detect.ts`                           |
| `apps/api/src/utils/shift-leave-recalc-resolver.ts`            | `apps/api/src/contexts/absence/shift-leave-recalc-resolver.ts`               |
| `apps/api/src/utils/vacation-calc.ts`                          | `apps/api/src/contexts/absence/vacation-calc.ts`                             |
| `apps/api/src/utils/vocational-school-constants.ts`            | `apps/api/src/contexts/absence/vocational-school-constants.ts`               |
| `apps/api/src/utils/vocational-school-generator.ts`            | `apps/api/src/contexts/absence/vocational-school-generator.ts`               |
| `apps/api/src/utils/vocational-school-pattern-order.ts`        | `apps/api/src/contexts/absence/vocational-school-pattern-order.ts`           |
| `apps/api/src/routes/__tests__/leave-characterization.test.ts` | `apps/api/src/contexts/absence/api/__tests__/leave-characterization.test.ts` |
| `apps/api/src/utils/__tests__/leave-check.test.ts`             | `apps/api/src/contexts/absence/__tests__/leave-check.test.ts`                |
| `apps/api/src/utils/__tests__/leave-type.test.ts`              | `apps/api/src/contexts/absence/__tests__/leave-type.test.ts`                 |
| `apps/api/src/utils/__tests__/section9-detect.test.ts`         | `apps/api/src/contexts/absence/__tests__/section9-detect.test.ts`            |
| `apps/api/src/utils/__tests__/vacation-calc.test.ts`           | `apps/api/src/contexts/absence/__tests__/vacation-calc.test.ts`              |

**THE COLLISION.** `plugins/vocational-school-generator.ts` (the cron wrapper) and
`utils/vocational-school-generator.ts` (the Absence generation itself) are two different files with
the same basename, both Abwesenheiten. They land at
`contexts/absence/plugins/vocational-school-generator.ts` and
`contexts/absence/vocational-school-generator.ts` — the `plugins/` subdirectory from section 1
exists precisely to resolve this without renaming either.

### arbeitszeitkonto (99B-07) — 19 source (1 route, 1 plugin, 17 utils) + 15 test

| from                                                                     | to                                                                                               |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `apps/api/src/routes/overtime.ts`                                        | `apps/api/src/contexts/working-time-account/api/overtime.ts`                                     |
| `apps/api/src/plugins/auto-close-month.ts`                               | `apps/api/src/contexts/working-time-account/plugins/auto-close-month.ts`                         |
| `apps/api/src/utils/carry-over-base.ts`                                  | `apps/api/src/contexts/working-time-account/carry-over-base.ts`                                  |
| `apps/api/src/utils/close-employee-month.ts`                             | `apps/api/src/contexts/working-time-account/close-employee-month.ts`                             |
| `apps/api/src/utils/close-month-data.ts`                                 | `apps/api/src/contexts/working-time-account/close-month-data.ts`                                 |
| `apps/api/src/utils/confirmed-saldo.ts`                                  | `apps/api/src/contexts/working-time-account/confirmed-saldo.ts`                                  |
| `apps/api/src/utils/find-missing-workdays.ts`                            | `apps/api/src/contexts/working-time-account/find-missing-workdays.ts`                            |
| `apps/api/src/utils/missing-entries-window.ts`                           | `apps/api/src/contexts/working-time-account/missing-entries-window.ts`                           |
| `apps/api/src/utils/month-saldo.ts`                                      | `apps/api/src/contexts/working-time-account/month-saldo.ts`                                      |
| `apps/api/src/utils/negative-balance-tolerance.ts`                       | `apps/api/src/contexts/working-time-account/negative-balance-tolerance.ts`                       |
| `apps/api/src/utils/recalculate-snapshots.ts`                            | `apps/api/src/contexts/working-time-account/recalculate-snapshots.ts`                            |
| `apps/api/src/utils/saldo-chain-classification.ts`                       | `apps/api/src/contexts/working-time-account/saldo-chain-classification.ts`                       |
| `apps/api/src/utils/saldo-chain-integrity.ts`                            | `apps/api/src/contexts/working-time-account/saldo-chain-integrity.ts`                            |
| `apps/api/src/utils/saldo-snapshot-cleanup.ts`                           | `apps/api/src/contexts/working-time-account/saldo-snapshot-cleanup.ts`                           |
| `apps/api/src/utils/shift-based-saldo.ts`                                | `apps/api/src/contexts/working-time-account/shift-based-saldo.ts`                                |
| `apps/api/src/utils/snapshot-lock.ts`                                    | `apps/api/src/contexts/working-time-account/snapshot-lock.ts`                                    |
| `apps/api/src/utils/snapshot-period.ts`                                  | `apps/api/src/contexts/working-time-account/snapshot-period.ts`                                  |
| `apps/api/src/utils/timezone.ts`                                         | `apps/api/src/contexts/working-time-account/timezone.ts`                                         |
| `apps/api/src/utils/vocational-school-saldo.ts`                          | `apps/api/src/contexts/working-time-account/vocational-school-saldo.ts`                          |
| `apps/api/src/plugins/__tests__/auto-close-month.test.ts`                | `apps/api/src/contexts/working-time-account/plugins/__tests__/auto-close-month.test.ts`          |
| `apps/api/src/routes/__tests__/opening-balance-endpoint.test.ts`         | `apps/api/src/contexts/working-time-account/api/__tests__/opening-balance-endpoint.test.ts`      |
| `apps/api/src/routes/__tests__/opening-balance-seeding.test.ts`          | `apps/api/src/contexts/working-time-account/api/__tests__/opening-balance-seeding.test.ts`       |
| `apps/api/src/routes/__tests__/saldo-snapshot.test.ts`                   | `apps/api/src/contexts/working-time-account/api/__tests__/saldo-snapshot.test.ts`                |
| `apps/api/src/utils/__tests__/calc-leave-absence-minutes-tz.test.ts`     | `apps/api/src/contexts/working-time-account/__tests__/calc-leave-absence-minutes-tz.test.ts`     |
| `apps/api/src/utils/__tests__/carry-over-base.test.ts`                   | `apps/api/src/contexts/working-time-account/__tests__/carry-over-base.test.ts`                   |
| `apps/api/src/utils/__tests__/find-missing-workdays.test.ts`             | `apps/api/src/contexts/working-time-account/__tests__/find-missing-workdays.test.ts`             |
| `apps/api/src/utils/__tests__/opening-balance-model.test.ts`             | `apps/api/src/contexts/working-time-account/__tests__/opening-balance-model.test.ts`             |
| `apps/api/src/utils/__tests__/recalculate-snapshots.test.ts`             | `apps/api/src/contexts/working-time-account/__tests__/recalculate-snapshots.test.ts`             |
| `apps/api/src/utils/__tests__/saldo-chain-classification.test.ts`        | `apps/api/src/contexts/working-time-account/__tests__/saldo-chain-classification.test.ts`        |
| `apps/api/src/utils/__tests__/saldo-chain-integrity-calibration.test.ts` | `apps/api/src/contexts/working-time-account/__tests__/saldo-chain-integrity-calibration.test.ts` |
| `apps/api/src/utils/__tests__/saldo-chain-integrity.test.ts`             | `apps/api/src/contexts/working-time-account/__tests__/saldo-chain-integrity.test.ts`             |
| `apps/api/src/utils/__tests__/shift-based-saldo.test.ts`                 | `apps/api/src/contexts/working-time-account/__tests__/shift-based-saldo.test.ts`                 |
| `apps/api/src/utils/__tests__/snapshot-lock.test.ts`                     | `apps/api/src/contexts/working-time-account/__tests__/snapshot-lock.test.ts`                     |
| `apps/api/src/utils/__tests__/timezone.test.ts`                          | `apps/api/src/contexts/working-time-account/__tests__/timezone.test.ts`                          |

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
apps/api/src/plugins/__tests__/auto-close-month.test.ts -> apps/api/src/contexts/working-time-account/plugins/__tests__/auto-close-month.test.ts
apps/api/src/plugins/attendance-checker.ts -> apps/api/src/contexts/time-tracking/plugins/attendance-checker.ts
apps/api/src/plugins/audit.ts -> apps/api/src/contexts/platform/plugins/audit.ts
apps/api/src/plugins/auto-close-month.ts -> apps/api/src/contexts/working-time-account/plugins/auto-close-month.ts
apps/api/src/plugins/carryover-warning.ts -> apps/api/src/contexts/absence/plugins/carryover-warning.ts
apps/api/src/plugins/data-retention.ts -> apps/api/src/contexts/platform/plugins/data-retention.ts
apps/api/src/plugins/mailer.ts -> apps/api/src/contexts/platform/plugins/mailer.ts
apps/api/src/plugins/notify.ts -> apps/api/src/contexts/platform/plugins/notify.ts
apps/api/src/plugins/prisma.ts -> apps/api/src/contexts/platform/plugins/prisma.ts
apps/api/src/plugins/scheduler.ts -> apps/api/src/contexts/scheduling/plugins/scheduler.ts
apps/api/src/plugins/school-holidays-sync.ts -> apps/api/src/contexts/platform/plugins/school-holidays-sync.ts
apps/api/src/plugins/storage.ts -> apps/api/src/contexts/platform/plugins/storage.ts
apps/api/src/plugins/token-cleanup.ts -> apps/api/src/contexts/platform/plugins/token-cleanup.ts
apps/api/src/plugins/vocational-school-generator.ts -> apps/api/src/contexts/absence/plugins/vocational-school-generator.ts
apps/api/src/routes/__tests__/appointment-collisions.test.ts -> apps/api/src/contexts/scheduling/api/__tests__/appointment-collisions.test.ts
apps/api/src/routes/__tests__/arbzg.test.ts -> apps/api/src/contexts/time-tracking/__tests__/arbzg.test.ts
apps/api/src/routes/__tests__/availability-toggle.test.ts -> apps/api/src/contexts/scheduling/api/__tests__/availability-toggle.test.ts
apps/api/src/routes/__tests__/breaks.test.ts -> apps/api/src/contexts/time-tracking/api/__tests__/breaks.test.ts
apps/api/src/routes/__tests__/clock-in-resolver.test.ts -> apps/api/src/contexts/time-tracking/api/__tests__/clock-in-resolver.test.ts
apps/api/src/routes/__tests__/clock-invalid-retro.route.test.ts -> apps/api/src/contexts/time-tracking/api/__tests__/clock-invalid-retro.route.test.ts
apps/api/src/routes/__tests__/clock-out-break-minutes.test.ts -> apps/api/src/contexts/time-tracking/api/__tests__/clock-out-break-minutes.test.ts
apps/api/src/routes/__tests__/clock-out-resolver.test.ts -> apps/api/src/contexts/time-tracking/api/__tests__/clock-out-resolver.test.ts
apps/api/src/routes/__tests__/dashboard-overtime-trend.test.ts -> apps/api/src/composition/__tests__/dashboard-overtime-trend.test.ts
apps/api/src/routes/__tests__/dashboard.test.ts -> apps/api/src/composition/__tests__/dashboard.test.ts
apps/api/src/routes/__tests__/effective-schedule-by-date.test.ts -> apps/api/src/contexts/time-tracking/api/__tests__/effective-schedule-by-date.test.ts
apps/api/src/routes/__tests__/leave-characterization.test.ts -> apps/api/src/contexts/absence/api/__tests__/leave-characterization.test.ts
apps/api/src/routes/__tests__/minijob.test.ts -> apps/api/src/contexts/platform/api/__tests__/minijob.test.ts
apps/api/src/routes/__tests__/nfc-punch-race.test.ts -> apps/api/src/contexts/time-tracking/api/__tests__/nfc-punch-race.test.ts
apps/api/src/routes/__tests__/nfc-punch-resolver.test.ts -> apps/api/src/contexts/time-tracking/api/__tests__/nfc-punch-resolver.test.ts
apps/api/src/routes/__tests__/nfc-punch.test.ts -> apps/api/src/contexts/time-tracking/api/__tests__/nfc-punch.test.ts
apps/api/src/routes/__tests__/opening-balance-endpoint.test.ts -> apps/api/src/contexts/working-time-account/api/__tests__/opening-balance-endpoint.test.ts
apps/api/src/routes/__tests__/opening-balance-seeding.test.ts -> apps/api/src/contexts/working-time-account/api/__tests__/opening-balance-seeding.test.ts
apps/api/src/routes/__tests__/presence-resolver.test.ts -> apps/api/src/contexts/time-tracking/api/__tests__/presence-resolver.test.ts
apps/api/src/routes/__tests__/reports.test.ts -> apps/api/src/composition/__tests__/reports.test.ts
apps/api/src/routes/__tests__/saldo-snapshot.test.ts -> apps/api/src/contexts/working-time-account/api/__tests__/saldo-snapshot.test.ts
apps/api/src/routes/__tests__/schedule-type-switch-guard.test.ts -> apps/api/src/contexts/platform/api/__tests__/schedule-type-switch-guard.test.ts
apps/api/src/routes/__tests__/schedule-versioning.test.ts -> apps/api/src/contexts/platform/api/__tests__/schedule-versioning.test.ts
apps/api/src/routes/__tests__/settings-schedule.test.ts -> apps/api/src/contexts/platform/api/__tests__/settings-schedule.test.ts
apps/api/src/routes/__tests__/shift-arbzg.test.ts -> apps/api/src/contexts/scheduling/api/__tests__/shift-arbzg.test.ts
apps/api/src/routes/__tests__/shift-unavailability-soft.test.ts -> apps/api/src/contexts/scheduling/api/__tests__/shift-unavailability-soft.test.ts
apps/api/src/routes/__tests__/shifts-characterization.test.ts -> apps/api/src/contexts/scheduling/api/__tests__/shifts-characterization.test.ts
apps/api/src/routes/__tests__/shifts-my-week.test.ts -> apps/api/src/contexts/scheduling/api/__tests__/shifts-my-week.test.ts
apps/api/src/routes/__tests__/shifts-school-holiday.test.ts -> apps/api/src/contexts/scheduling/api/__tests__/shifts-school-holiday.test.ts
apps/api/src/routes/__tests__/shifts.test.ts -> apps/api/src/contexts/scheduling/api/__tests__/shifts.test.ts
apps/api/src/routes/__tests__/terminals.test.ts -> apps/api/src/contexts/time-tracking/api/__tests__/terminals.test.ts
apps/api/src/routes/__tests__/time-entries-validation.test.ts -> apps/api/src/contexts/time-tracking/api/__tests__/time-entries-validation.test.ts
apps/api/src/routes/__tests__/time-entries.test.ts -> apps/api/src/contexts/time-tracking/api/__tests__/time-entries.test.ts
apps/api/src/routes/activity.ts -> apps/api/src/contexts/platform/api/activity.ts
apps/api/src/routes/admin-presence-sources.ts -> apps/api/src/contexts/time-tracking/api/admin-presence-sources.ts
apps/api/src/routes/admin/school-holidays.ts -> apps/api/src/contexts/platform/api/admin/school-holidays.ts
apps/api/src/routes/api-keys.ts -> apps/api/src/contexts/platform/api/api-keys.ts
apps/api/src/routes/audit-logs.ts -> apps/api/src/contexts/platform/api/audit-logs.ts
apps/api/src/routes/auth.ts -> apps/api/src/contexts/platform/api/auth.ts
apps/api/src/routes/availability.ts -> apps/api/src/contexts/scheduling/api/availability.ts
apps/api/src/routes/avatars.ts -> apps/api/src/contexts/platform/api/avatars.ts
apps/api/src/routes/company-shutdowns.ts -> apps/api/src/contexts/absence/api/company-shutdowns.ts
apps/api/src/routes/dashboard.ts -> apps/api/src/composition/dashboard.ts
apps/api/src/routes/employees.ts -> apps/api/src/contexts/platform/api/employees.ts
apps/api/src/routes/holidays.ts -> apps/api/src/contexts/platform/api/holidays.ts
apps/api/src/routes/imports.ts -> apps/api/src/contexts/platform/api/imports.ts
apps/api/src/routes/integrations.ts -> apps/api/src/contexts/scheduling/api/integrations.ts
apps/api/src/routes/invitations.ts -> apps/api/src/contexts/platform/api/invitations.ts
apps/api/src/routes/leave.ts -> apps/api/src/contexts/absence/api/leave.ts
apps/api/src/routes/me.ts -> apps/api/src/contexts/platform/api/me.ts
apps/api/src/routes/notifications.ts -> apps/api/src/contexts/platform/api/notifications.ts
apps/api/src/routes/overtime.ts -> apps/api/src/contexts/working-time-account/api/overtime.ts
apps/api/src/routes/presence.ts -> apps/api/src/contexts/time-tracking/api/presence.ts
apps/api/src/routes/release-notes.ts -> apps/api/src/contexts/platform/api/release-notes.ts
apps/api/src/routes/reports.ts -> apps/api/src/composition/reports.ts
apps/api/src/routes/retro-entry-requests.ts -> apps/api/src/contexts/time-tracking/api/retro-entry-requests.ts
apps/api/src/routes/section9-documents.ts -> apps/api/src/contexts/absence/api/section9-documents.ts
apps/api/src/routes/settings.ts -> apps/api/src/contexts/platform/api/settings.ts
apps/api/src/routes/shift-patterns.ts -> apps/api/src/contexts/scheduling/api/shift-patterns.ts
apps/api/src/routes/shifts.ts -> apps/api/src/contexts/scheduling/api/shifts.ts
apps/api/src/routes/special-leave.ts -> apps/api/src/contexts/absence/api/special-leave.ts
apps/api/src/routes/terminals.ts -> apps/api/src/contexts/time-tracking/api/terminals.ts
apps/api/src/routes/test-bootstrap.ts -> apps/api/src/contexts/platform/api/test-bootstrap.ts
apps/api/src/routes/time-entries.ts -> apps/api/src/contexts/time-tracking/api/time-entries.ts
apps/api/src/routes/vocational-school-pattern.ts -> apps/api/src/contexts/absence/api/vocational-school-pattern.ts
apps/api/src/routes/vocational-school.ts -> apps/api/src/contexts/absence/api/vocational-school.ts
apps/api/src/utils/__tests__/calc-leave-absence-minutes-tz.test.ts -> apps/api/src/contexts/working-time-account/__tests__/calc-leave-absence-minutes-tz.test.ts
apps/api/src/utils/__tests__/calculate-work-days.test.ts -> apps/api/src/contexts/platform/__tests__/calculate-work-days.test.ts
apps/api/src/utils/__tests__/carry-over-base.test.ts -> apps/api/src/contexts/working-time-account/__tests__/carry-over-base.test.ts
apps/api/src/utils/__tests__/find-missing-workdays.test.ts -> apps/api/src/contexts/working-time-account/__tests__/find-missing-workdays.test.ts
apps/api/src/utils/__tests__/holidays.test.ts -> apps/api/src/contexts/platform/__tests__/holidays.test.ts
apps/api/src/utils/__tests__/invalid-reason.test.ts -> apps/api/src/contexts/time-tracking/__tests__/invalid-reason.test.ts
apps/api/src/utils/__tests__/leave-check.test.ts -> apps/api/src/contexts/absence/__tests__/leave-check.test.ts
apps/api/src/utils/__tests__/leave-type.test.ts -> apps/api/src/contexts/absence/__tests__/leave-type.test.ts
apps/api/src/utils/__tests__/opening-balance-model.test.ts -> apps/api/src/contexts/working-time-account/__tests__/opening-balance-model.test.ts
apps/api/src/utils/__tests__/recalculate-snapshots.test.ts -> apps/api/src/contexts/working-time-account/__tests__/recalculate-snapshots.test.ts
apps/api/src/utils/__tests__/saldo-chain-classification.test.ts -> apps/api/src/contexts/working-time-account/__tests__/saldo-chain-classification.test.ts
apps/api/src/utils/__tests__/saldo-chain-integrity-calibration.test.ts -> apps/api/src/contexts/working-time-account/__tests__/saldo-chain-integrity-calibration.test.ts
apps/api/src/utils/__tests__/saldo-chain-integrity.test.ts -> apps/api/src/contexts/working-time-account/__tests__/saldo-chain-integrity.test.ts
apps/api/src/utils/__tests__/section9-detect.test.ts -> apps/api/src/contexts/absence/__tests__/section9-detect.test.ts
apps/api/src/utils/__tests__/shift-based-saldo.test.ts -> apps/api/src/contexts/working-time-account/__tests__/shift-based-saldo.test.ts
apps/api/src/utils/__tests__/shift-netto.test.ts -> apps/api/src/contexts/scheduling/__tests__/shift-netto.test.ts
apps/api/src/utils/__tests__/snapshot-lock.test.ts -> apps/api/src/contexts/working-time-account/__tests__/snapshot-lock.test.ts
apps/api/src/utils/__tests__/time-arithmetic.test.ts -> apps/api/src/contexts/scheduling/__tests__/time-arithmetic.test.ts
apps/api/src/utils/__tests__/timezone.test.ts -> apps/api/src/contexts/working-time-account/__tests__/timezone.test.ts
apps/api/src/utils/__tests__/vacation-calc.test.ts -> apps/api/src/contexts/absence/__tests__/vacation-calc.test.ts
apps/api/src/utils/anonymize.ts -> apps/api/src/contexts/platform/anonymize.ts
apps/api/src/utils/arbzg.ts -> apps/api/src/contexts/time-tracking/arbzg.ts
apps/api/src/utils/audit-reason.ts -> apps/api/src/contexts/platform/audit-reason.ts
apps/api/src/utils/break-constants.ts -> apps/api/src/contexts/time-tracking/break-constants.ts
apps/api/src/utils/break-effective.ts -> apps/api/src/contexts/time-tracking/break-effective.ts
apps/api/src/utils/bs-slot-resolver.ts -> apps/api/src/contexts/absence/bs-slot-resolver.ts
apps/api/src/utils/calculate-work-days.ts -> apps/api/src/contexts/platform/calculate-work-days.ts
apps/api/src/utils/carry-over-base.ts -> apps/api/src/contexts/working-time-account/carry-over-base.ts
apps/api/src/utils/close-employee-month.ts -> apps/api/src/contexts/working-time-account/close-employee-month.ts
apps/api/src/utils/close-month-data.ts -> apps/api/src/contexts/working-time-account/close-month-data.ts
apps/api/src/utils/confirmed-saldo.ts -> apps/api/src/contexts/working-time-account/confirmed-saldo.ts
apps/api/src/utils/correction-lock.ts -> apps/api/src/contexts/absence/correction-lock.ts
apps/api/src/utils/federal-state-iso.ts -> apps/api/src/contexts/platform/federal-state-iso.ts
apps/api/src/utils/find-karenz-overrun-days.ts -> apps/api/src/contexts/absence/find-karenz-overrun-days.ts
apps/api/src/utils/find-missing-workdays.ts -> apps/api/src/contexts/working-time-account/find-missing-workdays.ts
apps/api/src/utils/find-unconfirmed-break-days.ts -> apps/api/src/contexts/time-tracking/find-unconfirmed-break-days.ts
apps/api/src/utils/format-hm.ts -> apps/api/src/contexts/absence/format-hm.ts
apps/api/src/utils/get-current-shift.ts -> apps/api/src/contexts/scheduling/get-current-shift.ts
apps/api/src/utils/holidays.ts -> apps/api/src/contexts/platform/holidays.ts
apps/api/src/utils/ical.ts -> apps/api/src/contexts/absence/ical.ts
apps/api/src/utils/illness-carryover-guard.ts -> apps/api/src/contexts/absence/illness-carryover-guard.ts
apps/api/src/utils/invalid-reason.ts -> apps/api/src/contexts/time-tracking/invalid-reason.ts
apps/api/src/utils/jarbschg.ts -> apps/api/src/contexts/absence/jarbschg.ts
apps/api/src/utils/leave-check.ts -> apps/api/src/contexts/absence/leave-check.ts
apps/api/src/utils/leave-self-heal.ts -> apps/api/src/contexts/absence/leave-self-heal.ts
apps/api/src/utils/leave-type.ts -> apps/api/src/contexts/absence/leave-type.ts
apps/api/src/utils/load-bs-slot-overrides.ts -> apps/api/src/contexts/absence/load-bs-slot-overrides.ts
apps/api/src/utils/missing-entries-window.ts -> apps/api/src/contexts/working-time-account/missing-entries-window.ts
apps/api/src/utils/month-first-date.ts -> apps/api/src/contexts/platform/month-first-date.ts
apps/api/src/utils/month-saldo.ts -> apps/api/src/contexts/working-time-account/month-saldo.ts
apps/api/src/utils/negative-balance-tolerance.ts -> apps/api/src/contexts/working-time-account/negative-balance-tolerance.ts
apps/api/src/utils/normalize-mac.ts -> apps/api/src/contexts/time-tracking/normalize-mac.ts
apps/api/src/utils/notification-email-policy.ts -> apps/api/src/contexts/platform/notification-email-policy.ts
apps/api/src/utils/password-policy.ts -> apps/api/src/contexts/platform/password-policy.ts
apps/api/src/utils/pdf.ts -> apps/api/src/composition/pdf.ts
apps/api/src/utils/presence.ts -> apps/api/src/contexts/time-tracking/presence.ts
apps/api/src/utils/recalculate-snapshots.ts -> apps/api/src/contexts/working-time-account/recalculate-snapshots.ts
apps/api/src/utils/retro-config.ts -> apps/api/src/contexts/time-tracking/retro-config.ts
apps/api/src/utils/saldo-chain-classification.ts -> apps/api/src/contexts/working-time-account/saldo-chain-classification.ts
apps/api/src/utils/saldo-chain-integrity.ts -> apps/api/src/contexts/working-time-account/saldo-chain-integrity.ts
apps/api/src/utils/saldo-snapshot-cleanup.ts -> apps/api/src/contexts/working-time-account/saldo-snapshot-cleanup.ts
apps/api/src/utils/school-holidays-client.ts -> apps/api/src/contexts/platform/school-holidays-client.ts
apps/api/src/utils/section9-credit-days.ts -> apps/api/src/contexts/absence/section9-credit-days.ts
apps/api/src/utils/section9-detect.ts -> apps/api/src/contexts/absence/section9-detect.ts
apps/api/src/utils/shift-availability.ts -> apps/api/src/contexts/scheduling/shift-availability.ts
apps/api/src/utils/shift-based-saldo.ts -> apps/api/src/contexts/working-time-account/shift-based-saldo.ts
apps/api/src/utils/shift-cleanup.ts -> apps/api/src/contexts/scheduling/shift-cleanup.ts
apps/api/src/utils/shift-leave-recalc-resolver.ts -> apps/api/src/contexts/absence/shift-leave-recalc-resolver.ts
apps/api/src/utils/shift-netto.ts -> apps/api/src/contexts/scheduling/shift-netto.ts
apps/api/src/utils/snapshot-lock.ts -> apps/api/src/contexts/working-time-account/snapshot-lock.ts
apps/api/src/utils/snapshot-period.ts -> apps/api/src/contexts/working-time-account/snapshot-period.ts
apps/api/src/utils/tenant-availability.ts -> apps/api/src/contexts/scheduling/tenant-availability.ts
apps/api/src/utils/time-arithmetic.ts -> apps/api/src/contexts/scheduling/time-arithmetic.ts
apps/api/src/utils/timezone.ts -> apps/api/src/contexts/working-time-account/timezone.ts
apps/api/src/utils/vacation-calc.ts -> apps/api/src/contexts/absence/vacation-calc.ts
apps/api/src/utils/vocational-school-constants.ts -> apps/api/src/contexts/absence/vocational-school-constants.ts
apps/api/src/utils/vocational-school-generator.ts -> apps/api/src/contexts/absence/vocational-school-generator.ts
apps/api/src/utils/vocational-school-pattern-order.ts -> apps/api/src/contexts/absence/vocational-school-pattern-order.ts
apps/api/src/utils/vocational-school-saldo.ts -> apps/api/src/contexts/working-time-account/vocational-school-saldo.ts
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
  After this phase, Zeiterfassung lives in BOTH `contexts/time-tracking/` and `services/clock/`, and
  Schichtplanung in BOTH `contexts/scheduling/` and `services/phorest/`. Issue #99 names these
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
apps/api/src/contexts/platform/api
apps/api/src/contexts/time-tracking/api
apps/api/src/contexts/absence/api
apps/api/src/contexts/scheduling/api
apps/api/src/contexts/working-time-account/api
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

- **Context facades — no longer true, DONE as of Phase 100b (#100), closed 2026-09-17.** Each
  context now carries exactly one `contexts/<context>/index.ts` as its public surface (D-06: what
  it does not export is module-internal, and says so in a comment); the implementation a route or
  a foreign context reaches through it lives under `contexts/<x>/facade/*.ts`.

  **The placement rule, stated once:** `contexts/<x>/index.ts` is the public surface — a pure
  re-export, no Prisma call, no logic — and `contexts/<x>/facade/*.ts` is the implementation, which
  is deliberately INSIDE the `lint:tenant-scoping` gate's scope (`SCOPED_DIRS`,
  `apps/api/scripts/lint-tenant-scoping-types.ts`) rather than excluded the way `plugins/` is: a
  facade Prisma call carries exactly a client-supplied identifier from the route that called it,
  which is this gate's precondition, not an exemption from it (100B Plan 04, D-10/G1-G3). A new
  cross-context query goes in `facade/`, never in `index.ts` — a query placed in the index would be
  invisible to that gate.

  `SCOPED_DIRS` reached its final, 12-entry shape in this phase: the original 7 (`platform`,
  `time-tracking`, `absence`, `scheduling`, `working-time-account` `api/` dirs, plus `composition`
  and `services`), each paired with its own `facade/` sibling added in the wave that first needed
  it (`platform/facade` — plan 04; `scheduling/facade` — plan 05; `working-time-account/facade` —
  plan 06; `time-tracking/facade` — plan 08; `absence/facade` — plan 10).

  Every one of the phase's originally-measured 169 direct cross-context Prisma accesses now goes
  through a facade — `measure:context-access --check 0` exits 0 and `--rows` prints nothing,
  wired into CI (Phase 100b Plan 14) as a standing gate, not a moving target. Four control
  additions came with it: the `lint:tenant-scoping` gate extended to see and judge a Prisma call
  inside a facade module (G1/G2/G3, plan 04), plus three wholly new gates —
  `lint:facade-signatures` (D-07: every facade function's first parameter is
  `db: Prisma.TransactionClient`, never `app: FastifyInstance`, plan 03), `measure:context-access`
  itself (the boundary-completeness counter, plan 01), and `lint:saldo-lock-derivation` (Issue
  #241's periodStart-derivation gate, landed mid-phase alongside the `fix(241)` commits on this
  same branch).

  What this phase deliberately did NOT convert: the DSGVO Art. 17 sweeps' 21 direct calls in
  `contexts/platform/api/test-bootstrap.ts` (D-03, a named exception — test-only infrastructure,
  gated off int/prod); `contexts/working-time-account/confirmed-saldo.ts` stayed at its
  pre-existing flat path rather than moving into `facade/` (plan 07); `services/clock/` and
  `services/phorest/` were not folded into `contexts/` (D-17 below, unchanged by this phase) — the
  two genuine crossings out of `services/` (`services/phorest/sync-shifts.ts`) are now the ONLY
  ones, `measure:context-access --rows` under `services/` is empty.

- **No machine-enforced boundaries — still open, this is #101's job.** Nothing stops a file in one
  context from importing another context's INTERNAL module (anything not exported from its
  `index.ts`) today — the facade makes the public surface explicit, it does not yet make bypassing
  it impossible. `eslint-plugin-boundaries` works on file paths, so it will slot in on top of this
  tree without another move (D-15's finding). What it inherits from 100b: a tree where the
  cross-context Prisma access is already zero, but the Unterbau (`contexts/platform/`) itself
  still imports OTHER contexts in nine files (`anonymize.ts`, `plugins/data-retention.ts`,
  `api/holidays.ts`, `api/employees.ts`, `api/activity.ts`, `api/settings.ts`, `api/me.ts`,
  `api/imports.ts`, `api/admin/school-holidays.ts`) — every import in those nine files already
  goes through a facade/index, so the ACCESS is safe, but the DIRECTION (Unterbau depending on a
  business context) is exactly what #101's planned AC3 ("Unterbau darf keine Business-Kontexte
  importieren") forbids. #101 cannot land AC3 as written without also resolving this — either by
  reclassifying which context truly owns each of these nine call sites, or by revising AC3 itself;
  that decision was explicitly left to #101, not made here (D-13, no opportunistic redesign).
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
