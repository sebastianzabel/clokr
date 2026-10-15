# Clokr – Project Rules

## Tech Stack

- **Monorepo**: pnpm workspaces (`apps/api`, `apps/web`, `packages/db`)
- **API**: Fastify + TypeScript, Zod validation, Prisma ORM (PostgreSQL)
- **Web**: SvelteKit + Svelte 5 (runes: `$state`, `$derived`, `$effect`, `$props`)
- **DB**: PostgreSQL 18, Prisma schema at `packages/db/prisma/schema.prisma`
- **Docker**: `docker compose up --build -d` for full stack

## Commands

- `pnpm dev` — start all dev servers
- `pnpm --filter @clokr/api dev` — API only
- `pnpm --filter @clokr/web dev` — Web only
- `pnpm --filter @clokr/db exec prisma migrate deploy` — apply pending migrations (every env)
- `pnpm --filter @clokr/db exec prisma generate` — regenerate Prisma client (`migrate deploy` does NOT do this, unlike `migrate dev`)
- Schema changes go through **versioned migrations**, never `db push`.

### Creating a migration — do NOT use `prisma migrate dev`

**`migrate dev` is not the workflow on this project.** When it finds drift it resets the target
database — drops it, recreates it, replays every migration — and in a non-interactive shell (i.e.
any agent run) that happens **without a confirmation prompt**. It did exactly that on 2026-08-19 and
destroyed all local fixture/demo data. This dev database has long-standing pre-existing index drift,
so it is reset-prone on repeat, not just that once.

Create migrations the way phases 85-01, 91-01, 96-01 and 104's quick tasks did — generate the SQL
against a throwaway shadow DB, read it, then apply it:

```bash
# 1. throwaway shadow DB
psql ... -c 'DROP DATABASE IF EXISTS clokr_shadow;' -c 'CREATE DATABASE clokr_shadow;'
# 2. hand-create packages/db/prisma/migrations/$(date +%Y%m%d%H%M%S)_<snake_name>/
# 3. generate the SQL — Prisma 7 takes the shadow URL from the ENV VAR, there is no CLI flag
#    (see packages/db/prisma.config.ts and the drift check in .github/workflows/ci.yml)
SHADOW_DATABASE_URL="postgresql://.../clokr_shadow" pnpm --filter @clokr/db exec prisma migrate diff \
  --from-migrations ./prisma/migrations --to-schema ./prisma/schema.prisma --script \
  > packages/db/prisma/migrations/<dir>/migration.sql
# 4. READ migration.sql. Anything beyond your intended change is drift leaking in — stop, don't hand-edit.
# 5. apply to dev AND clokr_test, then verify
pnpm --filter @clokr/db exec prisma migrate deploy
pnpm --filter @clokr/api run test:setup
pnpm --filter @clokr/db exec prisma migrate status   # must report no drift
# 6. drop clokr_shadow, run prisma generate
```

Flags that older Prisma docs use and that **fail** here: `--to-schema-datamodel` (removed, use
`--to-schema`), `--shadow-database-url` (never a CLI flag in Prisma 7 — use `SHADOW_DATABASE_URL`).

Full workflow incl. the SAFETY-CRITICAL one-time int/prod baseline runbook: `docs/migrations.md`.
- `docker compose up --build -d` — rebuild and restart all containers

## Path Aliases (SvelteKit)

- `$stores` → `src/lib/stores/`
- `$api` → `src/lib/api/`

## Testing & Test Database Isolation

- The `apps/api` integration suite runs against its own databases — the template `clokr_test` and
  the per-worker `clokr_test_1`…`clokr_test_<N>` cloned from it — never the dev database `clokr`.
- Provision with `pnpm --filter @clokr/api run test:setup`: it ensures the template, runs
  `prisma migrate deploy` against it, then drops and re-clones all N worker databases. Every run
  therefore starts from a clean database; leftover rows from a killed run cannot survive.
- Run the full suite with `pnpm --filter @clokr/api test` — unchanged. Single file: `test:setup`
  first, then `pnpm --filter @clokr/api exec vitest run <path>` (`exec vitest run` skips `pretest`;
  `pnpm test -- <file>` does not work).
- The worker count is pinned in `apps/api/src/utils/test-database.ts`
  (`TEST_DATABASE_WORKER_COUNT`) — one number for CI and local. Changing it requires re-running
  `test:setup`, because that is what provisions exactly that many databases.
- `apps/api/src/utils/test-database.ts` is the ONLY place the test-database name pattern, the
  marker and the worker count may be stated. Never restate them — not even here. This bullet used
  to quote the regex inline and went stale the moment Phase 132 widened it, which is the exact
  failure the rule exists to prevent. Read `TEST_DATABASE_NAME_PATTERN` in that module.
- **Per-working-directory namespaces (Phase 132).** The MAIN working tree uses an empty namespace,
  so its names stay `clokr_test` / `clokr_test_1`…`_N` — byte-identical to before, which is what CI
  relies on. A linked `git worktree` derives an 8-hex namespace and uses `clokr_test_<ns>` /
  `clokr_test_<ns>_<n>`, so two working directories can run the suite at the same time without
  colliding. The namespace is decided by `git rev-parse --path-format=absolute --git-dir
  --git-common-dir`; `--path-format=absolute` is load-bearing, because from a subdirectory git
  returns one path absolute and the other relative, and comparing them raw would misread the main
  tree as a worktree and rename CI's databases. `CLOKR_TEST_NAMESPACE` overrides the derivation;
  absent `git`, the namespace falls back to empty, never to a guess. Orphaned namespaces:
  `reset-test-databases.ts --prune-orphans` (dry run by default, `--confirm` to act).
- A startup guard aborts before any test executes if a target is not a marked test database — it
  verifies the template AND every worker database by name and by marker POSSESSION, and each worker
  refuses to run if it cannot resolve its own database. Fix the target, never work around the guard.
- `apps/api/scripts/reset-test-databases.ts` is the only script that may `DROP DATABASE`; it
  requires marker possession AND a matching worker name, and an `apps/api/Dockerfile` build gate
  fails if it ever reaches the runtime image.
- `?schema=` is a Prisma-only connection-string parameter that the `pg` driver silently ignores —
  it must never reappear in `TEST_DATABASE_URL`.
- **Test users need a stored role assignment (Issue #539).** Permissions come only from stored rows, so a
  fixture user without one holds nothing. Give each user its system role explicitly with
  `grantSystemRole(prisma, { tenantId, userId, role })` from `apps/api/src/__tests__/setup.ts` (a stored
  TENANT row, idempotent; `seedTestData`/`seedTenantFixture` users already have one). A test that needs the
  unassigned state uses `removeFixtureRoleAssignments` or creates a user without calling the helper. The
  seeds use `ensureSystemRoleAssignment` (`packages/db/src/seed-role-assignments.ts`).
- Full details, provisioning rationale, and the clean-slate procedure: `docs/testing.md`.

## Language

- UI labels and user-facing text: **German**
- Code, comments, commit messages, docs: **English**
- API descriptions (Swagger): English

## Context Boundaries (ADR 0001, ADR 0002)

**Read `docs/adr/0002-vier-kontexte-und-unterbau.md` and `docs/adr/0001-drei-kontexte.md` (partially superseded by 0002) before adding a feature or moving code across these lines.**
Deviations from the target picture, with file references: `docs/adr/0001-abweichungen.md`.

Clokr has **four business contexts**, a shared substrate (**Unterbau**, the Shared Kernel) that belongs to none of them, and a rule-free **composition layer**:

- **Zeiterfassung** (`contexts/time-tracking/` + `services/clock/`) — clock in/out, correction, validity, ArbZG. Records what happened. Minute-level, one row per employee and day.
- **Abwesenheiten** (`contexts/absence/`) — request, approval, entitlement, carry-over. A workflow with status, not a recording. Date ranges in days.
- **Schichtplanung** (`contexts/scheduling/` + `services/phorest/`) — shifts, templates, coverage, availability, Phorest sync. Plans the future. Since Phase 107 it feeds Arbeitszeitkonto (SHIFT_BASED Soll) and Abwesenheiten (SHIFT_BASED leave-day count).
- **Arbeitszeitkonto** (`contexts/working-time-account/`) — Soll vs. Ist, saldo, Monatsabschluss. Reads from the others. Owns the once-per-day rule.
- **Unterbau** (Shared Kernel, `contexts/platform/`) — the 20 `platform` models of `MODEL_OWNER` in `apps/api/scripts/measure-foreign-context-access.ts` (Tenant, TenantConfig, Employee, User, WorkSchedule, OperatorAccount, OperatorAuditLog, SupportAccess, …) and permissions. Salon (#64), RoleAssignment (#74) and Salonzuordnung (#67) land here; Beschäftigung (#66) is backlog and has no entity.
- **Composition layer** (`apps/api/src/composition/` + composition root `apps/api/src/app.ts`) — owns no model, carries no business rule, reads contexts only through their `index.ts`, and no context imports from `composition/`. A business rule found there moves into the owning context (ADR 0002, Entscheidung 9).

Rules — these are directives, not preferences:

- **Absence is NEVER a `TimeEntryType`.** A time entry has no "requested" status, and approved leave for next August is not a recorded period. `TimeEntryType` stays free of absence values.
- **`calcLeaveAbsenceMinutesTz()` (`apps/api/src/contexts/working-time-account/timezone.ts`) belongs to Arbeitszeitkonto and is NOT to be split.** It and the `sbClaimed` dedup set in `close-employee-month.ts` carry the invariant *a day reduces Soll exactly once*. Anyone wanting to split it must first prove the invariant is secured otherwise.
- **`LeaveRequest` = requested absence** (status, entitlement, approver): Urlaub, Krankheit, Sonderurlaub. **`Absence` = imposed absence** (occurs, is not requested): Berufsschule, Mutterschutz, Elternzeit. `SICK` belongs to `LeaveRequest`.
- **No foreign keys between peer contexts; foreign keys onto the Unterbau are allowed** (ADR 0002, Entscheidung 4). Existing `onDelete` behaviour is untouched; the `onDelete: Restrict` compliance control on Employee→TimeEntry/LeaveRequest/Absence stays in the database. A new FK onto the Unterbau is named in its issue as a new Shared-Kernel dependency, revision-relevant relations use `onDelete: Restrict`, and the referenced Unterbau row must belong to the same tenant.
- **No direct table access across contexts.** Go through the owning context's public interface.
  **Mechanically enforced (Phase 101B, Issue #101):** `eslint.boundaries.mjs`'s `no-restricted-imports`
  blocks fail the build (CI and pre-commit) on a deep import into a foreign context's internals —
  the only legal way in is `contexts/<name>/index.ts`. Its five boundary areas (`BOUNDARY_CONTEXTS`)
  are the four contexts plus `platform`; `services/clock/` counts as Zeiterfassung and
  `services/phorest/` as Schichtplanung. The composition root (`app.ts`) and six
  individually reasoned, dated exceptions (`apps/api/scripts/context-boundary-import-exceptions.json`)
  are named in `docs/adr/0001-abweichungen.md` Eintrag H; a new one is a finding to report, not a
  step to take.
- **Never use a new display string as a control value.** No `x === "Ausstempeln fehlt"`, no lookup by `leaveType.name`. Existing occurrences are documented deviations, not precedent.
- **No generalization on spec.** No plugin system, no generic extension mechanism, no abstraction layer without a concrete second use case (ADR 0002, Entscheidung 2). The former fourth-context trigger is void because the fourth context exists; a generalization already scheduled with a concrete use case, such as the in-process dispatcher (#102), is legitimate.
- **Tactical DDD building blocks only in Arbeitszeitkonto.** Aggregate, Repository and Value Object only in `contexts/working-time-account/` (#107, #108) — not in the other contexts, the Unterbau or the composition layer. No CQRS (ADR 0002, Entscheidung 3).
- **One schema and one central migration directory are conforming.** Per-context schemas (#105) and migrations (#106) only on a trigger — migrations of different contexts collide in practice, or a database role must be granted per context. They bring signal and migration separation, not compile-time isolation, which comes from the facades (#100) and the lint (#101) (ADR 0002, Entscheidung 6).
- **Event handlers are invariant-carrying or reactive** (ADR 0002, Entscheidung 10). Invariant-carrying: synchronous, inside the sender's transaction, fail-closed — its failure aborts the sender's write. Reactive: after commit, may fail, never aborts the sender, failure logged. Default is reactive; invariant-carrying only when a named invariant requires it, and it then lives in the context owning that invariant (example: `recalcProvisionalLeaveForShiftChange(tx, …)`, Phase 107 D-15). No dispatcher exists yet — that is #102. No broker until a consumer outside the process exists or an event must survive a restart (Entscheidung 5).
- **Unterbau changes need the owner** (ADR 0002, Entscheidung 7). An Unterbau change (a) adds, changes or removes a field, relation, enum value or model owned by the Unterbau, or (b) changes the signature or semantics of an export of `contexts/platform/index.ts`. An **Erweiterung** (additive; no existing reader has to change) is approved by the issue reaching `Ready`; a **Semantikänderung** (meaning, unit, nullability, required-ness, fallback chain, `onDelete`, removal/rename, moving a value between Unterbau models) additionally needs an explicit owner decision comment on the issue before `Ready` and a Nachtrag in `docs/adr/0001-abweichungen.md` after shipping. Every Unterbau-change issue carries a section „Auswirkung auf die Kontexte“ naming Zeiterfassung, Abwesenheiten, Schichtplanung, Arbeitszeitkonto and the composition layer — each with an effect or an explicit "keine".
- **When unsure which context a new feature belongs to: ask.** Do not guess.

## Audit-Proof / Revisionssicherheit

Clokr MUST be audit-proof (revisionssicher). All data relevant to working time, leave, and payroll must be tamper-proof and traceable:

- **No hard deletes** of time entries, leave requests, or employee records — use soft delete (`deletedAt`) or status changes instead
- **Soft delete queries**: ALL queries on soft-deletable models (TimeEntry, LeaveRequest, Absence) MUST include `deletedAt: null` in the where clause
- **Audit trail**: Every create, update, and delete must be logged with userId, timestamp, IP, and before/after values (via `app.audit()`)
- **Immutability after lock**: Once a month is closed (`isLocked`), entries MUST NOT be editable or deletable — not even by admins. Always check `isLocked` before UPDATE/DELETE.
- **No silent overwrites**: Any correction to a locked/finalized entry must create a new correction entry with reference to the original, not modify it in place
- **Traceability**: It must always be possible to reconstruct who changed what, when, and why
- **CASCADE = Restrict**: Critical relations (Employee→TimeEntry/LeaveRequest/Absence) use `onDelete: Restrict` to prevent silent cascade deletion
- **`LEAVE_DAYS_ADJUSTED` audit action** (Phase 107, D-20): written whenever roster planning
  recomputes a `SHIFT_BASED` employee's approved, provisional leave-day count for a period that
  overlaps the changed roster week; carries `oldValue`/`newValue` (`{days, daysProvisional}`) and
  a `Roster-Planung` trigger note — same pattern as `LEAVE_CORRECTED` (Phase 94).
- **Überstundenausgleich** (Issue #468, D-02): `LeaveRequest.overtimeCompMinutes` stores the booked
  minutes at approval; storno and correction reverse exactly that stored value, never a
  recomputation (a legacy row with no stored value falls back to a logged recomputation).
- **§ 9-Korrektur** (Issue #468, A-3): a `/correct` never deletes a `Section9Credit` — a credit
  that no longer applies is marked `SUPERSEDED` and, if it partially survives, replaced by a new
  correction credit (`supersedesId`), both audited.

- **Operator audit is append-only (Phase 88, Issue #88, D-07a).** Every action of the operator
  principal is written to `OperatorAuditLog` through `recordOperatorAudit()`
  (`contexts/platform/operator-audit.ts`, the only file naming the delegate), never to the tenant
  `AuditLog`. The table is append-only twice over: the writer only creates rows, and a database
  trigger refuses UPDATE, TRUNCATE and every DELETE except the retention purge (the first DB trigger
  of the project; it guards against application mistakes, not against the table owner). Retention
  (`composition/data-retention.ts`): authentication events 12 months, lifecycle actions 10 years.
  Details and limits: `docs/adr/0001-abweichungen.md` Eintrag Y. `SupportAccess` (Issue #93) carries
  the project's second database trigger, with the same intent (see the support-access bullet in the
  operator section).

These rules apply to ALL code changes touching time entries, leave, overtime, and employee data. When in doubt, prefer creating an audit log entry over skipping it.

### DSGVO Employee Deletion = Anonymization

When an employee is "deleted" (DSGVO Art. 17), the system **anonymizes** instead of hard-deleting:

- **Employee**: firstName → "Gelöscht", lastName/employeeNumber → "GELÖSCHT-XXX", nfcCardId → null
- **User**: email → anonymized, passwordHash → "ANONYMIZED", isActive → false
- **Notes**: All notes in TimeEntries, LeaveRequests, Absences are set to null, and the reason of day-break acknowledgements (`DayBreakAck.reason`; rows kept)
- **Documents**: Absence documentPath → null
- **§ 9-Vorgänge**: Section9Credit documentPath → null, reason → null (Zeilen bleiben erhalten — Korrektureintrag nach R7)
- **Auth tokens**: Invitations, OTP, RefreshTokens are hard-deleted (not retention-relevant)
- **Role assignments** (Phase 74b, #74): the user's `RoleAssignment` rows are hard-deleted inside the anonymization transaction, each with a `DELETE` audit entry (`newValue.reason` "Anonymisierung"); person-scope lists that contain the employee's id stay unchanged (ids only — the resolution ignores anonymized targets). `User.role` IS rewritten to EMPLOYEE in the same update as `isActive: false` (Issue #357 sub-fix C, revises Phase 75b D-14, #75) and stays so while the column exists: it used to be the legacy-role fallback a still-valid access token resolved through, which handed a self-anonymizing MANAGER/ADMIN's live token full rights for the rest of its lifetime — the exact gap #357's security review reported. Since #539 (Release A) a user without a stored assignment holds nothing anyway, so the rewrite is defence in depth for a rollback to the previous image. Two neutrality cells changed on purpose (`DELETE /api/v1/employees/:id | foreign` for ADMIN and FALLBACK_ADMIN, 204→403) and are recorded as an amendment (`contexts/platform/anonymize.ts`, `apps/api/src/__tests__/neutrality/recorded/matrix-amendments.json`, ADR 0001-abweichungen Eintrag N).
- **Preserved**: TimeEntries, LeaveRequests, Absences, Schedules, OvertimeAccount, `ParentalLeaveReduction` rows (no free text, nothing to anonymize — Issue #468) (for retention compliance)
- **AuditLog**: userId → null (anonymized, not deleted)

## Data Retention (Aufbewahrungsfristen)

Legal retention periods (Germany):

| Basis                             | Retention                              | Reference            |
| --------------------------------- | -------------------------------------- | -------------------- |
| Arbeitszeitnachweis               | 2 years                                | § 16 Abs. 2 ArbZG    |
| Lohnkonten                        | 6 years                                | § 41 EStG            |
| Buchungsbelege (payroll-relevant) | 10 years                               | § 147 AO / § 257 HGB |
| DSGVO                             | Delete after longest retention expires | Art. 17 DSGVO        |

**Default retention: 10 years** (configurable per tenant, minimum 2 years). Retention period starts at end of calendar year of record creation. Deletion is NOT rolling — it happens annually (Stichtag), e.g., on Jan 1st for records whose retention expired on Dec 31st.

## Saldo Calculation & Monatsabschluss

Current: recalculated from hire date on every request (does not scale). Target architecture (SaldoSnapshot per month, Jahresübertrag, correction flow) — see GitHub issue #6.

- **Report Soll/Ist/Überstunden has one source (Issue #451, D-03).** `GET /reports/monthly` (JSON
  and both PDFs) reads `computeMonthReportFigures()` (`contexts/working-time-account/month-saldo.ts`)
  exclusively — the composition layer computes no Soll of its own. Leave-day counts printed in
  reports/DATEV go only through `leaveDaysByCodeWithin`/`leaveRequestDaysWithin`
  (`contexts/absence/leave-days.ts`) — the same priced, §9-netted day-counting kernel the absence
  context's own vacation calculation uses, never a separate calendar walk.
- **Sick days are counted in one place (Issue #84, D-14).** `sickLeaveDayCounts()`
  (`contexts/absence/sick-leave-days.ts`, exported via `contexts/absence/index.ts`) is the ONLY
  place the sick-day figure is derived: calendar days including weekends, clipped to the range, a
  half day counts 0.5, the attest split, the § 9 shift, sick leave type codes and
  `EFFECTIVE_LEAVE_STATUSES` only, with an optional per-day `countsDay` predicate (the dashboard
  uses it to attribute a day to a salon). `/reports/monthly` (JSON and both PDFs) and the dashboard
  team trend both call it — it used to live in `composition/reports.ts`, a business rule in the
  composition layer. `Absence` rows (imposed absences) never count as sick days.
- **`@db.Date` columns get calendar-day bounds, never a month/week instant (Issue #493).**
  `monthRangeUtc()` / `weekRangeUtc()` return tenant-local boundaries as UTC instants (local 1 Oct
  00:00 = `2026-09-30T22:00Z`); a Prisma filter or a JS clip on a `@db.Date` column
  (`TimeEntry.date`, `LeaveRequest`/`Absence` `startDate`/`endDate`, `Section9Credit` dates,
  `Shift.date`, `PublicHoliday.date`) against them takes in the previous local day. Month/week reads
  of those columns use `monthDateRange()` / `weekDateRange()`
  (`contexts/working-time-account/timezone.ts`, via its `index.ts`), or `monthDayBounds()` where
  only the instants are at hand — as a NEW variable, never by reassigning the instants. The instants
  stay for `@db.Timestamptz` columns (`Employee.hireDate/exitDate`, `WorkSchedule.validFrom`), the
  `SaldoSnapshot.periodStart` key (changing it orphans every closed month) and Stichtag lookups. The
  saldo/close paths still pass instants to the leave fetch on purpose — `closeEmployeeMonth` clips
  the rows, and changing the fetch could move a stored SHIFT_BASED saldo; leave them. Outputs
  produced before the fix: `apps/api/scripts/audit-493-month-boundary-leak.ts`.

## Releases & Deployment

**Read `docs/release-process.md` before cutting, tagging or deploying a release.** It is the
canonical order and it is NOT reconstructible from the workflows alone.

The three rules that get broken most often:

- **Bump the version BEFORE the tag.** The version is baked into the image from `package.json`
  (`apps/api/src/app.ts:59-65`); promotion is a digest-preserving re-tag with no rebuild, so tagging
  a pre-bump image makes `/api/v1/version` report the old version.
- **Never `kubectl set image` on int.** ArgoCD runs `selfHeal: true` and reverts it in seconds.
  Change `image.tag` in `k8s-homelab/argocd-apps/clokr-app.yaml` instead.
- **Write the German release notes BEFORE merging the release PR.** They live at
  `docs/release-notes/vX.Y.Z.md`, are baked into the API image (`apps/api/Dockerfile`) and shown
  in-app by the What's-New dialog; `release.yml`'s `publish-notes` job fills the GitHub Release
  body from that same file. Notes written after the merge can never be inside the image they
  describe — that is why the old "write them by hand afterwards" step no longer exists.

Environments: dev = local docker · int = k3s (ArgoCD) · prod = dmz-proxy (`/opt/awh-infra/.env`).
Refreshing int from prod data requires `apps/api/scripts/pseudonymize-dump.ts` — never restore a raw
prod dump to int. The refresh also neutralises every `OperatorAccount` (email, password hash, TOTP
secret — Phase 88, D-11), so no operator credential of prod survives on int.

## CVE / Security Vulnerability Handling

Trivy/Dependabot process (update direct/transitive/base-image, justify exceptions in `.trivyignore`, never lower severity, document in commit) → see `docs/cve-handling.md`.

## Time Entry Rules

- **One entry per day** per employee (multiple breaks allowed within that entry)
- Break model: `Break[]` records with startTime/endTime (legacy: `breakMinutes` integer)
- `openAdd()` on frontend redirects to edit if entry already exists for that day
- API POST rejects with 409 if entry already exists for employee+date
- **Every entry carries a required `salonId`** (FK onto `Salon`, `onDelete: Restrict`, Phase 68b / issue #68), decided by `resolveEntrySalon()` in `apps/api/src/contexts/time-tracking/entry-salon.ts` — the only place this rule lives: an explicit, active salon of the same tenant on manual entries, corrections, Zeitnachträge and the CSV import (400 `SALON_INACTIVE` when deactivated, 404 indistinguishable for a foreign or unknown id); otherwise `salonForDay()`, then the tenant's default salon, 409 `NO_ACTIVE_SALON` if none exists. Since Issue #87 the web clock-in (`POST /time-entries/clock-in`, optional `salonId`, never null) passes an explicit salon to `resolveEntrySalon()` (same 400/404 rules), while NFC and WIFI take no salon input (terminal binding: #541). The preselection and whether a choice is offered come only from `clockSalonChoice()` (`apps/api/src/contexts/time-tracking/clock-salon-choice.ts`, served by `GET /time-entries/clock-salon`): a booked day shows its fixed salon; at most one active salon, or exactly one current/future assignment salon (`currentAndFutureAssignmentSalonIds()`, Unterbau) equal to today's pattern salon, offers no choice; otherwise a choice preselected with `salonForDay()`. A deviation is never an error, and the #82 salon context never decides the clock salon. Re-clocking a day reopens its entry and never changes its salon — an explicit different salon is 409 `SALON_DIFFERS_FROM_DAY_ENTRY` (#70 will start a second entry instead). `PUT` may change the salon (never on a locked entry, never re-derived from a changed date). The salon hangs on the entry, not the day (#70).
- **Presence and working time come from one function (Issue #79).** `entryDurations()` and its
  fold step `addWorkingMinutes()` (`apps/api/src/contexts/time-tracking/entry-durations.ts`,
  exported via `contexts/time-tracking/index.ts`) are the ONLY place presence time (end − start)
  and working time (presence − the stored `breakMinutes`) are computed. Both are derived, never
  stored — no column, no migration, a locked month cannot drift. The values are exact minutes,
  unrounded and unclamped: a caller rounds or clamps around the call where it did before. The
  auto-break is never re-applied at read time — what the write path stored is what counts. An open
  entry is 0/0 in the kernel and `null` in `GET /time-entries` (`presenceMinutes`/`workingMinutes`
  per item; those are rounded per-entry display values that also cover invalid and non-WORK rows —
  never total them, period totals come from `/summary`). `GET /time-entries/summary` (`employeeId`, `from`, `to`, at most 366 days) sums
  presence, working time and breaks over the saldo's own entry set (T1: closed, valid, non-deleted
  WORK entries), so its `workingMinutes` equals the Ist the account counts from recorded entries
  (a scoped manager gets the sum over the entries in scope). It is NOT the account's full month
  Ist: the account additionally adds the Berufsschule credit (Azubi) and clamps entries to the
  hire/exit span, the summary does neither — never assert "same number" for those employees. `addWorkingMinutes`
  keeps the legacy association of the left folds (`(sum + presence) − break`) on purpose — never
  simplify it to `sum + workingMinutes`, that changes the last bit for millisecond-precision rows.
  `apps/api/src/__tests__/working-time-formula-one-place-79.test.ts` fails on an inline copy. The
  JArbSchG pre-write plan values (`plannedNetMin…`, `correctedNetWorkMin`) and shift netto
  (`scheduling/shift-netto.ts`) are deliberately different calculations and stay as they are.
- **Activity kind is an evaluation dimension, never working-time arithmetic (Issue #81).**
  `TimeEntry.activityKind` (`UNSPECIFIED` | `PRODUCTIVE` | `SETUP_CLEANING`, default `UNSPECIFIED`
  for existing and new rows — no classification is invented) is the kind of the entry's remaining
  working time; `TimeEntryActivityShare` rows (one per kind, whole minutes ≥ 1, never `UNSPECIFIED`,
  never the entry's own kind, `onDelete: Cascade` like `Break`) allocate parts of it to another
  kind. `activityMinutes()` (`contexts/time-tracking/activity-minutes.ts`, via `index.ts`) is the
  ONLY per-kind derivation — it reads `entryDurations()`, nothing is stored;
  `validateActivityState()` (`activity-shares.ts`) is the ONLY place Σ shares ≤ working minutes is
  enforced (409 with `maxShareMinutes`, never clamped) — PUT, POST (automatic break planned once
  before the write), `POST /:id/breaks`, revalidate and the retro approval call it. Written only
  through `POST`/`PUT /time-entries` (no own route or permission); an activity-only PUT is not a
  correction (no `CORRECTION` source, no Begründung, still audited and lock-bound). Clock paths write
  no classification; a clock re-open or a consolidation first turns a classified remainder into an
  explicit share (`materializeRemainder()`), so later time stays `UNSPECIFIED`, and a merge that
  would soft-delete an allocated entry is skipped. `GET /time-entries/summary` returns
  `activityMinutes` (optional `salonId` narrows the whole body; foreign or unknown salon → the same
  404) — minutes only, never amounts, rates or ratios. The working-time account, reports and the day
  kernel never read it (`activity-kind-saldo-isolation-81.test.ts`); saldo equality:
  `activity-kind-saldo-equality-81.test.ts`. UI and tenant switch (default off): #529.
- **Breaks are checked per day, across salons (Issue #80).** `evaluateDayBreaks()`
  (`apps/api/src/contexts/time-tracking/day-break-rule.ts`) is the ONLY place the day-level § 4
  rule and the § 3 day sum over several entries live — `checkArbZG`, the day-break routes
  (`api/day-breaks.ts`), the month-close detector (`cross-salon-days.ts`) and the next-day cron all
  call it, and `day-scope.ts` (`dayCoverage()`) is the only place "scope over every closed entry of a
  day" is decided. It sums all closed WORK entries of the day regardless of salon; a gap between
  entries in DIFFERENT salons never counts as a break (travel is working time, #92), a same-salon gap
  of ANY length does (Issue #523: the former 120-min cap is gone, § 4 ArbZG has no maximum for a
  Ruhepause, BAG 25.02.2015 – 5 AZR 886/12 Rn. 21; amendment register
  `fixtures/day-break-equivalence-80-amendments.json`). A break lying in a gap is a `DayBreak` (employee + date, no salon, never on an
  entry, never in `TimeEntry.breakMinutes`, never reduces working time — the saldo is untouched, an
  AST guard fails if a saldo file references the detector or the models). On a cross-salon day only a
  current `DayBreakAck` waives (an entry-level WAIVED does not); an ack whose stored snapshot no
  longer matches the day is stale (a stale, malformed or revoked ack never lets a day pass). Only a
  manager with `time-entry:update:ZUGEWIESEN` scope over EVERY entry of the day may acknowledge, never
  their own day; § 3 over the day sum is shown, never acknowledgeable. Acknowledging dismisses the
  open `BREAK_CROSS_SALON_VIOLATION` notices of that employee day for every recipient (reactive,
  after commit); a revoke does not resurrect them, because the cron dedupes on ANY existing row,
  dismissed or not. `GET /api/v1/day-breaks/checks` is the one read endpoint of every UI place and
  redacts by reach (partial scope: one neutral hint only - no totals, no finding category, no
  sum-bearing text, built from a number-free whitelist object; Issue #85 D-07). The
  month close blocks only under `blockMonthCloseOnUnconfirmedBreak`, for every schedule type, and
  never edits the saldo. The 09:00 (tenant time zone) cron (Feature 10 of the attendance checker)
  notifies once per recipient, employee and day for yesterday and the two days before it (3-day
  catch-up), full text only for recipients whose own reach covers the whole day (every other recipient
  gets the same neutral text as the redacted day check, title and mail subject included; Issue #85
  D-07). With one entry per
  day (#70 still open) every result equals the pre-80 behaviour, proven by the frozen-copy
  equivalence test (`day-break-equivalence-80.test.ts`; its frozen fixture is never edited, and a deliberate
  behaviour change enters only through the amendment register
  `fixtures/day-break-equivalence-80-amendments.json` with rule, reason and issue — #523 is the first).
  Since D-22 the kernel additionally returns the day's breaks as intervals with their source
  (`entry-break`, `day-break`, `same-salon-gap`, `unplaced-entry-break` = legacy `breakMinutes`
  without position, never placed), the gaps and the work blocks between breaks; Phase 80 warnings
  read only the minute sums, and § 4 Satz 2/3 are evaluated on that view inside the same kernel
  (next bullet, #511), never as a second evaluation elsewhere. The month-close detector is
  `break-finding-days.ts` (renamed from `cross-salon-days.ts`; wire fields `breakFindingDays` /
  `requiresBreakFindingAck`) and the cron emits `BREAK_CROSS_SALON_VIOLATION` or
  `BREAK_PLACEMENT_VIOLATION` per day. Details and the Shared-Kernel dependency:
  `docs/adr/0001-abweichungen.md` Eintrag X.
- **Break placement is checked in the same kernel (Issue #511).** `evaluatePlacement()`
  (`contexts/time-tracking/day-break-placement.ts`, called by `evaluateDayBreaks`) is the ONLY place
  § 4 Satz 2/3 ArbZG and § 11 JArbSchG are evaluated; the thresholds live once in `break-regime.ts`
  (`BREAK_REGIMES`). The regime is an input of the kernel, never read inside it:
  `breakRegimeFor(isMinorAtDate(birthDate, workDate))` (`contexts/absence/minor-at-date.ts`,
  fail-open to § 4 ArbZG; an AZUBI without a birth date gets a note in the finding). A break
  segment counts only if it is at least 15:00 exactly, lies inside the work period and touches
  neither the first start nor the last end (minors: also not in the first or last hour); a segment
  that does not count is working time for the compliance figure only, the saldo and
  `entryDurations()` stay untouched. A work block above 6 h (minors 4.5 h) without a counting
  segment is a finding independent of Satz 1. Legacy `breakMinutes` without Break rows give the
  hint `BREAK_POSITION_UNKNOWN`, never a violation, never a marker, notice or month-close block. A
  cross-salon gap is evaluated worst case and best case: `certainty` `VIOLATION` or `UNCLEAR`
  („Klärung nötig: Fahrzeit oder Pause?“), resolved only by a recorded `DayBreak` or an
  acknowledgement. The acknowledgement covers every day with an ackable finding
  (`hasAckableFinding()`, single-salon days included), its snapshot carries a placement key, and the
  web computes no § 4 at all (`GET /day-breaks/checks`, `POST /day-breaks/preview`; source guard
  `apps/web/src/lib/breaks/__tests__/arbzg-threshold-guard.test.ts` with two tracked exceptions,
  #525). The automatic break is placed by `placeAutoBreak()` at the conformant position nearest to
  `defaultBreakStart` in the TENANT time zone (minors: at least the § 11 amount, from 4.5 h);
  `scripts/audit-511-break-placement.ts` is the read-only dry run; closed months are never
  re-evaluated. A same-salon gap of any length is a counting segment when it is at least 15 min and lies inside
  the work period, and it ends a work block (#523 removed the 120-min cap of Phase 80 and with it the
  separator-only path); § 8 JArbSchG is not checked (#524). Details: `docs/adr/0001-abweichungen.md` Eintrag X, Nachtrag Phase 511.
- **Save responses show ArbZG warnings only within the reader's reach (Issue #85, D-12).**
  `warningsVisibleToCaller()` (`contexts/time-tracking/warning-visibility.ts`) is the ONE place: `PUT`
  and `POST /time-entries`, the on-behalf clock-out and the retro approval pass their warnings
  through it. A warning stays only when every non-deleted entry of the person inside its own window
  (day, day-1..day+1 for rest, the ISO week, 168 days for the 24-week average) is in the caller's
  `time-entry:read` reach; all withheld warnings collapse into one neutral `FINDING_WITHHELD` item.
  The person themself and a whole-tenant caller are unchanged. Accepted residuals: that a finding
  exists (notices, save responses) and the notification family stored as `type` - never a minute or
  a threshold.

## Public Holidays

- **The Bundesland lives on the salon (Phase 71b, issue #71).** `Salon.federalState` is required;
  `Tenant.federalState` is only the default a NEW salon inherits when none is given — no code reads
  it for statutory holidays. `PublicHoliday` rows are manual additions per salon (`salonId`
  required, unique `[salonId, date]`); statutory holidays are computed, never stored.
- **One resolution, in the Unterbau:** `holidaysAtWorkLocation()` / `holidaysForSalon()` in
  `apps/api/src/contexts/platform/facade/holiday-resolution.ts` are the ONLY place a holiday set is
  built. A holiday applies at the work location of that day (§ 2 EFZG): the salon of the employee's
  closed work entry on that day, else `salonForDay()`, else the tenant's default salon. Callers pass
  the `getWorkedEntriesInRange()` rows of their range — the Unterbau never reads `TimeEntry`. No
  active salon where one is needed → it throws (fail-closed).
- Outside `contexts/platform/` no production code computes holidays itself or reads `PublicHoliday`
  directly — `apps/api/src/__tests__/holiday-resolution-boundary.test.ts` fails on it, comments
  included.
- `Salon.federalState` is changeable only while no `TimeEntry` (soft-deleted ones included) and no
  salon assignment references the salon — else 409 `FEDERAL_STATE_IN_USE`. A move is a new salon.
- School holidays (`SchoolHolidayPeriod`, Berufsschule `federalStateOverride`) and the
  Christmas-Eve / New-Year's-Eve company rules stay tenant-wide.
- `GET /api/v1/holidays` never requires a salon (D-09, revised 2026-09-25): without `salonId` it
  returns the holidays of ALL active salons of the tenant, each item tagged with its `salonId`;
  with `salonId` only that salon (a foreign or unknown id gets the identical 404, T-100-09).
  Writes (`POST /api/v1/holidays`) still require `salonId` when the tenant has more than one active
  salon — 400 `SALON_REQUIRED` otherwise.

## ArbZG (Arbeitszeitgesetz) Rules

These rules MUST be followed when implementing or modifying ArbZG compliance checks:

- **§ 3 Daily max: 10h absolute limit** — this is the hard daily cap, never exceeded
- **§ 3 The 8h rule is a 24-week/6-month AVERAGE, NOT a daily limit!**
  - A 4-day week with 39h (= 9.75h/day) is perfectly legal
  - Only warn/error when the 24-week rolling average exceeds 8h per workday
  - Do NOT show warnings for individual days between 8h and 10h
- **§ 3 Weekly max: 48h** — hard weekly cap (Mo-Sa = 6 Werktage)
- **§ 4 Breaks**: >6h work = min 30min break; >9h work = min 45min break
- **§ 4 Satz 2**: a break segment shorter than 15 min is not a Ruhepause and does not count
  towards the 30/45 min (and never at the very start or end of the work period)
- **§ 4 Satz 3**: at most 6 h in a row without a Ruhepause of at least 15 min — also when the Satz 1
  sum is met (30 min at 14:00 after 08:00 is fine, 30 min at 14:30 is not)
- **§ 18 Abs. 2 ArbZG / § 11 JArbSchG**: for an employee under 18 on the work day § 11 JArbSchG
  replaces § 4 (> 4.5 h → 30 min, > 6 h → 60 min, segments of at least 15 min, at most 4.5 h in a
  row, no Ruhepause in the first or last hour); the age is decided per work date, not per today
- **§ 5 Rest period**: min 11h between end of work and start of next day
- **§ 8 BUrlG**: Leave and time tracking interaction rules:
  - **APPROVED leave**: Time entry creation is BLOCKED. Employee must request cancellation first.
  - **CANCELLATION_REQUESTED leave**: Time entries ARE allowed but created as `isInvalid: true`
    with reason "Urlaubsstornierung ausstehend". These entries don't count in saldo.
  - **When cancellation is approved** (→ CANCELLED): Invalid entries are automatically revalidated.
  - **When cancellation is rejected**: Entries stay invalid (manager can manually handle).
  - Cancellation always requires approval by a DIFFERENT manager (self-approval blocked).
  - Leave remains active (shown in calendar, counts for saldo) until cancellation is approved.

## Leave Cancellation Flow

1. Employee/Manager requests cancellation → status = `CANCELLATION_REQUESTED`
2. Leave remains active: shown in calendar (special styling), blocks regular time tracking
3. Time entries during this period: allowed but marked `isInvalid` (needs cancellation approval first)
4. Another manager approves cancellation → status = `CANCELLED`, time entries auto-revalidated
5. If cancellation rejected → status reverts to `APPROVED`, time entries stay invalid
   The statuses that count as active leave are defined once: `EFFECTIVE_LEAVE_STATUSES` (`apps/api/src/contexts/absence/effective-leave-statuses.ts`, exported via `contexts/absence/index.ts`, read through `getActiveLeaveOverlapping`) — saldo, Monatsabschluss, reports/DATEV, scheduling and calendars use it (Issue #446); `apps/web/src/lib/leave/effective-leave-statuses.ts` is a display mirror pinned to it by a test.

## Vacation Carry-Over & Cross-Year Booking

BUrlG §3/§7, EuGH carry-over rules, cross-year splitting, dynamic recalc, FIFO priority, carry-over validation with documented reasons → see `docs/burlg-carryover.md` (and GitHub issue #58).

- **Resturlaub (remaining, expired, at-risk) comes from one function (Issue #451, D-07).**
  `vacationBalanceForRow`/`getVacationBalance` (`contexts/absence/facade/vacation-balance.ts`) is
  the only place that computes it; every reader (Dashboard, Urlaubsübersicht, Urlaubs-PDFs, the
  carry-over expiry cron, `GET /leave/entitlements`, the admin Urlaubsverwaltung) reads this
  facade instead of re-deriving the arithmetic.
- **The regular yearly base value comes from one function (Issue #482).**
  `resolveVacationBaseDays()` (`contexts/absence/leave-days.ts`) is the only place the chain
  lives — `Employee.annualVacationDays`, then for an AZUBI
  `TenantConfig.defaultApprenticeVacationDays`, then `TenantConfig.defaultVacationDays`, then 30;
  the statutory floor is applied afterwards by the regular-entitlement formula. A settings or
  classification change writes no row by itself; new years, the #445 zero heal and the audited
  #447/#450 recomputes read the current value. No reader rebuilds the chain.

## Overtime Saldo Calculation (current)

`Saldo = Worked − Expected` over (hire-date or month-start) → yesterday. The live saldo never includes today, not even a clocked-out today: a clock-out for a lunch break closes the entry exactly like the end of the day, so a closed entry does not mean the day is settled (Issue #438). Leave/holidays/absences reduce expected, clamped to effective range. Recalculated per GET /overtime/:employeeId. Will be replaced by snapshot-based calc (see Saldo Calculation & Monatsabschluss above).

## Schedule Types

- `FIXED_WEEKLY` — fixed weekly hours with per-day allocation (e.g., 40h, Mo-Fr 8h)
- `MONTHLY_HOURS` — monthly hour budget for Minijobber/flexible workers
  - `monthlyHours` is an OWED monthly Soll (Issue #433, owner decision 2026-10-03), not a budget
    ceiling — null/0 is pure time tracking without Soll comparison AND never accumulates a saldo
    (Issue #494, owner decision 2026-10-06): `isTrackOnlySchedule()` in
    `apps/api/src/contexts/working-time-account/track-only-schedule.ts` is the ONE place the rule
    lives — a `MONTHLY_HOURS` contract with `monthlyHours` null/≤0 behaves exactly like
    `overtimeMode = TRACK_ONLY` regardless of the stored mode (live saldo 0, Monatsabschluss
    carry-over 0, an unclosed such month adds 0 to the live total). Its `monthlyHours` parameter
    is required so no caller can forget it; no reader re-derives it. Close/cron/recalc decide by
    the contract valid in the month, the live display by today's contract. Stored `overtimeMode`
    values are never rewritten and closed months keep their carry-over
    (`scripts/audit-494-track-only-carry.ts` lists them read-only); the admin form only DISPLAYS
    the lock („Überstunden-Modus" → „Nur erfassen").
  - No daily targets, no daily +/- display in calendar
  - Effective leave (all types incl. SICK), imposed absences, and statutory/manual holidays on a
    contractual workday reduce the owed Soll by `monthlyHours × 60 ÷ (contractual workdays of the
    FULL calendar month)` (Ø-Methode; a half day reduces by half; one `Math.round()` per computed
    range; a holiday on a non-workday reduces nothing). The contractual workday set is `workDays` →
    `TenantConfig.defaultWorkDays` → Mo–Fr, read ONLY by the private `monthlyHoursWorkDays()` in
    `apps/api/src/contexts/working-time-account/timezone.ts` — never `{day}Hours`.
  - Every display of a MONTHLY_HOURS month Soll (month view, dashboard, reports/PDF, web calendar
    header) is computed by `monthlyHoursMonthSollMinutes()` in `close-employee-month.ts` — the one
    place this rule lives; no caller derives its own formula.
  - A VOCATIONAL_SCHOOL (Berufsschule) day is credited to worked minutes only, never also a Soll
    reduction (one day reduces Soll exactly once).
  - `TenantConfig.monthlyHoursHolidayDeduction` is retired — no code reads or writes it; the column
    is dropped in a follow-up release (GitHub #470).
  - Closed months are never recalculated — `scripts/dry-run-433-monthly-hours-soll.ts` lists the
    affected stored months read-only; any correction is a deliberate correction booking.
- `WorkSchedule.validFrom` MUST be the 1st of a calendar month for every contract CHANGE (PUT `/api/v1/settings/work/:employeeId` and tenant-config bulk apply). Non-1st dates are rejected with HTTP 400 + German message `"Vertragswechsel sind nur zum Monats-1. erlaubt."` (see `apps/api/src/contexts/platform/month-first-date.ts` for the canonical constant `MONTH_FIRST_ERROR`). The initial schedule on employee creation (POST `/api/v1/employees`) is exempt — `validFrom = hireDate` may be any day, because contract START is not a contract CHANGE. Existing non-1st rows (pre-Phase-60) are preserved for audit-trail purposes; surface them via `pnpm --filter @clokr/api exec tsx scripts/audit-workschedule-non-month1.ts`. See GitHub issue #220.
- **`{day}Hours` is authoritative data only for `FIXED_SCHEDULE`.** For `FLEXTIME`, `MONTHLY_HOURS`
  and `SHIFT_BASED` the seven `{day}Hours` columns are a legacy 1/0 flag rather than hours;
  `workDays` is what carries the contractual information for those types. Measured against a
  pseudonymized production copy on `main`'s schema (2026-08-30, Phase 95b / GitHub issue #95):

  | Schedule type | rows | `{day}Hours` content | flagged by `audit-workdays-vs-day-hours.ts` |
  | --- | --- | --- | --- |
  | `FIXED_SCHEDULE` | 6 | real values (4.00 / 8.00 / 9.50) | 0 |
  | `FLEXTIME` | 1 | uniformly 1.00 | 1 |
  | `MONTHLY_HOURS` | 4 | uniformly 0.00 | 0 (by design — see the audit-script bullet) |
  | `SHIFT_BASED` | 15 | uniformly 8.00 or 1.00 | 4 (expected) |

- `WorkSchedule.workDays` is normalised **on write** to the set of weekday indices (0=Sun..6=Sat)
  where the corresponding `{day}Hours` value is > 0, on every create/update path (POST
  `/api/v1/employees`, PUT `/api/v1/settings/work/:employeeId` regular + cancelOrphanShifts
  branches, PUT `/api/v1/settings/work` applyToExisting bulk-apply) via `normalizeWorkDays()` in
  `apps/api/src/contexts/platform/calculate-work-days.ts`. **That is a write-path normalisation, not a statement
  about what stored rows mean.** Because its input hours are placeholders for every type except
  `FIXED_SCHEDULE`, the equality "`workDays` = days with `{day}Hours > 0`" describes reality for
  `FIXED_SCHEDULE` only. Since Phase 107 (D-02) no form write path routes `SHIFT_BASED` `workDays`
  through it at all. The audit that established the normalisation was Phase 61; its artefacts were
  archived with the milestone and are not in the repo.

- **Divergent legacy rows MUST NOT be "corrected" (Phase 95b, D-01).** Surface them with
  `pnpm --filter @clokr/api exec tsx scripts/audit-workdays-vs-day-hours.ts` — then leave them
  alone. `workDays` is the source of truth for leave consumption (`calculateWorkDays`) and pro-rata
  (`countWorkDaysPerWeek`), so aligning it to the placeholder hours replaces the RIGHT value with
  the WRONG one: the `MONTHLY_HOURS` rows (all day-hours 0.00) would end up with an EMPTY
  `workDays` and lose their Mo–Fr set, and the `FLEXTIME` row's deliberate 4-day week would become
  a 5-day week mid-year, changing retroactively what an already-taken leave day consumed. Phase 95b
  therefore changed not one data row — no migration, no backfill. This is not only
  Revisionssicherheit: the correction would be factually wrong.

- **The audit script checks ONE direction only, deliberately.** It reports a row when a day has
  `{day}Hours > 0` but is missing from `workDays`; it never reports the reverse (a day in
  `workDays` whose `{day}Hours` is 0), and it skips rows whose day-hours are all zero. A naive
  two-directional SQL query reports 9 rows where the script reports 5 — the 4 extra are exactly the
  `MONTHLY_HOURS` placeholder rows whose "correction" is the harmful one. `SHIFT_BASED` hits are
  labelled EXPECTED in the script's output for the same reason.

- **`SHIFT_BASED` (Phase 107, D-30).** For this type the contractual quantity is a COUNT, stored in
  `WorkSchedule.contractWorkDaysPerWeek Int?` (D-01) — not a weekday set. The concrete weekdays a
  `SHIFT_BASED` employee actually works come from the roster (`Shift`), never from `workDays`. The
  `{day}Hours` columns are placeholders and are NOT authoritative (`getScheduledHours()` in
  `apps/api/src/contexts/absence/api/leave.ts`, Phase 100 / OTC-04; `apps/api/src/contexts/working-time-account/shift-based-saldo.ts:53-57`).
  Since Phase 107 (D-02) no form write path touches `workDays` for `SHIFT_BASED` any more, so no NEW
  divergence can be created; existing divergent rows are preserved and are EXPECTED findings of
  `audit-workdays-vs-day-hours.ts`, not bugs — do NOT "fix" them on sight (Phase 95b, D-01).
- `contractWorkDaysPerWeekFrom()` in `apps/api/src/contexts/absence/leave-days.ts` is the ONLY place the
  `SHIFT_BASED` contractual-count fallback chain lives (`contractWorkDaysPerWeek` →
  `workDays.length` → `TenantConfig.defaultWorkDays.length` → `5`, Phase 107 D-04); `resolveContractWorkDaysPerWeek()`
  fetches the schedule and tenant config, then delegates to it (Phase 429) — it mirrors
  `resolveWorkDays()`'s shape but answers a different question ("how many days" vs. "which days").
  No other reader may rebuild this chain inline.
- `WorkSchedule.contractWorkDaysPerWeek Int?` — the `SHIFT_BASED` employee's contractual weekly
  workday count; `null` for every other schedule type (Phase 107, D-01).
- `WorkSchedule.usualWorkDays Int[] @default([])` (Phase 436, D-01; required for SHIFT_BASED
  writes since Issue #481) — the "übliche Arbeitstage" Angabe of a `SHIFT_BASED` contract ROW.
  Every write that creates or changes a `SHIFT_BASED` contract must name at least
  `contractWorkDaysPerWeek` days (`validateUsualWorkDays()` in
  `apps/api/src/contexts/platform/usual-work-days.ts`, German 400; owner decision 04.10.2026,
  Unterbau-Semantikänderung, ADR 0001-abweichungen Nachtrag Phase 481). Stored rows are never
  backfilled or guessed — an empty stored Angabe still means "keine Angabe" and is filled only
  through the audited `PATCH /api/v1/settings/work/:employeeId/usual-work-days` (same row, no new
  contract row, no repricing, no saldo or entitlement recompute). Non-empty is rejected with a
  German 400 for every other schedule type. It is authoritative ONLY for an angebrochene
  (fragment) leave week — a whole week always costs the contract days regardless of the Angabe. It
  is read ONLY through `usualWorkDaysFrom()` in `apps/api/src/contexts/absence/leave-days.ts` and
  is never derived from `workDays`, which remains the placeholder described above for
  `SHIFT_BASED`.
- `resolveLeaveDays()` (Phase 436, D-04/D-09) prices a `SHIFT_BASED` VACATION request as its
  marginal cost on its ISO weeks against the employee's earlier-created counted vacation requests
  (PENDING/APPROVED/CANCELLATION_REQUESTED, ordered by `createdAt` then id) — a second request in
  the same week costs only what it ADDS, not a second full price. Every caller passes a required
  `LeaveDaysPricing` argument and supplies `excludeRequestId` whenever it holds a request id (so a
  request is never priced against its own stored dates); approved requests are never re-priced
  implicitly — the Bestand surfaces only via the dry-run of
  `scripts/recalculate-shift-based-leave-days.ts` (no `--confirm`, writes nothing). That script
  skips requests ending before the employee's first non-deleted time entry (imported
  pre-tracking data) and, with `--before <YYYY-MM-DD>`, before that date; skipped requests are
  listed with their reason (Issue #481, D-09).
  Since Issue #481 every ISO week is priced with the contract valid IN IT, not the newest row: one
  `loadVacationContractSegments()` call per pricing (#450 segment semantics); the segment-aware
  kernels `countShiftBasedLeaveDaysBySegments` / `leaveDaysPerWeekBySegments` /
  `marginalShiftBasedLeaveDaysBySegments` in `vacation-calc.ts` (the scalar functions are
  one-segment delegates; the saldo's own `leaveDaysPerWeek` call is unchanged). A week whose
  REQUESTED dates fall into two segments is split and each part priced as a fragment (D-01/D-07);
  consecutive segments with identical count and Angabe are one pricing segment (PD-01). Other
  schedule types count each date with that date's workday set via `workDaysSetFrom()` in
  `leave-days.ts`, the only place that chain lives; the cross-year and report helpers follow
  through `prefixLeaveDays`.
- `LeaveRequest.daysProvisional Boolean?` — server-derived, set only at approval time; `true` when
  any day of a `SHIFT_BASED` leave request's period had no roster at calculation time (Phase 107,
  D-10/D-11). Never set by a client.
- **Bulk apply of the default working time is preview + confirm (Issue #568, § 3 NachwG).**
  `PUT /api/v1/settings/work` with `applyToExisting` never decides a contract change by itself.
  `POST /api/v1/settings/work/apply-defaults/preview` (read-only) computes the candidate set
  server-side; the apply needs `applyEmployeeIds` inside that set, the preview's `previewFingerprint`
  (409 `BULK_APPLY_PREVIEW_STALE` otherwise, nothing written) and an `effectiveFrom` that is a
  month-first and never before the tenant-local today (earliest: the next month-first, or today on the
  1st; at most 12 months ahead; 400 otherwise) — a working-time change must be communicated at the
  latest on the day it takes effect, so it is never retroactive. Only `FIXED_SCHEDULE` contracts and
  employees without a contract are candidates; a contract that differs from the stored defaults
  (`INDIVIDUAL`: hours, threshold, payout flag or the `workDays` set — a legacy row whose `workDays`
  diverge from its day-hours is never silently "corrected") is excluded unless the admin ticks it.
  A contract's `validFrom` is compared with `effectiveFrom` by its tenant-LOCAL calendar day (it is
  an instant), never by its UTC day. The config save, the new rows, one `CREATE WorkSchedule` audit
  per employee and one ids-only `BULK_APPLY` audit row run in ONE transaction serialised by a
  `FOR NO KEY UPDATE` lock on the Tenant row AND on the selected Employee rows (ordered by id; the
  per-employee `PUT /settings/work/:employeeId` takes the same Employee row lock and answers 409
  `CONTRACT_CHANGED_CONCURRENTLY` when the row at `validFrom` changed under it); the #450 vacation
  recompute and the saldo recalculation stay reactive after commit. The rule lives ONLY in `contexts/platform/bulk-apply-defaults.ts`; the
  web dialog (`BulkApplyDialog.svelte`) only chooses inside the preview and computes no date. Past
  applies are listed read-only by `scripts/audit-568-bulk-apply-history.ts`. Per-employee changes
  (`PUT /settings/work/:employeeId`) keep their rules (retroactive corrections stay possible there).

## UI Consistency Rules

Read these before modifying any page in `apps/web` — they are checked in, unlike anything under
`.planning/`, which is gitignored and therefore unreadable for anyone else:

| Source | What it governs |
| --- | --- |
| `apps/web/src/tokens.css` | The canonical v1.5 token set — every colour, radius and surface variable |
| `apps/web/.lintrc-tokens.txt` | The banned legacy patterns (`--color-*` / `--glass-*` / `--radius-*` / `--gray-*`) plus a replacement cheat sheet |
| `apps/web/src/app.css` | The shared class recipes — card surfaces, `.badge`, `.callout`, calendar cells, page wrapper, section stacking, summary bars, entrance animations |
| `apps/web/scripts/lint-ui-classes.mjs` | Which class names are allowed in the scoped primitive directories, and where that scope ends |
| `docs/ADMIN_STRUCTURE.md §3.2.1` | When a control saves instantly and when it waits for the section button (Phase 109, D-01/D-02) |

Reuse an existing recipe from `app.css` before inventing a class or a token.

`ConfirmDialog` swallows a refused `onConfirm` (Phase 89): the dialog stays open, the button is
re-enabled and nothing is rethrown, so a refusal is no unhandled rejection and needs no
`process.on("unhandledRejection")` allow-list in a test. `ReasonDialog` still throws to its
`ConfirmDialog` to keep its inline error.

Verify with `pnpm --filter @clokr/web lint:tokens` + `lint:ui-classes` + `lint:save-pattern`. Note
that `lint:ui-classes` only scans `lib/components/ui/` and `lib/components/layout/` — components
elsewhere (`lib/components/saldo/`, `calendar/`, `breaks/`, …) are outside that gate and need their
own mounted test instead.

## Svelte 5 Gotchas

- `{@const}` can only be used inside `{#if}`, `{#each}`, `{#snippet}` — NOT inside `<div>`
- Use `$derived` for computed values instead of `{@const}` in templates
- Use `preventDefault` from `svelte/legacy` for form handlers

<!-- Svelte MCP server (list-sections / get-documentation / svelte-autofixer) is self-documenting via system-reminder at session start. -->

<!-- GSD:project-start source:PROJECT.md -->

## Project

**Clokr — Production Readiness**

Clokr is a German-language, audit-proof time tracking and leave management SaaS for small to mid-size companies. It handles time entries, breaks, overtime saldo, leave requests with BUrlG-compliant carry-over, ArbZG compliance checks, NFC terminal integration, and multi-tenant administration. The app is feature-complete for v1 — this milestone focuses on making it production-ready.

**Core Value:** The app must be reliable, secure, and legally compliant enough to go live with real customers — no silent failures, no untested edge cases, no broken mobile experience.

### Constraints

- **Legal**: Must comply with ArbZG, BUrlG, DSGVO, and German retention requirements (§147 AO: 10 years)
- **Tech stack**: Existing stack (Fastify + SvelteKit + Prisma + PostgreSQL) — no migrations
- **Language**: UI in German, code/docs in English
- **Audit-proof**: No hard deletes, all mutations logged, locked months immutable
- **Docker**: Development and deployment via docker compose
<!-- GSD:project-end -->

<!-- GSD:stack-start source:codebase/STACK.md -->

## Technology Stack

## Languages

- TypeScript 6.0.2 - All backend and frontend source code
- Svelte 5.55.0 - UI components with runes syntax (`$state`, `$derived`, `$effect`, `$props`)
- JavaScript/Node.js - Runtime, build scripts
- SQL - Executed via Prisma

## Runtime

- Node.js 24-alpine - Container runtime for both API and web
- pnpm 10.33.0 - Workspaces package manager
- pnpm 10.33.0
- Lockfile: `pnpm-lock.yaml` (present)
- Workspace structure: `pnpm-workspace.yaml`

## Frameworks

- Fastify 5.8.4 - HTTP server for API (`apps/api`)
- SvelteKit 2.55.0 - Web framework with SSR/SSG for `apps/web`
- @sveltejs/adapter-node 5.5.4 - Node.js adapter for SvelteKit
- Prisma 7.6.0 - ORM layer
- @prisma/client 7.6.0 - Runtime client
- @prisma/adapter-pg 7.6.0 - PostgreSQL adapter
- PostgreSQL 18-alpine - Primary database
- Vitest 4.1.10 - Unit/integration test runner
- @vitest/coverage-v8 4.1.1 - Code coverage
- @playwright/test 1.58.2 - End-to-end testing (apps/e2e)
- @axe-core/playwright 4.11.1 - Accessibility testing
- Turbo 2.8.20 - Monorepo task runner
- Vite 8.0.2 - Frontend build tool
- @sveltejs/vite-plugin-svelte 7.0.0 - Svelte compilation
- TypeScript compiler (tsc) - Type checking
- tsx 4.21.0 - TypeScript Node runner for dev
- ESLint 10.1.0 - Linting (ES and TypeScript)
- @typescript-eslint/eslint-plugin 8.57.2 - TS linting rules
- eslint-plugin-svelte 3.16.0 - Svelte linting
- svelte-eslint-parser 1.6.0 - Svelte parsing
- Prettier 3.8.1 - Code formatting
- prettier-plugin-svelte 3.5.1 - Svelte formatting
- husky 9.1.7 - Git hooks
- lint-staged 16.4.0 - Pre-commit linting

## Key Dependencies

- @fastify/jwt 10.0.0 - JWT handling for API
- bcryptjs 3.0.3 - Password hashing
- @fastify/helmet 13.0.2 - Security headers
- @fastify/cors 11.2.0 - CORS middleware
- @fastify/rate-limit 10.3.0 - Rate limiting (500 req/min default)
- @fastify/swagger 9.7.0 - OpenAPI/Swagger documentation
- @fastify/swagger-ui 5.2.5 - Swagger UI at `/docs`
- @fastify/multipart 9.4.0 - File upload handling
- minio 8.0.7 - S3-compatible object storage client
- sharp 0.34.5 - Image processing (avatars)
- pdfkit 0.18.0 - PDF generation
- nodemailer 8.0.4 - SMTP email sending
- zod 4.3.6 - Schema validation
- date-fns 4.1.0 - Date utilities (web)
- date-fns-tz 3.2.0 - Timezone support (API)
- node-cron 4.2.1 - Scheduled tasks (monthly close, data retention, sync)
- chart.js 4.5.1 - Chart rendering
- @tanstack/svelte-query 6.1.10 - Server state management
- tailwindcss 4.2.2 - CSS framework
- postcss 8.5.8 - CSS processing
- autoprefixer 10.4.27 - CSS vendor prefixes
- pino - JSON logging (included via fastify)
- pino-pretty 13.1.3 - Pretty console output (dev)
- pino-roll 4.0.0 - Log file rotation
- @elastic/ecs-pino-format 1.5.0 - Elastic Common Schema formatting
- pg 8.20.0 - PostgreSQL driver

## Configuration

- `DATABASE_URL` - PostgreSQL connection string
- `REDIS_URL` - Redis connection (configured but not actively used in core)
- `JWT_SECRET`, `JWT_REFRESH_SECRET` - Auth tokens (min 32 chars)
- `ENCRYPTION_KEY` - Field-level encryption (min 32 chars)
- `CORS_ORIGIN` - Web app URL for CORS
- `APP_URL` - Frontend URL for email links
- `API_PORT`, `API_HOST` - API server binding (default 4000)
- `NODE_ENV` - development|production|test
- `SMTP_*` - Email server config (optional, can be set per-tenant in DB)
- `MINIO_*` - Object storage credentials
- `LOG_LEVEL` - Logging verbosity
- `LOG_FORMAT` - json|ecs|pretty
- `LOG_FILE` - Optional log file path with daily rotation
- `POOL_MIN`, `POOL_MAX` - Database connection pool
- `SEED_DEMO_DATA` - Bootstrap demo data on startup
- `tsconfig.json` - Present in all packages
- `vite.config.ts` - SvelteKit Vite config
- `.prettierrc` - 2-space indent, trailing commas, 100 char width
- `eslint.config.js` - Flat config with TypeScript, Svelte, Prettier

## Platform Requirements

- Node.js 24+ (uses ES modules)
- pnpm 10.33.0
- Docker & Docker Compose (for services: PostgreSQL, Redis, MinIO)
- Git with Husky hooks
- Docker/Kubernetes with Node.js 24-alpine base
- PostgreSQL 18
- Redis 7 (optional, configured but unused)
- MinIO (S3-compatible object storage)
- SMTP server (optional, configurable per tenant)
- PostgreSQL 18-alpine:5432
- Redis 7-alpine:6379
- MinIO:9000,9001 (S3 API + console)
- Optional backup service (pg_dump daily, 7-day retention)
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->

## Conventions

## Naming Patterns

- API route files: kebab-case, singular noun — `time-entries.ts`, `company-shutdowns.ts`, `audit-logs.ts`
- API utility files: kebab-case — `vacation-calc.ts`, `password-policy.ts`, `timezone.ts`
- API plugin files: kebab-case — `prisma.ts`, `audit.ts`, `auto-close-month.ts`
- Svelte pages: SvelteKit convention — `+page.svelte`, `+layout.svelte`
- Svelte components: PascalCase — `Toast.svelte`, `EmptyState.svelte`, `CommandPalette.svelte`, `Breadcrumb.svelte`
- Svelte stores: camelCase — `auth.ts`, `toast.ts`, `theme.ts`
- Test files: `{name}.test.ts` in `__tests__/` directories
- camelCase for all functions — `requireAuth`, `seedTestData`, `checkArbZG`, `calcBreakMinutes`
- Route registrations: `async function {domain}Routes(app: FastifyInstance)` — e.g., `employeeRoutes`, `timeEntryRoutes`, `leaveRoutes`
- Utility exports: named exports of pure functions — `getHolidays()`, `todayInTz()`, `validatePassword()`
- Helper functions in route files: module-scoped, private (not exported) — `calcBreakMinutes()`, `validateBreakSlots()`, `checkOverlap()`
- camelCase for all variables — `adminToken`, `empUser`, `vacationType`
- Constants: UPPER_SNAKE_CASE for domain constants — `TYPE_CODES`, `LEAVE_TYPE_DEFS`, `LEGACY_ALIASES`, `CACHE_TTL_MS`
- State variables in Svelte: `let varName = $state(initialValue)` — `let loading = $state(false)`, `let entries: TimeEntry[] = $state([])`
- PascalCase for all types and interfaces — `JwtPayload`, `ArbZGWarning`, `CalDay`, `AuthState`
- Prefix `Props` for Svelte component props interfaces
- Zod schemas: camelCase with `Schema` suffix — `createEmployeeSchema`, `idParamSchema`, `loginSchema`, `manualEntrySchema`

## Code Style

- Prettier (v3.8+) with `prettier-plugin-svelte`
- No explicit Prettier config file found (uses defaults: double quotes, trailing commas, semicolons)
- Pre-commit hook via Husky runs `lint-staged` which applies `eslint --fix` and `prettier --write`
- ESLint v10 with flat config at `/eslint.config.js`
- TypeScript ESLint recommended rules
- Svelte ESLint plugin (flat/recommended)
- Key rules:
- Strict mode enabled in both `apps/api/tsconfig.json` and `apps/web/tsconfig.json`
- Target: ES2022 (API), extended from SvelteKit (Web)
- `esModuleInterop: true`, `skipLibCheck: true`, `forceConsistentCasingInFileNames: true`

## Language Conventions

- All user-facing strings, error messages, and labels are in German
- Examples: `"Mitarbeiter nicht gefunden"`, `"Ungültige Anmeldedaten"`, `"Konto temporär gesperrt"`
- Code comments are **English**, without exception (see the Language section above). German
  appears only inside user-facing string literals; German domain nouns (`Monatsabschluss`,
  `Zeitnachtrag`, `Revisionssicherheit`, `Betriebsurlaub`, `ArbZG`) stay untranslated when named
  inside English prose. Legacy files still contain German comment prose — that is drift to fix on
  sight in a file you are already editing, not a convention to follow (GitHub issue #131)
- All variable names, function names, type names in English
- Domain-specific German terms kept where they are proper nouns: `Monatsabschluss`, `Sonderurlaub`, `Betriebsurlaub`, `ArbZG`

## Import Organization

- `$lib` -> `src/lib`
- `$components` -> `src/lib/components`
- `$stores` -> `src/lib/stores`
- `$api` -> `src/lib/api`

## Error Handling

- Global error handler in `apps/api/src/app.ts` catches ZodErrors and converts them to `{ error: string, message: string, details: [] }` with HTTP 400
- All other errors return `{ error: string }` with appropriate status code
- German error messages for user-facing responses: `"Validierungsfehler"`, `"Interner Serverfehler"`
- Return early with `reply.code(XXX).send({ error: "German message" })` — no `throw`
- Common HTTP codes used:
- `ApiError` class in `apps/web/src/lib/api/client.ts` wraps fetch errors with `status`, `message`, `data`
- Automatic 401 handling: tries token refresh, redirects to `/login` on failure
- Toast notifications for user-visible errors via `toasts.error("message")`
- Client-side error logging via `apps/web/src/lib/utils/logger.ts` which sends errors to `/api/v1/logs/client`

## Logging

- Structured JSON logging in production, `pino-pretty` in development
- ECS (Elastic Common Schema) format available via `LOG_FORMAT=ecs`
- Optional file logging via `LOG_FILE` env var with daily rotation (`pino-roll`)
- Request context enrichment: `userId`, `tenantId`, `role` added via `onRequest` hook
- Request completion logged via `onResponse` hook with method, URL, status, response time
- `clientLogger` at `apps/web/src/lib/utils/logger.ts` batches and sends errors to `/api/v1/logs/client`
- `console.error` and `console.warn` allowed by ESLint config
- `console.log` produces lint warnings

## Comments

- Section separators: `// ── Section Name ──────────────────` used throughout route files and app.ts to visually separate logical blocks
- JSDoc-style comments for utility functions that have non-obvious behavior — see `apps/api/src/contexts/working-time-account/timezone.ts`
- Business-rule context comments are **English** (see § Language Conventions above). `// Einladung nur erstellen wenn kein Passwort gesetzt` in `apps/api/src/contexts/platform/api/employees.ts` is a legacy example of the OLD, no-longer-followed pattern, not a convention to imitate — it is drift to fix on sight in that file, not here (Issue #131)
- TODO comments for known future work: `// TODO(owner-gate): construct once the Phorest web-calendar URL format is pinned.`
- Used sparingly — mainly on exported utility functions and plugin interfaces
- Declare module augmentation blocks use JSDoc for plugin-decorated properties:

## Function/Route Design

- Each route file exports a single async function: `export async function fooRoutes(app: FastifyInstance)`
- Zod schemas defined at module top as `const` — `createSchema`, `updateSchema`, `idParamSchema`
- Route definition uses `app.method(path, { schema, preHandler, handler })` inline object syntax
- Validation: `schema.parse(req.body)` or `schema.parse(req.params)` inside handler (throws ZodError caught by global handler)
- Swagger tags use German domain names: `tags: ["Mitarbeiter"]`, `tags: ["Auth"]`
- Use `fastify-plugin` (`fp`) wrapper for plugins that decorate the app instance
- Declare module augmentation for type safety
- Example at `apps/api/src/contexts/platform/plugins/audit.ts`, `apps/api/src/contexts/platform/plugins/prisma.ts`

## Svelte 5 Patterns

- Use `$state()` for component-local reactive state: `let loading = $state(false)`
- Use `$derived()` for computed values: `let visible = $derived(items.slice(-5))`
- Use `$effect()` sparingly — prefer `onMount` for initialization
- Stores use `svelte/store` writable pattern (not Svelte 5 runes) for cross-component state: `apps/web/src/lib/stores/auth.ts`
- Define `interface Props` then destructure: `let { children }: Props = $props()`
- Use default values in destructuring: `let { icon = "inbox", title, description }: Props = $props()`
- Snippet-based children: `children?: import("svelte").Snippet`
- Direct `api.get()` / `api.post()` calls inside `onMount` or event handlers
- `@tanstack/svelte-query` is listed as a dependency but not currently used in routes (direct fetch pattern prevalent)
- Loading/error state managed locally per page
- Scoped `<style>` blocks in each component — no Tailwind utility classes in markup (Tailwind v4 installed but CSS is primarily custom)
- CSS custom properties for theming (v1.5): `var(--brand)`, `var(--text)`, `var(--bg-card)` — defined in `apps/web/src/tokens.css`. Legacy `--color-*` / `--glass-*` / `--radius-*` / `--gray-*` are banned (see UI Consistency Rules).
- Global styles in `apps/web/src/app.css` (~1476 lines) with theme system (`data-theme` attribute)
- Four themes: `pflaume` (default), `nacht`, `wald`, `schiefer`
- BEM-like class naming: `.admin-tab`, `.admin-tab--active`, `.toast-container`, `.empty-state-title`
- Responsive via `@media` queries in component styles

## Module Design

- Route files: single named export — `export async function fooRoutes(app: FastifyInstance)`
- Utility files: multiple named exports of pure functions
- Plugin files: single named export — `export const fooPlugin = fp(async (app) => { ... })`
- Store files: single named export — `export const authStore = createAuthStore()`
- `@clokr/db`: Prisma client + generated types — imported as `import { PrismaClient } from "@clokr/db"`
- `@clokr/types`: Shared TypeScript interfaces — imported as `import { Role } from "@clokr/types"`

## Configuration Pattern

- Validated with Zod schema at startup in `apps/api/src/config.ts`
- Fails fast with detailed error output if validation fails
- Exported as typed `config` object: `export const config = parsed.data`
- Never accessed via `process.env` in route/plugin code — always through `config`

## Soft Delete Convention

- Models with `deletedAt` field (TimeEntry, LeaveRequest, Absence) use soft delete
- All queries on soft-deletable models MUST include `deletedAt: null` in the where clause
- Example: `where: { employeeId, deletedAt: null }`

## Multi-Tenancy Convention

- All data-access queries filter by `tenantId` from `req.user.tenantId`
- Employee lookups always scoped to tenant
- Tenant-specific config accessed via `TenantConfig` model
- Route files (`contexts/*/api/**`, `composition/dashboard.ts`, `composition/reports.ts`) build an
  `EmployeeScope` only via `employeeScopeFor(accessContextFromRequest(req), …)` from
  `contexts/platform` (#77), never as an object literal (`route-employee-scope-literals.test.ts`
  fails on one); jobs use `accessContextForJob(tenantId, job)`. Both, like `employeeScopeWhere()`,
  throw `AccessContextError` on an empty tenant (500 via `app.ts`; a foreign id stays 404). Keep
  `const tenantId = req.user.tenantId` for Prisma filters — the gate below reads only that (#226).
- **The salon context in the web is presentation, never an access boundary (Issue #82, DSGVO
  Art. 32).** `GET /api/v1/me/context` (`requireAuth`, own data, API key → 400) returns the tenant,
  `isMultiSalon` (`isMultiSalonTenant()`, #64), `homeSalonId` and the ACTIVE salons the caller
  reaches — `id` and `name` only. `contextSalonIds()` (`contexts/platform/facade/role-assignments.ts`,
  not re-exported from `index.ts`) is the ONLY place "salons the caller can reach" is computed: the
  managed part from the same building blocks (stored role assignments only, #539) as `resolveAccessReach`, pinned equal over every ZUGEWIESEN key by
  `context-salon-ids-82.test.ts`, plus the salons of the caller's own current or future salon
  assignments. In the web, `$stores/salon-context` holds the selection: `showSalonOptions()` is the
  ONLY place of the #64 rule (options only with more than one active salon in the tenant AND more
  than one reachable), one reachable salon is preselected without a choice, several default to
  "Alle Salons". The stored value (`localStorage` `clokr.salonContext.<tenantId>.<userId>`, removed on
  logout) is re-validated against the fresh list on every load (forced on mount, throttled after
  in-app navigation), and `selectedSalonId()` is the value a view passes as `salonId` (`null` = every
  reachable salon). No endpoint reads a salon context from a header, cookie or session; an endpoint
  that takes `salonId` validates it itself — proof: `salon-context-manipulation-82.test.ts`. The
  tenant-side salon admin (`/admin/salons`, Issue #563) calls `salonContext.load(…, { force: true })`
  after every successful create, edit, deactivate and activate.
- **Opening hours live only on the salon (Issue #563).** `Salon.openingHours` is the only source.
  `TenantConfig.storeHours` is retired (strip on write, omit on read via `RETIRED_TENANT_CONFIG_COLUMNS`
  in `contexts/platform/api/settings.ts`; the column is dropped by #638) and the mirror
  `syncSoleActiveSalonOpeningHours()` is gone. `admin/system` keeps only `shiftStoreHoursMode` (a tenant
  policy, minimal payload `{ shiftStoreHoursMode }`). `/admin/salons` (list and detail, create at
  `/admin/salons/neu` with an explicit Bundesland) uses the tenant API `/api/v1/salons` and the facade
  shared with the operator console — quota (#566), `FEDERAL_STATE_IN_USE`, never delete and the
  identical 404 are unchanged; it is visible with `salon:read` and changes need `salon:manage`. The
  `/shifts` week view dims closed days from `salonOpeningHours` of `GET /shifts/week` (the salons in the
  caller's `shift:read` reach) through `closedDaysFor()` — the one salon in view or the chosen one, a hint
  otherwise, never a merged value. The guard is `store-hours-readers.test.ts` (api, db and web, exactly
  one allowed occurrence). Details: `docs/adr/0001-abweichungen.md` Eintrag L, Nachtrag Phase 563.
- **The dashboard Team block follows the salon context (Issue #84).** The web decides whether to
  filter only through `teamSalonFilter()` (`apps/web/src/lib/dashboard/team-view.ts`): it is guarded
  by `showSalonOptions`, because the store preselects a sole reachable salon and that preselection
  must not turn into a filter (D-11). `GET /dashboard/team-trend`, `/team-week` and
  `/team-upcoming-leave` validate `salonId` in the module-private `resolveTeamSalonFilter()`
  (`composition/dashboard.ts`): the salon must be active, belong to the tenant and lie inside the
  caller's team-overview reach; every rejection is the same 404 body, before any read — the filter
  narrows, it never widens. Attribution under a filter: working time follows the ENTRY's salon
  (closed, valid WORK entries through the tenant-local yesterday, summed with `addWorkingMinutes`),
  absences follow the Stammsalon per calendar day (`homeSalonsForDays()`, Unterbau, D-13). Soll and
  saldo are contract figures and are NEVER split by salon: under a filter they are `null` with
  `sollUnavailableReason` `SALON_FILTER`, and Soll is shown at all only with `overtime:read`
  covering every shown person (`NO_PERMISSION` otherwise, D-17). Unfiltered figures equal
  `/reports/monthly` (`computeMonthReportFigures`, including the snapshot and the Berufsschule
  credit, which no salon receives). Presence status and holidays use ALL of a person's entries, so a
  day worked in another salon is never a false „Fehlt“ (D-15); `workedElsewhere` and `salonId` appear
  in the team-week response only under a filter. `/reports` has no salon filter yet (follow-up issue).
  **Scoped callers follow the per-entry rule (Issue #85, D-04/D-06),** which replaces the Phase 84
  "the filter only removes rows" reading for them: on `/team-week`, `/today-attendance` and
  `/team-trend` the population is the Stammsalon persons UNION the persons with an in-scope entry
  (`scopedTimeEntryIds` + `getRecordedWorkEntriesByIds`), contract, leave, absences and holidays
  are read for the Stammsalon persons only, shifts are read for every listed person and shown only
  if `isShiftInScope` admits them (Phase 91b D-11: the shift's own salon or a person in reach,
  never the Stammsalon, so a Springer listed by an in-scope entry sees the reach's own shifts), a
  day whose only shift is out of scope reads exactly like a day without a shift (no `shift`, no
  SHIFT_BASED workday, no due time, no marker), a row listed only by an entry is never „Fehlt“
  (its absence reasons are held by the Stammsalon; an in-scope shift not yet due makes it
  „Geplant“, Issue #548), and hours come only from in-scope entries.
  Time the caller cannot see is a neutral `workedElsewhere` and never a live clock-in. The account
  Ist is used only for a person-month whose every entry is in scope; otherwise the in-scope sum is
  shown and `workedBasis` is `SCOPE_ENTRIES` (Soll then `null`, `sollUnavailableReason`
  `SCOPE_ENTRIES`). Whole-tenant callers run the unchanged statements. The web reads the new values
  in `team-view.ts` only.
- **The employee list follows the master-data rule (Issue #547).** `GET /employees` narrows a scoped
  `employee:read` reach with `resolvePersonScopedEmployeeIds` (the single view's rule) plus the
  caller's own row, and returns `overtimeAccount.balanceHours` only under an `overtime:read` reach
  that covers the person, else `null`. A Salonmanager therefore sees neither a foreign salon's
  people nor their saldo in the list.
- **The Salonansicht (Issue #85, D-08/D-09/D-13).** `GET /time-entries?salonId&from&to` (at most 31
  days, `time-entry:read:ZUGEWIESEN` only) returns every in-scope entry recorded in that salon for
  all persons, Springer included, with no sums. `resolveSalonInReach()`
  (`contexts/platform/facade/salons.ts`) is the ONE validator of a chosen salon - the dashboard's
  team endpoints and the salon view both call it, every rejection is the same 404 body before any
  read, and nothing else may rebuild that check. In the web `/team/time-entries` decides the salon
  only through `teamSalonViewSalon()` (`apps/web/src/lib/dashboard/team-view.ts`), never through the
  raw selection getter; a break-notification link to a person outside the narrowed list opens the
  Salonansicht of the linked month (D-14). A role without saldo rights sees the person view without
  the saldo cards, Ist only (a 403/404 on the saldo reads is a calm state, not an error).

### Operator principal and tenant deactivation (Phase 88, Issue #88)

The operator is the account ABOVE the tenant (tenant create, rename, deactivate, reactivate). Rules,
as built (`docs/adr/0001-abweichungen.md` Eintrag Y):

- **A separate principal, never a role.** `OperatorAccount` is no `User` and no `Role` value. Its sign-in
  with a mandatory TOTP lives in `contexts/platform/operator-credentials.ts` and
  `contexts/platform/api/operator/auth.ts`; accounts are created only with
  `apps/api/scripts/operator-account.ts`. There is no registration route.
- **Own optional secret.** `OPERATOR_JWT_SECRET` (`config.ts`) is distinct from `JWT_SECRET` and
  optional: unset, no operator route is registered and the surface is absent (404), proven by
  `operator-surface-off-88.test.ts`. Never default it, never fall back to `JWT_SECRET`.
- **Two guards that refuse each other.** `requireOperator` accepts only operator tokens,
  `requireAuth` only tenant tokens; presenting the wrong kind answers 403 and writes an
  `OperatorAuditLog` row (`operator-auth-88.test.ts`, `tenant-principal-guard-88.test.ts`).
- **An MFA reset or a deactivation ends every issued operator token at once (Issue #557).**
  `OperatorAccount.tokenVersion` is incremented in the same transaction as the `OPERATOR_MFA_RESET` /
  `OPERATOR_DEACTIVATED` audit row (`newValue.sessionsRevoked`) and is carried by every operator token as
  the claim `ver`. `requireOperator` (every request, never cached) and `/verify` (the pending challenge)
  compare it only through `operatorTokenIsCurrent()` in `contexts/platform/operator-auth.ts`; a token
  without an integer `ver` is refused with 401.
- **Operator code is blind to tenant data.** Files under `contexts/platform/api/operator/` never read
  `req.user`, never build an access context (`employeeScopeFor`, `accessContextFromRequest`), never call
  `app.audit()` and never read `user`, `employee` or `auditLog`; every route carries a rate limit. A
  source scan in `operator-auth-88.test.ts` fails on a violation. Operator responses carry tenant
  metadata and, since Phase 89, salon master data including the Phorest branch id — never employee
  data and never counts (no time-entry, assignment or employee numbers, Issue #89 D-14a), with two
  documented exceptions. **The SECOND documented exception (Issue #93):** person data under an active
  support access — the operator reads a curated, read-only slice of ONE tenant's person data, only
  through `composition/operator-support-ports.ts`, never in the route files themselves (see the
  support-access bullet below); D-14a still binds every other operator response.
  **The first documented exception (Issue #90):**
  `GET /api/v1/operator/dashboard` is the only operator response that carries numbers — per tenant
  the active and total salons, the active employees (not anonymized, not exited before today, UTC)
  and the UTC day of the newest login of any user of the tenant, plus totals and the inactive flag.
  They are computed only by `operatorTenantMetrics()` in
  `contexts/platform/facade/operator-metrics.ts` (Unterbau, deliberately NOT re-exported from
  `index.ts`); aggregates only, never a person, a person's id, a time entry or a saldo, and the
  operator route files themselves still never read the person models. The inactivity threshold
  lives once in `OPERATOR_INACTIVITY_DAYS` (30) and is served as `inactivityDays`; a tenant is
  inactive only when it is not deactivated and has no login or none within that window. Every
  successful call writes `DASHBOARD_VIEWED` (retention class AUTH_EVENT, 12 months) in the same
  transaction. D-14a still binds every other operator response, and the dashboard is no precedent
  for a new number. Known limit: the facade reads no `TimeEntry`, so a tenant that only clocks at
  terminals shows as inactive. Details: `docs/adr/0001-abweichungen.md` Eintrag Y, Nachtrag
  Issue #90. The ONE FILE that writes operator-actor rows into a
  tenant `AuditLog` is `contexts/platform/operator-tenant-audit.ts` (first-admin creation, salon and
  coupling changes; actor `{ type: "OPERATOR", operatorId, tenantId }`; guard
  `operator-tenant-audit-89.test.ts` fails on any other file spelling that actor shape). Rows
  written since Phase 89 carry `actor.tenantId`, and the tenant `GET /audit-logs` shows them
  labelled „Betreiber“ — the salon and coupling rows as well as the first-admin creation rows of a
  tenant the operator created. Operator rows written before Phase 89 carry no stamp and stay
  invisible to the tenant (append-only, not backfilled).
- **Support access (Issue #93, Phase 93b).** A time-boxed, read-only, logged operator view of one
  tenant's person data; ADR `docs/adr/0001-abweichungen.md` Eintrag Y, Nachtrag Issue #93.
  - **Grant.** `SupportAccess` (Unterbau, an Erweiterung; `Tenant` and `OperatorAccount` FKs
    `onDelete: Restrict`) carries a reason of 10–500 trimmed characters and a duration of 1 / 4 / 8 / 24 h
    (default 1 h, never a free end time). `assertActiveSupportAccess()` in
    `contexts/platform/support-access.ts` is the ONE decider of "active": `endedAt` null AND
    `expiresAt > now` on the application clock, derived on every request, no cron; tenant and operator
    must match and a deactivated tenant is refused (409 `TENANT_DEACTIVATED`). One active grant per
    operator and tenant — a second request is 409 `SUPPORT_ACCESS_ALREADY_ACTIVE`, there is no silent
    extension; after an end or an expiry a NEW request with a new reason is needed. Creation takes the
    Tenant row `FOR NO KEY UPDATE` in READ COMMITTED (the race proof observes the block).
  - **Reads.** Seven operator routes: lifecycle under `/api/v1/operator/tenants/:id/support-access`
    (request, own history, end) and four curated GET reads under `…/support/…` (employees, one
    employee's month, contracts, the tenant audit log) with `Cache-Control: no-store`; no write method
    exists under `/support/`. Every read re-checks the grant INSIDE its audit transaction under the
    grant row's `FOR SHARE` lock (`runSupportRead`, `lockGrant`), so an end waits for in-flight read
    audits and no read audit follows a committed end. The data comes only from the ports of
    `composition/operator-support-ports.ts` and three allow-list facade reads (time-entries, day
    breaks, leave requests); excluded everywhere: free-text notes, reasons, documents, attests and
    day-break acknowledgements. `support-access-boundary-93.test.ts` pins grant-first, audit-first,
    GET-only and tenant-scoped ports by a source scan.
  - **Double protocol, audit first.** Every read writes `SUPPORT_DATA_READ` to the `OperatorAuditLog`
    (with IP) AND to the tenant `AuditLog` (actor-stamped, no IP) in ONE transaction BEFORE the read:
    no log, no data; a read that fails afterwards leaves an "attempted read" row. A refusal is 403
    `SUPPORT_ACCESS_REQUIRED` plus a `SUPPORT_ACCESS_REFUSED` row; start and end write
    `SUPPORT_ACCESS_STARTED` / `SUPPORT_ACCESS_ENDED` to both logs.
  - **Audit-log read is redacted by TYPE (D-17).** `redactSupportAuditValue()`
    (`contexts/platform/support-audit-redaction.ts`) keeps numbers, booleans, null, numeric strings,
    ISO dates/timestamps, UUIDs and UPPER_SNAKE control values and the structure; every other string
    becomes "[ausgeblendet]". Never a key-name deny-list — the next new free-text field would pass it.
    Window mandatory, at most 92 UTC calendar days, 50 rows per page.
  - **Tenant side.** `GET /api/v1/support-accesses` and `/:id` (`audit-log:read`) and
    `POST /api/v1/support-accesses/:id/end` (`tenant-settings:update`), both whole-tenant; the tenant
    sees the operator's `displayName` (never e-mail or IP), the reason, the window, the status and every
    read. A tenant end writes the `OperatorAuditLog` row with `operatorId` null and the tenant user in
    `newValue`. The operator's own end stays possible for a deactivated tenant (it only narrows the access). The web
    page „Support-Zugriffe“ under `/admin` lists, details and ends. At start every whole-tenant holder
    of `tenant-settings:update` gets an in-app notice (mail policy `never`; the link only for holders of
    `audit-log:read`, never a dead link), dismissed on end.
  - **Immutability and retention.** The second DB trigger of the project (after the `OperatorAuditLog`
    one): a `SupportAccess` row is never deleted and never edited, except the single NULL → value
    transition of `endedAt`/`endedBy`/`endedByUserId`; DELETE only under the flagged retention purge
    (`purgeExpiredSupportAccess`, 120 months, floored in the trigger), TRUNCATE refused. Test cleanup
    disables the trigger only inside `cleanupTestData`, never in app code. Limits (a DB table owner
    can drop the trigger; the reason is operator-authored free text; a grant outlives the 15-minute
    operator token): ADR Nachtrag Issue #93.
- **The operator console (Phase 89, Issue #89).** The UI lives at `/betreiber` in the same web app
  as the route group `(operator)`, with its own `sessionStorage` session (`$stores/operator-auth`,
  keys `clokr.operator.accessToken` / `.expiresAt`) and its own client `lib/operator/client.ts`
  without a refresh: a 401/403 sends the browser to `/betreiber/anmelden` with a `safeNext()` next
  path. The isolation scan `operator-isolation-89.test.ts` fails when an operator file imports the
  tenant session, client, logger or salon context. `hooks.server.ts` sets `frame-ancestors 'none'`
  and `X-Frame-Options: DENY` on `/betreiber`; the client logger drops its queue there, so operator
  errors never reach the tenant log endpoint. Nothing in the tenant app links to `/betreiber`, and
  the console pins theme nacht / skin editorial / comfortable without writing the device's stored
  preferences (it restores them on leaving). Since Issue #90 the start page shows an „Übersicht“
  and the tenant list the columns Salons, Mitarbeitende and Letzte Aktivität with an „Inaktiv“
  badge, loaded with one `GET /operator/dashboard` next to the tenant list request. Logout clears the tab's session but cannot revoke the
  15-minute token server-side (accepted, T-89-14). The salon routes
  (`contexts/platform/api/operator/salons.ts`) call only the Unterbau salon facade and the coupling
  port of `composition/operator-salon-ports.ts` (Schichtplanung `facade/couplings.ts`); every
  change writes the `OperatorAuditLog` rows AND the tenant `AuditLog` rows in one transaction; a
  salon is never deleted (deactivate/activate only); the Bundesland is required on create; the
  coupling is Phorest or none. The `.card-animate` transform traps fixed dialogs inside an animated
  `Section` (#570) — the tenant page's „Mandant“ section therefore has no `animate`. Follow-ups:
  #567 (tenant-create SLUG/EMAIL conflict classification), #566 (packages per tenant).
- **Tenants are deactivated, never deleted.** `ACTIVE_TENANT_WHERE` (`contexts/platform/tenant-status.ts`)
  is the one spelling of "active tenant" in a query. A deactivated tenant is refused on every credential
  path (login after the password matched, OTP, refresh, password reset, invitation accept) and on every
  request of an already issued access token, API key or device key. The per-process state cache holds
  at most 10 s and is invalidated by `app.invalidateTenantState()` on every (de)activation. There is
  no tenant delete path and the business data is untouched.
- **Booked packages per tenant (Phase 566, Issue #566).** `Tenant.bookedModules` (`TenantModule`:
  `CHAIN`, `INTEGRATIONS`, `HARDWARE_CLOCK`, `ANALYTICS`) and `Tenant.salonQuota` (≥ 1, DB CHECK
  `Tenant_salonQuota_positive`) are written only by the operator (`PUT /api/v1/operator/tenants/:id/packages`;
  `TENANT_PACKAGES_CHANGED` in `OperatorAuditLog` plus the tenant `AuditLog` row `TenantPackages`, one
  transaction, nothing written for an unchanged body). They are decided only in
  `contexts/platform/tenant-packages.ts`: the effective salon limit is the quota with `CHAIN`, else 1; a
  create or activation takes the Tenant row `FOR NO KEY UPDATE` BEFORE it counts (lock order Tenant → Salon),
  and the operator write takes the same lock; a refusal is 409 `SALON_QUOTA_REACHED` / `MODULE_NOT_BOOKED`
  (`{ error, code }`, mapped once in `app.ts` through `PackageRefusalError`). The Grundversion (everything the
  law requires, system roles, roster, reports, one active salon) is never gated. Modules gate only setting up
  something NEW — nine sites: `createSalon` (active) and `activateSalon` (every caller: tenant, operator,
  provisioning), `createSalonCoupling` and the create branch of `setSalonCoupling` (replacing and removing
  stay free) plus the create branch of `PUT /integrations/phorest/config`, `POST /api-keys`,
  `POST /terminals`, `POST /admin/presence-sources`; and the `activityMinutes` of `GET /time-entries/summary`
  (`null` + `activityMinutesUnavailableReason: "MODULE_NOT_BOOKED"`; recording an activity stays free).
  Never retroactive: cancelling a module or lowering the quota deactivates, revokes and locks nothing, and
  reads, reports, PDFs, DATEV and exports keep working (`tenant-packages-never-retroactive-566.test.ts`).
  `packages-legal-core-isolation-566.test.ts` (AST) proves the legally required paths read no package and
  pins every gate before its create. `isMultiSalonTenant()` / `showSalonOptions()` never read packages. The
  web only displays: `GET /me/context` `packages` (`bookedModules`, `salonLimit`), `moduleBooked()` in
  `$stores/salon-context` (unknown state hides nothing) and `ModuleHint` at exactly five set-up spots under
  `/admin` (the fifth, Issue #563: the salon create action on `/admin/salons` when `CHAIN` is not booked and
  the active salons reach the salon limit; never in clock, calendar or dashboard; existing items stay
  manageable). Test fixtures book
  everything (`FIXTURE_PACKAGES`, so recorded neutrality cells stay unchanged); package tests build their
  tenant with `seedGrundversionTenant`. Existing tenants keep what they use (migration
  `*_tenant_packages`, Bestandsschutz); run the read-only dry run `scripts/audit-566-package-backfill.ts`
  on int and prod BEFORE the deploy (`docs/migrations.md`, „Phase 566“). Extended roles are not gated yet
  (#624). ADR: `docs/adr/0001-abweichungen.md` Eintrag Z.
- **Jobs: writing jobs skip, retention never skips.** Cron jobs that write (month close, attendance
  checks, Phorest sync, reminders) skip a deactivated tenant; the data-retention purge deliberately
  runs for it, because retention is a legal duty that does not end with the contract. The source-scan
  guard `cron-deactivated-tenants-88.test.ts` fails on a job without the filter.
- **Provisioning and employee creation each live in one place.** `tenant-provisioning.ts`
  (`provisionTenantWithAdmin`; tenant, config, first admin, invitation) and `employee-creation.ts`
  (also the invitation rule) — the employee route and the operator flow call the same code
  (`employee-creation-parity-88.test.ts`). Seeds carry a pinned copy of the provisioning rule because
  `packages/db` cannot import `apps/api` (`tenant-provisioning-88.test.ts` compares them). The
  default leave types of a new tenant are seeded through the composition seam
  `composition/tenant-onboarding.ts` and `ensureDefaultLeaveTypes()` of the absence context — the
  Unterbau never imports a business context.
- **A nullish tenant never reaches a Prisma call.** Prisma DROPS a filter whose value is `undefined`,
  so `where: { tenantId: undefined }` reads every tenant. `lint:tenant-scoping` fails on an optional
  tenant value in any Prisma call under `apps/api/src` (`lint-tenant-scoping-nullish-tenant.ts`); the
  fail-closed form is `?? ""`. The runtime twin is `operator-tenant-boundary-sweep-88.test.ts`.
  **A tenant token without a tenant is refused in one place (Issue #551).** Since #551 `requireAuth`
  refuses a verified tenant token (JWT or API key) whose `tenantId` is blank, whitespace-only, absent
  or not a string with 403 `{ error, code: "TENANT_REQUIRED" }`, before any permission check and before
  any query; no credential path issues such a token (login after the password matched, verify-otp,
  resend-otp, refresh before the rotation, change-password); `effectiveGrants` grants a blank tenant
  nothing (no legacy-role fallback). The rule lives only in `isBlankTenantId()`
  (`contexts/platform/tenant-status.ts`, defined in the zero-import leaf `access-context-error.ts`).
  `scripts/audit-551-users-without-employee.ts` lists the affected users (read-only).
  **An account without any permission is refused at sign-in in one place (Issue #539).** `POST
  /auth/login` (after the password matched, before any OTP row or mail; audited as `LOGIN_REFUSED`
  with reason `NO_ROLE_ASSIGNED`), `verify-otp` and `refresh` (before the rotation, the stored token
  stays untouched) answer 403 `NO_ROLE_ASSIGNED_ERROR` (`{ error, code: "NO_ROLE_ASSIGNED" }`,
  defined in `contexts/platform/request-permissions.ts`, applied in `api/auth.ts`) when
  `effectivePermissionKeysForUser()` is empty; a wrong password keeps its 401. The code is the control
  value, the German text only display (the web shows the server's message and branches on neither).

### Tenant-scoping gate (Issue #204)

A new route or service handler that reads a client-supplied identifier into a tenant-scoped
Prisma model without constraining it to `req.user.tenantId` fails CI, not just review:

| Source | What it governs |
| --- | --- |
| `apps/api/scripts/lint-tenant-scoping.ts` | The gate itself — scope, methods, and the three ways a call counts as scoped |
| `apps/api/scripts/lint-tenant-scoping-exceptions.json` | Every deliberate exception, each with a mandatory reason |
| `apps/api/scripts/lint-tenant-scoping-nullish-tenant.ts` | The nullish-tenant rule (Phase 88): an optional tenant value reaching a Prisma call fails the same gate |
| `apps/api/scripts/README.md` § Lint gates | How to add a justified exception, and when NOT to |

Since Phase 89 the gate also accepts two strict inline forms: an `OR` only when every branch is
itself scoped, and a Json-path stamp `{ path: [..., "tenantId"], equals: <principal tenant> }` with
no other key (`apps/api/scripts/README.md` § `lint-tenant-scoping.ts`).

Each exception carries `validatedBy`, a text anchor quoting its tenant check (Issue #620; it replaced
the never-verified line number `validatedAt`). The gate resolves it on every run - it must still
occur in the file, mention the tenant and lie near a listed call - so a moved or reworded check
turns the run red while pure line shifts do not.

Verify with `pnpm --filter @clokr/api run lint:tenant-scoping`. A hit on a clean tree is a
finding to report (Issue #204), not an exception to add.

### Anti-vacuity gate (Issues #235/#240/#245)

A file that walks the source tree and asserts on the result without proving the walked set was
non-empty fails CI and `.husky/pre-commit`, not just review — a moved or emptied directory must
turn the gate red, never let it report success having checked nothing:

| Source | What it governs |
| --- | --- |
| `apps/api/scripts/lint-guard-vacuity.ts` | The gate itself — the AST classifier, `--check`/`--scope`/`--rows` |
| `apps/api/scripts/lint-guard-vacuity-exceptions.json` | Every deliberate exception, each with a mandatory reason |
| `apps/api/scripts/README.md` § Lint gates | How to add a justified exception, and when NOT to |
| `docs/adr/0001-abweichungen.md` Eintrag I | The as-built outcome, the exception register, and what this gate structurally cannot see |

Verify with `pnpm --filter @clokr/api exec tsx scripts/lint-guard-vacuity.ts --check 0`. A hit on a
clean tree is a finding to report, not an exception to add.

### T-100-09 route gate (Issue #259)

A tenant-scoped route with a path parameter that answers a foreign tenant's real entity
differently from an id that exists nowhere (a distinguishable status or body — a tenant-membership
oracle) fails CI, not just review — the tenant-scoping gate above only checks that the Prisma call
is scoped, not that the REJECTION is indistinguishable:

| Source | What it governs |
| --- | --- |
| `apps/api/scripts/lint-t100-09-routes.ts` | The completeness gate — every path-parameter route must have exactly one register entry |
| `apps/api/scripts/lint-t100-09-routes.json` | The register: `probe` / `nicht anwendbar` / `bekannt-abweichend`, each with a measured reason |
| `apps/api/src/__tests__/t100-09-oracle-probe.test.ts` | The behavioral half — every `probe` route hit twice, status+body byte-compared |
| `apps/api/scripts/README.md` § Lint gates | The three categories, the two named out-of-scope boundaries, and how to add a justified entry |

Verify with `pnpm --filter @clokr/api run lint:t100-09-routes --check` (completeness) and
`pnpm --filter @clokr/api exec vitest run src/__tests__/t100-09-oracle-probe.test.ts` (behavior). A
hit on a clean tree is a finding to report, not an exception to add.

### Role-check gate and neutrality recordings (Issue #75)

Since Phase 75b the API decides access by permission, never by role. Since #539 (Release A) a
permission comes ONLY from stored role assignments: there is no legacy-role fallback, so a user
without a stored assignment holds nothing, and an active account whose effective permission set is
empty is refused at sign-in with 403 `NO_ROLE_ASSIGNED` (login, verify-otp and refresh). No token
carries a `role` claim any more (an old token that still has one is ignored — proven by
`token-claims-539.test.ts`), the login body has no `user.role`, and `actorRole` is no longer written
to new leave audit rows. `User.role` is only a **rollback-safety column derived from the user's role
assignments** — written back by `deriveCompatRole()` in
`apps/api/src/contexts/platform/compat-role.ts` after every assignment change (so a rollback to the
previous image finds consistent values), and read by exactly three documented readers, pinned by
`legacy-role-reads-539.test.ts`: the company-PDF role filter (D-12), the write-back comparison of
`syncCompatRoleColumn` (D-06) and the takeover script. The employee form's role is derived from the
stored assignments (`null` shows „Keine Rolle zugewiesen“). Before deploying Release A to any
instance, run `apps/api/scripts/backfill-539-role-assignments.ts` (dry run, then `--confirm` when it
lists users; runbook: `docs/migrations.md` „Phase 539“). Column and enum go with Release B
(#641). A role comparison, a `requireRole(` call or a Prisma `where` on a role value in
non-test `apps/api/src` fails CI and `.husky/pre-commit`:

| Source | What it governs |
| --- | --- |
| `apps/api/scripts/lint-role-checks.ts` | The gate itself — AST scan, the single allowlisted file `contexts/platform/compat-role.ts`, no exceptions file |
| `docs/permissions.md` | Every guard, handler check and recipient lookup with its permission; `permission-site-mapping.test.ts` compares counts and permissions per file |
| `apps/api/src/__tests__/permission-neutrality-matrix.test.ts` + `neutrality/recorded/matrix.json` | Every route × eight actors, recorded on the code BEFORE the switch |
| `notification-recipients-neutrality.test.ts` / `activity-auth-neutrality.test.ts` + `recorded/*.json` | The 17 recipient lookups; activity feed and login role, same rule |
| `docs/adr/0001-abweichungen.md` Eintrag N | What changed, the transition rules, and what was measured |

Verify with `pnpm --filter @clokr/api run lint:role-checks` and (after `test:setup`)
`pnpm --filter @clokr/api exec vitest run src/__tests__/permission-neutrality-matrix.test.ts`.
**Never re-record a neutrality file to make it green** — the recorders refuse once `requireRole`
is gone, and a red VERIFY is a finding (an access change), not a stale fixture. A new route gets
`requirePermission` and a row in `docs/permissions.md`; a new role check is never the answer.

### Ordered audit/notification reads in tests (Issue #561)

A test never picks an `AuditLog` or `Notification` row with `findFirst` (ordered or not), nor
indexes an unordered `findMany` by position — one action can write several rows in the same
millisecond, the test flakes in the parallel run (#555), and even an ordered `findFirst` silently
ignores a second write. Use `soleAuditRow[OrNull]()` / `soleNotification[OrNull]()` (throws unless
exactly one row matches), `auditRowsFor()` / `auditRowChangingField()` from
`apps/api/src/__tests__/setup.ts`, or a `findMany` with explicit length / all-row assertions; when a
test means one of several rows, narrow the `where` (action, recipient, field). `lint:unordered-test-reads`
(`apps/api/scripts/lint-unordered-test-reads.ts`, CI and pre-commit, no exceptions file) fails on it;
a hit is converted, never excepted.

### Role management UI and the admin area (Issue #83)

- **Permission labels live once, on the server.** `contexts/platform/permission-labels.ts` holds the
  German heading per resource (the `docs/permissions.md` headings) and the German label per catalog
  key; `GET /api/v1/roles/permission-catalog` (`role:read`) serves them. `permission-labels.test.ts`
  pins the label set equal to the catalog; the web never names a permission
  (`permission-labels-one-place-83.test.ts`). A new catalog key needs a label in the same commit.
- **The four-eyes rule of #78 stays in the API.** The role editor (`/admin/roles`) reacts only to the
  409 code `FOUR_EYES_CONFIRMATION_REQUIRED` (create, update and copy) and resends with
  `confirm: true` after an explicit confirmation; every other rejection shows the server's message.
- **The web decides `/admin` access by permission, in one module.**
  `apps/web/src/lib/nav/admin-route-permissions.ts` maps every admin route to alternatives of all-of
  permission sets derived from the API guards its page calls; the admin layout guard, Sidebar, the
  mobile „Mehr“ sheet and the command palette read it. A new admin route needs an entry
  (`admin-route-permissions.test.ts` fails otherwise). Page-internal role checks that change content
  are #538; the fallback is gone since #539 Release A (owner decision, Unterbau Semantikänderung), the web session
  carries no role and the employee screen shows „Keine Rolle zugewiesen“ for a person without an assignment;
  dropping the column and the enum is Release B (#641).
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->

## Architecture

## Pattern Overview

- Three-tier architecture: SvelteKit SPA (client-only rendering) -> Fastify REST API -> PostgreSQL via Prisma ORM
- Multi-tenant isolation via `tenantId` on every employee-scoped query
- Plugin-based API composition using Fastify's `register` + `decorate` pattern
- All data mutations produce audit log entries for compliance (Revisionssicherheit)
- Soft-delete on all core models (`deletedAt`) -- never hard-delete time/leave/absence data
- Background cron jobs run in-process via `node-cron` (no external job queue)

## Layers

- Purpose: REST API handling all business logic, authentication, validation, and data access
- Location: `apps/api/src/`
- Contains: Route handlers, Fastify plugins, middleware, utility functions, tests
- Depends on: `@clokr/db` (Prisma client), `@clokr/types` (shared types)
- Used by: Web frontend via HTTP proxy, NFC terminals, external API keys
- Purpose: SvelteKit SPA serving the UI; no server-side data fetching, all API calls from browser
- Location: `apps/web/src/`
- Contains: Svelte 5 components (runes), stores, API client, route pages
- Depends on: `@clokr/types` (shared types)
- Used by: End users (employees, managers, admins) via browser
- Purpose: Prisma schema, generated client, seed data
- Location: `packages/db/`
- Contains: `packages/db/prisma/schema.prisma`, generated Prisma client, seed script
- Depends on: PostgreSQL (via `@prisma/adapter-pg`)
- Used by: API server (imports `@clokr/db` for all DB access)
- Purpose: Shared TypeScript type definitions between API and web
- Location: `packages/types/src/index.ts`
- Contains: Role, Employee, TimeEntry, LeaveRequest, OvertimeAccount interfaces
- Used by: Both `@clokr/api` and `@clokr/web`
- Purpose: Model Context Protocol server for Claude Code dev tooling
- Location: `packages/mcp/src/index.ts`
- Contains: MCP tools for querying the Clokr API during development
- Used by: Claude Code during development only
- Purpose: Tauri desktop app for NFC card-based clock-in/out at physical terminals
- Location: `apps/nfc-client/`
- Contains: Tauri Rust shell + web frontend, communicates with API
- Used by: Physical NFC terminal hardware
- Purpose: Playwright end-to-end tests
- Location: `apps/e2e/`
- Contains: Playwright test specs, config

## Data Flow

- Client-side state uses Svelte writable stores (`$stores/auth.ts`, `$stores/toast.ts`, `$stores/theme.ts`)
- Page-level state uses Svelte 5 `$state` and `$derived` runes within each `+page.svelte`
- No global state management library; each page fetches its own data via `api.get()` in `onMount`
- Auth tokens persisted in `localStorage`

## Key Abstractions

- Purpose: Encapsulate cross-cutting concerns as decoratable services on the Fastify instance
- Examples: `apps/api/src/contexts/platform/plugins/prisma.ts`, `apps/api/src/contexts/platform/plugins/audit.ts`, `apps/api/src/contexts/platform/plugins/mailer.ts`, `apps/api/src/contexts/platform/plugins/notify.ts`, `apps/api/src/contexts/platform/plugins/storage.ts`, `apps/api/src/contexts/scheduling/plugins/scheduler.ts`
- Pattern: Each plugin uses `fastify-plugin` (`fp()`) to register, calls `app.decorate()` to add services, and augments the `FastifyInstance` type via `declare module "fastify"`. Accessed everywhere as `app.prisma`, `app.audit()`, `app.notify()`, `app.mailer`, `app.storage`.
- Purpose: Group related API endpoints by domain
- Examples: `apps/api/src/contexts/time-tracking/api/time-entries.ts`, `apps/api/src/contexts/platform/api/employees.ts`, `apps/api/src/contexts/absence/api/leave.ts`, `apps/api/src/contexts/platform/api/auth.ts`
- Pattern: Each exports an `async function xxxRoutes(app: FastifyInstance)` that registers GET/POST/PUT/DELETE handlers. Registered in `apps/api/src/app.ts` with URL prefix (e.g., `{ prefix: "/api/v1/time-entries" }`).
- Purpose: JWT/API-key authentication and permission-based authorization (Phase 75b, Issue #75)
- Location: `apps/api/src/middleware/auth.ts` (authentication only) + `apps/api/src/contexts/platform/request-permissions.ts` (authorization), reached through `contexts/platform/index.ts`
- Pattern: `requireAuth` verifies JWT or API key (`clk_` prefix). Access decisions use catalog permissions (`docs/permissions.md`): `requirePermission("<resource>:<action>:<reach>")` / `requireAnyPermission(...)` as `preHandler`, `hasPermission(req, key)` / `permissionReach(req, "<resource>:<action>")` inside a handler, `userIdsHoldingPermission(db, tenantId, key)` for notification recipients. `requireRole` no longer exists, and a role comparison in `apps/api/src` fails `lint:role-checks` (see "Role-check gate" below). A new route states its permission and gets a row in `docs/permissions.md`.
- Purpose: Cron-based background tasks running in the API process
- Plugins: `apps/api/src/contexts/time-tracking/plugins/attendance-checker.ts` (6 cron jobs), `apps/api/src/contexts/scheduling/plugins/scheduler.ts` (Phorest sync), `apps/api/src/contexts/working-time-account/plugins/auto-close-month.ts` (monthly close), `apps/api/src/contexts/platform/plugins/data-retention.ts` (annual archival)
- Pattern: Each plugin registers cron tasks via `node-cron`, starts in `onReady` hook, stops in `onClose` hook. Tasks are tenant-aware (loop over all tenants).
- Purpose: Typed HTTP client wrapping fetch with auth token injection and auto-refresh
- Location: `apps/web/src/lib/api/client.ts`
- Pattern: `api.get<T>()`, `api.post<T>()`, `api.put<T>()`, `api.patch<T>()`, `api.delete<T>()`. Auto-retries on 401 after token refresh. Throws `ApiError` with status code.
- Purpose: Separate authenticated app pages from public auth pages via layout groups
- `(app)` group: `apps/web/src/routes/(app)/` -- requires auth, has sidebar/nav layout
- `(auth)` group: `apps/web/src/routes/(auth)/` -- public pages (login, registration, password reset)

## Entry Points

- Location: `apps/api/src/index.ts`
- Triggers: `tsx watch src/index.ts` (dev) or `node dist/index.js` (prod)
- Responsibilities: Calls `buildApp()` from `apps/api/src/app.ts`, starts Fastify on configured port
- Location: `apps/api/src/app.ts`
- Triggers: Called by `index.ts` and by test setup
- Responsibilities: Creates Fastify instance, registers all plugins, middleware, and routes. Exports `buildApp()` for both production and test usage.
- Location: `apps/web/src/hooks.server.ts`
- Triggers: SvelteKit server startup
- Responsibilities: API proxy (forwards `/api/*` to Fastify backend), CSP headers, structured logging
- Location: `apps/web/src/routes/+page.svelte`
- Triggers: Navigation to `/`
- Responsibilities: Redirects to `/dashboard` (if authenticated) or `/login` (if not)
- Location: `apps/api/src/config.ts`
- Triggers: API startup
- Responsibilities: Validates all environment variables via Zod schema, exits with error if invalid

## Error Handling

- **Zod validation errors**: Global Fastify error handler in `apps/api/src/app.ts` catches `ZodError`, returns 400 with German field-level messages (`"Validierungsfehler"`)
- **Auth errors**: Middleware returns 401/403 directly via `reply.code()`
- **Business logic errors**: Route handlers return specific HTTP codes (404, 409, 422) with German error messages
- **Client errors**: `apps/web/src/lib/api/client.ts` throws `ApiError` with status and message, consumed by page-level `try/catch`
- **Client-side logging**: `apps/web/src/lib/utils/logger.ts` captures `window.onerror` and `unhandledrejection`, sends to `POST /api/v1/logs/client`
- **Server errors**: Fastify logger (Pino) with structured JSON output; supports pretty (dev), JSON, and ECS (Elastic) formats

## Cross-Cutting Concerns

- API: Pino via Fastify, configurable format (pretty/json/ecs), optional file output via `pino-roll`
- Web server: Structured JSON logging in `hooks.server.ts`
- Client: `clientLogger` in `apps/web/src/lib/utils/logger.ts` sends errors to API endpoint
- Request logging: `onResponse` hook logs method, URL, status, response time
- All API input validated via Zod schemas defined at the top of each route file
- Environment variables validated via Zod in `apps/api/src/config.ts`
- Frontend relies on API-side validation; forms submit and display API error messages
- JWT-based with access/refresh token pair
- API key support (`clk_` prefix) for programmatic access
- Terminal API keys for NFC devices (separate model)
- Session timeout with client-side inactivity detection
- Account lockout after configurable failed attempts
- Every employee belongs to a `Tenant` via `tenantId`
- JWT payload includes `tenantId`; all queries filter by it
- `TenantConfig` holds per-tenant settings (work hours, SMTP, compliance rules, etc.)
- Background jobs iterate over all tenants
- `app.audit()` plugin creates `AuditLog` entries with userId, action, entity, entityId, old/new values, IP, user agent
- Required for all create/update/delete operations on core models
- SYSTEM user ID used for automated actions (cron jobs)
<!-- GSD:architecture-end -->

<!-- GSD:workflow-start source:GSD defaults -->

## Delivery Process

**Read `docs/PROCESS.md` before triaging issues, planning a milestone, or wondering where a
piece of work should come from.** Short version:

- `Capture → Inbox → Triage → Ready → GSD → Ship → Release`
- Board: **Clokr Delivery** (https://github.com/users/sebastianzabel/projects/1), Status
  `Inbox / Backlog / Ready / In Progress / In Review / Done`, 2-week iterations. Work type is
  the `bug`/`feature`/`chore` **label**, not a board field.
- **GitHub Milestone = GSD Milestone. GitHub Issue = GSD Phase.** A plan is GSD-internal and
  has no GitHub counterpart.
- **Max. 5 issues per sprint.** New work in means old work out — back to Backlog, not
  alongside. Chores do not count.
- **`Ready` is a contract, not a mood:** acceptance criteria complete, Iteration
  + Milestone set. **Do not start a phase from an issue that is not Ready** — the acceptance
  criteria are the input to `/gsd-discuss-phase`.
- `main` is the only line. The 1.9.x patch line is retired; there are no release branches.

`.planning/` is gitignored, so an issue can never link to a planning artifact. The commit
scope (`fix(104-11): …`) is what ties issue and phase together in the history.

## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:

- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.

**The commands are `/gsd-<name>`, never `/gsd:<name>`.** Those are two different products. GSD's
development moved to `open-gsd/gsd-core` (npm `@opengsd/gsd-core`) in May 2026 over trust and
ownership concerns about the former upstream; the predecessor `get-shit-done-cc` is frozen at
1.42.3 (last published 2026-05-23) and is not to be installed. A stale local copy of it lived in
this repo's gitignored `.claude/` until 2026-09-22 and shadowed every command with a colon-named
twin — running `/gsd:update` would have reinstalled the abandoned package. It is gone; only the
global gsd-core install remains. If a colon-named command reappears, something reinstalled the
wrong package.

## Worktree Merge Safety

When GSD executor worktrees merge back into the main branch, **the merge can silently overwrite changes from a previous plan** if both plans modified the same file. This has caused data loss before (Phase 04-03 DATEV changes overwritten by Phase 05-03 worktree merge).

**Mandatory steps after every worktree merge:**

1. Run `git diff HEAD~1 HEAD -- <files-the-plan-touched>` immediately after the merge commit
2. Verify that the expected changes from the previous plan are still present in each shared file
3. If any changes are missing, create a restore commit immediately — do not continue with the next plan
4. Files most at risk: any file modified by more than one plan in the same phase (e.g. `reports.ts`, `schema.prisma`)

**When merging a PR to main:** always run `git diff <branch>..main` before the PR is considered complete to catch any regressions introduced by the merge commit itself (e.g. reviewer edits on GitHub that don't flow back to the local branch).

<!-- GSD:workflow-end -->

<!-- GSD:profile-start -->

## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.

<!-- GSD:profile-end -->
