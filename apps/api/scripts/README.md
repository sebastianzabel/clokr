# apps/api/scripts/

One-off operator and migration-artifact scripts. Inventory every script here,
classified by lifecycle.

## Classification

| Script                                         | Date       | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Classification                                |
| ---------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| diagnose-saldo.ts                              | 2026-06-08 | Read-only diagnostic of updateOvertimeAccount inputs for one employee                                                                                                                                                                                                                                                                                                                                                                                                                                           | Migration artifact (Phase 76.5)               |
| fix-bogus-reset-snapshots.ts                   | 2026-06-08 | One-off cleanup of pre-tracking-reset SaldoSnapshot rows leaking carryOver                                                                                                                                                                                                                                                                                                                                                                                                                                      | Migration artifact (Phase 76.5)               |
| backfill-mai-shifts.ts                         | 2026-06-08 | Backfill past-dated Shift rows for one employee from a JSON spec                                                                                                                                                                                                                                                                                                                                                                                                                                                | Migration artifact (Phase 76.5)               |
| set-opening-balance.ts                         | 2026-06-08 | Set opening saldo carryOver on a pre-cutoff SaldoSnapshot                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Migration artifact (Phase 76.5)               |
| cleanup-tz-duplicate-snapshots.ts              | 2026-06-08 | Soft-supersede TZ-duplicate SaldoSnapshot rows; AuditLog trail + idempotent re-run                                                                                                                                                                                                                                                                                                                                                                                                                              | Migration artifact (Phase 76.6)               |
| set-time-tracking-exempt.ts                    | 2026-06-08 | Toggle Employee.isTimeTrackingExempt + AuditLog (§ 18 ArbZG)                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Migration artifact (Phase 76.7)               |
| recalculate-snapshots-after-shift-netto-fix.ts | 2026-06-11 | Recompute SHIFT_BASED SaldoSnapshots after v1.8.9 brutto→netto fix; locked-month-safe; idempotent                                                                                                                                                                                                                                                                                                                                                                                                               | Migration artifact (quick-260611-gap)         |
| anonymize-dump.ts                              | 2026-04    | Batch DSGVO anonymization across all employees in a connected DB (CronJob entry)                                                                                                                                                                                                                                                                                                                                                                                                                                | Operator tool                                 |
| validate-anonymization.ts                      | 2026-04    | Companion verifier for anonymize-dump.ts — asserts the post-condition holds                                                                                                                                                                                                                                                                                                                                                                                                                                     | Operator tool                                 |
| audit-workdays-vs-day-hours.ts                 | 2026-05    | Surface WorkSchedule rows whose workDays mismatches the per-day hours; one-directional by design, labels SHIFT_BASED hits EXPECTED (Phase 95b)                                                                                                                                                                                                                                                                                                                                                                  | Audit tool                                    |
| audit-workschedule-non-month1.ts               | 2026-05    | Surface WorkSchedule rows whose validFrom is not the 1st of a month (pre-Phase-60)                                                                                                                                                                                                                                                                                                                                                                                                                              | Audit tool                                    |
| backfill-auto-revalidate.ts                    | 2026-05    | Re-revalidate TimeEntries marked isInvalid after a leave cancellation                                                                                                                                                                                                                                                                                                                                                                                                                                           | Migration artifact (Phase 67.2)               |
| audit-saldo-chain-integrity.ts                 | 2026-08-17 | Walk every active MONTHLY SaldoSnapshot chain; report unexplained carry-over deltas (read-only, exits 2 on findings)                                                                                                                                                                                                                                                                                                                                                                                            | Audit tool                                    |
| migrate-opening-balances.ts                    | 2026-08-19 | Move documented opening balances out of SaldoSnapshot.carryOver onto the OpeningBalance model; dry-run default, per-employee zero-drift assertion, aborts writing nothing on any failure                                                                                                                                                                                                                                                                                                                        | Migration artifact (Phase 99)                 |
| ensure-test-database.ts                        | 2026-08-21 | Idempotent `CREATE DATABASE "clokr_test"` + `COMMENT ON DATABASE` marker stamp; refuses any non-test target (wrong name, `?schema=` param, or NODE_ENV=production) before opening a connection                                                                                                                                                                                                                                                                                                                  | Test infrastructure (Phase 101)               |
| reset-test-databases.ts                        | 2026-08-26 | Drops and re-clones the N per-worker test databases from the migrated `clokr_test` template; the ONLY `DROP-DATABASE` statement in this repo, gated on marker possession AND the anchored worker-name pattern; excluded from the runtime image (Phase 106 D-07/D-08)                                                                                                                                                                                                                                            | Test infrastructure (Phase 106)               |
| check-worker-database-usage.ts                 | 2026-08-26 | Run-level R2 proof: reads `pg_stat_database.tup_inserted` for every `clokr_test_<n>` after a full run and exits non-zero if any worker database is missing or received no writes                                                                                                                                                                                                                                                                                                                                | Test infrastructure (Phase 106)               |
| check-test-completeness.mjs                    | 2026-08-26 | D-09 hard floor over the vitest JSON reporter output (`apps/api/vitest-report.json`); exits non-zero if collected files/tests fall below `MIN_FILES`/`MIN_TESTS`, or if the report is missing/unparseable — protects R6 against parallelisation silently collecting fewer files                                                                                                                                                                                                                                 | Test infrastructure (Phase 106)               |
| backfill-leave-type-code.ts                    | 2026-09-14 | Gives every pre-Phase-97 `LeaveType` row its stable `code`, including legacy-alias names (`Jahresurlaub` → `VACATION`); no catch-all code, unmappable names are reported under `unmapped`; dry-run default, `--apply` opt-in, `--tenant-id`/`--all-tenants` required; doubles as the repeatable post-rollout sweep for the rolling-deploy window (its selection is `code IS NULL`, so re-running after a full rollout is safe) — see `docs/migrations.md` § "Phase 97 — LeaveType.code (Rollout-Reihenfolge)"   | Migration artifact (Phase 97) + Operator tool |
| lint-tenant-scoping.ts                         | 2026-09-16 | CI/local gate: fails on a NEW route or service handler that reads a client-supplied identifier into a tenant-scoped Prisma model without a tenant constraint (see § Lint gates below). Composed of five sibling modules — `lint-tenant-scoping-types.ts`, `-model-graph.ts`, `-request-bindings.ts`, `-candidates.ts`, `-verdict.ts` (analysis) plus `-exceptions.ts` (the named-exception mechanism) — grouped as one row because they have no independent invocation; see each file's own header for its part | Lint gate (Phase 204)                         |

## Migration artifacts

Phase-tagged scripts (e.g. Phase 76.5 entries above) are committed as an
audit-trail-of-record for one-off prod data migrations. They are NOT part of
the production code path and require explicit `--employee-id <uuid>` (and other
contextual) argv to run. Do not extend or re-purpose them — write a new script
if you need similar behavior.

All migration artifacts:

- carry a header comment block starting with
  `Migration artifact — committed YYYY-MM-DD for audit trail.`
- accept their inputs via `node:util` `parseArgs`, never via hardcoded UUIDs
  or names.
- include `--apply` as an opt-in flag — running without it is a dry-run that
  prints the proposed changes.
- write AuditLog rows (via `--actor-id <uuid>`) for every mutation so the
  migration step is reconstructible by retention auditors.

`migrate-opening-balances.ts` (Phase 99) follows this convention like every other migration
artifact — `--apply` is opt-in, dry-run is the default — but adds one extra guarantee on top:
it never mutates `SaldoSnapshot` at all, only `OpeningBalance` and `AuditLog`. See
`docs/runbooks/opening-balance-migration.md` for the full operator procedure.

## Operator tools

Operator tools are intended to be re-run as needed. They should be safe to
invoke against any environment with the appropriate DATABASE_URL.

## Audit tools

Audit tools are read-only and intended to surface data-integrity concerns
that the schema cannot enforce retroactively. Re-run as part of release-prep
or incident response.

`audit-saldo-chain-integrity.ts` (Phase 98) is the one audit tool that returns a non-zero exit
code on findings — `0` chain intact, `1` DATABASE_URL missing or DB failure, `2` unexplained
carry-over delta(s) and/or duplicate-month link(s) — so it can be used from CI or cron
unchanged. It performs ZERO writes and deliberately prints truncated employee ids only, with
no names and no employee numbers (DSGVO), unlike `audit-workdays-vs-day-hours.ts` and
`audit-workschedule-non-month1.ts`. Operator runbook: `docs/runbooks/saldo-chain-integrity.md`.

`audit-workdays-vs-day-hours.ts` (Phase 95b) is one-directional by design: it reports a day
whose `{day}Hours` is > 0 but missing from `workDays`, never the reverse, and labels every
`SHIFT_BASED` hit `[EXPECTED]` in its output rather than a review item. Its findings are for
review only — Phase 95b established that "correcting" them would be wrong, not merely
audit-unsafe, because `{day}Hours` is a legacy placeholder for every type except
`FIXED_SCHEDULE`. See CLAUDE.md "Schedule Types".

## Test infrastructure

Scripts that provision or guard the isolated integration-test database (`clokr_test`, Phase 101,
D-01). Unlike migration artifacts they are re-run on EVERY test invocation (via `pretest` /
`pretest:coverage` / `pretest:watch`), not once against prod. Unlike operator tools they refuse to
run against anything other than the dedicated test target — including the runtime image, which
does contain them (`apps/api/Dockerfile` copies the whole `apps/api/` directory).

`ensure-test-database.ts` is idempotent: it creates `clokr_test` only if `pg_database` doesn't
already list it, and unconditionally re-stamps the `COMMENT ON DATABASE` marker
(`apps/api/src/utils/test-database.ts`'s `TEST_DATABASE_MARKER`) so a re-run repairs a missing
comment. It never issues DROP / TRUNCATE / DELETE.

`reset-test-databases.ts` (Phase 106) is the ONE script in this repo that issues a `DROP-DATABASE` statement.
It runs after `ensure-test-database.ts` and `prisma migrate deploy` in the `test:setup` chain,
dropping and re-cloning each of the `TEST_DATABASE_WORKER_COUNT` per-worker databases
(`clokr_test_1` … `clokr_test_N`) from the now-migrated `clokr_test` template via
`CREATE DATABASE ... TEMPLATE`, then stamping each clone individually (`COMMENT ON DATABASE` is
keyed to the database OID and is NOT inherited from the template). A drop is permitted only when
the target carries `TEST_DATABASE_MARKER` AND its name is a worker database in the anchored
namespace (`mayDropDatabase`, unit-tested in `scripts/__tests__/reset-test-databases.test.ts`).
It is deliberately excluded from the production runtime image (`apps/api/Dockerfile` D-08 gate).

The shared constants + credential-safe target description module (`TEST_DATABASE_NAME`,
`TEST_DATABASE_MARKER`, `parseDatabaseUrl`, `databaseNameOf`, `describeTarget`,
`redactDatabaseUrl`) lives at `apps/api/src/utils/test-database.ts` — under `src/`, not here —
because `apps/api/tsconfig.json` pins `rootDir` to `./src`, so a `src/**` test file cannot import a
`scripts/**` sibling (TS6059) while a `scripts/**` file can freely import inward (it is outside the
tsc-compiled program; see `include: ["src/**/*"]`). It is a plain, side-effect-free module — not
independently invoked and has no CLI behaviour.

## Lint gates

Static-analysis checks that fail the build rather than fixing anything, run on every local `pnpm`
invocation and every CI run — unlike audit tools (read-only, run on demand) or migration
artifacts (one-off, require explicit input).

### `lint-tenant-scoping.ts` (Issue #204)

Enforces CLAUDE.md § Multi-Tenancy Convention mechanically: a route or service handler under
`apps/api/src/routes/` or `apps/api/src/services/` must not read a client-supplied identifier into
a tenant-scoped Prisma model without constraining the result to `req.user.tenantId`. That is the
whole rule — its exact scope, the model classification, and the three ways a call counts as
scoped are stated once in `lint-tenant-scoping.ts`'s own header and in
`lint-tenant-scoping-types.ts`; this section does not restate them.

- **Run locally:** `pnpm --filter @clokr/api run lint:tenant-scoping`
- **Runs in CI as:** the `Lint tenant scoping` step in `.github/workflows/ci.yml`, immediately
  after `Lint API`

**A hit on a clean tree is a FINDING, not an exception candidate.** Per Issue #204 (D-08): file a
GitHub issue and leave the handler alone. Only add an exception entry once you have actually
understood WHY the site is safe and can write that reason down — adding an entry to make the run
green without that is how the gate is turned into decoration.

**How to add a justified exception.** Exceptions live in
`apps/api/scripts/lint-tenant-scoping-exceptions.json`, one entry per HANDLER (not per call site):
every call the entry covers must be named individually in `calls[]` — a new, unlisted call added
later to an already-covered handler is still reported as a new finding. `reason` is mandatory and
mechanically validated by the script (`lint-tenant-scoping-exceptions.ts`); an entry without one,
or a finding whose call is not named in any entry's `calls[]`, fails the run. A real, currently
seeded entry:

```json
{
  "file": "apps/api/src/routes/company-shutdowns.ts",
  "handler": "DELETE /api/v1/company-shutdowns/:id/exceptions/:employeeId",
  "validatedAt": 190,
  "calls": [
    { "call": "companyShutdownException.findUnique", "line": 194 },
    { "call": "companyShutdownException.deleteMany", "line": 198 }
  ],
  "reason": "shutdownId (the client-supplied :id) is tenant-validated at line 190 (companyShutdown.findFirst({ id, tenantId })). CompanyShutdownException rows only ever exist for a (shutdownId, employeeId) pair created together by the tenant-validated POST /:id/exceptions handler above (compound unique key shutdownId_employeeId, enforced at create time), so an employeeId from a different tenant can never match an existing row for this already-tenant-scoped shutdownId."
}
```

`file` names the handler's file, `handler` its route, `validatedAt` the line number of the
validating check that makes the rest of the handler safe (`null` only for the pre-authentication
category, where no tenant context exists yet at all), `calls[]` every covered call, `reason` why.

**The facade rule (Phase 100b, GitHub #100, D-10).** Phase 100b puts a facade layer between a
route and Prisma: `apps/api/src/contexts/<x>/facade/*.ts`. Adding those directories to
`SCOPED_DIRS` alone would be decoration — a facade function has no `req`, so without G2/G3 below
every facade call would sit "in scope but never a candidate" (counted, never judged), which is
worse than a missing `SCOPED_DIRS` entry (that at least throws `MissingScopedDirError`, #229).
Three additive rules make a facade module mean something to this gate:

- **G1 — placement.** A facade module's Prisma calls are only ever seen at all once its context's
  `contexts/<x>/facade` directory is added to `SCOPED_DIRS` (`lint-tenant-scoping-types.ts`). Each
  conversion plan adds its own entry IN THE SAME COMMIT that creates the directory — `SCOPED_DIRS`
  pointing at a directory that does not exist yet is exactly the #229 failure mode
  (`MissingScopedDirError`), not "not yet in scope".
- **G2 — a facade function's own parameters are client-supplied.** Inside a file matching
  `isFacadeModulePath` (`lint-tenant-scoping-types.ts`), the enclosing EXPORTED function
  declaration's own parameter names seed `clientSupplied` in
  `lint-tenant-scoping-request-bindings.ts`'s `collectRequestBindings` — the same way a route
  handler's `req.params`/`req.body` destructure would. This is not a guess: a facade exists
  _because_ a route handed it a value that came from `req`.
- **G3 — a `tenantId`/`employeeId`/`sub` PARAMETER is a principal field**, mapped to itself in
  `principalFields` (the same map a route's `const tenantId = req.user.tenantId` populates) — so a
  correctly-scoped facade function needs no exception at all, and D-13's existing "inline scoping"
  / "inline relation filter" recognition applies to it unchanged.

**How to add a justified exception for a facade function.** Same mechanism as above, one entry per
exported facade FUNCTION rather than per route: `handler` names the function (e.g.
`"scheduling/facade/shifts.ts:getShiftById"`), `calls[]` the covered call(s), `reason` mandatory.
A hit on a facade function is exactly as much a finding as a hit on a route handler — see the
D-08 guardrail above, unchanged for this new scope.

### `lint-facade-signatures.ts` (Issue #100, D-07/G4)

Enforces the shape every `contexts/<x>/facade/*.ts` function must have, mechanically. The
mechanism it protects against (R1, the sharpest risk of the whole facade phase): a facade function
that takes `app: FastifyInstance` and reads `app.prisma` internally silently leaves the CALLER's
`$transaction` — a write inside it survives a rollback, with no error anywhere. Proven once, not
just asserted: plan 06's rollback test, run against a deliberately `app`-typed version of
`bookOvertimeCompensation`, produced `expected -5 to be +0` — a write that should have rolled back
did not.

Three checks, run against every EXPORTED function declaration under `contexts/*/facade/` (AST-based,
TypeScript compiler API — not a source regex):

- **F1** — the first parameter must be literally `db: Prisma.TransactionClient` (name AND type).
- **F2** — no parameter anywhere in the signature may be `FastifyInstance`/`FastifyRequest`/
  `FastifyReply` — the mechanism named above.
- **F3** — a `*Id`/`*Ids`-shaped parameter (excluding the literal `tenantId`/`id`) requires a
  sibling `tenantId` parameter (G4) — without it, the tenant-scoping gate above cannot judge the
  call once it moves behind a facade (#229's failure mode arriving by a different road).

- **Run locally:** `pnpm --filter @clokr/api run lint:facade-signatures`
- **Runs in CI as:** the `Lint facade signatures` step in `.github/workflows/ci.yml`, immediately
  after `Lint import targets`

**How to add a justified exception.** Exceptions live in
`apps/api/scripts/lint-facade-signatures-exceptions.json`, one entry per FUNCTION:
`{ file, function, rules: ["F1"|"F2"|"F3", ...], reason }` — `rules` is an array because a single
grandfathered function commonly violates more than one rule at once (one reasoned sentence covers
the whole shape). Every seeded entry today is one of two shapes: a function that predates this
convention by two milestones (`hasApprovedLeaveOnDate`, Phase 76.2) or a DSGVO/hard-delete
compliance function whose sole identifier IS the tenant boundary already (F3 only — see the D-08
compliance functions across plans 06/08/10/11/12/13 for the pattern). **When NOT to add one:** a
facade function that genuinely CAN take `db: Prisma.TransactionClient` and genuinely CAN thread a
`tenantId` — the exception exists for a documented, load-bearing reason a reader can check, not for
convenience.

### `measure-foreign-context-access.ts` (Issue #100, AC-3 — the boundary-completeness counter)

Walks `contexts/`, `composition/` and `services/` under `apps/api/src`, matches ANY
`<dotted-receiver>.<model>.<op>(` (receiver-agnostic — `app.prisma`, `tx`, `prisma`, anything
alike, never pinned to a literal string) against the schema's `MODEL_OWNER` table, computes AREA
per ADR 0001 entry F (`services/clock` → Zeiterfassung, `services/phorest` → Schichtplanung — a
context's OWN model is never a foreign access, even from its second physical tree), and reports
WORKLOAD = a foreign access to a model owned by a DIFFERENT context, minus named exceptions.

Phase 100b's own claim, made checkable rather than merely stated: the workload was 169 at Plan 01
and is 0 as of Plan 13 — `--check 0` is the standing CI gate from Plan 14 onward.

- **Run locally:** `pnpm --filter @clokr/api exec tsx scripts/measure-foreign-context-access.ts
[--check <n>] [--rows] [--by-model]`
- **Runs in CI as:** the `Measure cross-context Prisma access` step in `.github/workflows/ci.yml`,
  immediately after `Lint facade signatures`, asserting `--check 0`

**How to add a justified exception.** Exceptions live in
`apps/api/scripts/foreign-context-access-exceptions.json` — an OBJECT, not a bare array
(`{ convertedModels: string[], exceptions: [...] }`), because this gate carries a second concept
sibling gates do not: `convertedModels` names every model that has ALREADY been converted whole —
once a model is listed there, ANY future direct access to it (even one this script's own
`MODEL_OWNER` table would otherwise judge foreign) is a hard error, not a candidate for a new
exception entry. **When NOT to add an exception:** almost never, now that the count is 0 — a new
foreign access on a converted model means the conversion was bypassed, not that a new grandfather
case was found. The one standing exception (`apps/api/src/contexts/platform/api/test-bootstrap.ts`,
21 calls, D-03) is test-only infrastructure gated off int/prod, not a production code path.

### `measure-context-boundary-imports.ts` (Issue #101 — AC-1/AC-2/AC-5, the import-specifier sibling of the gate above)

Walks `apps/api/src` production code (never `__tests__/` or `*.test.ts` — Owner decision #246) and
finds every relative import specifier that reaches into a FOREIGN context's internals — a
specifier matching `**/<context>/**` but not `**/<context>/index` — for each of the five ADR 0001
contexts (`platform`, `time-tracking`, `absence`, `scheduling`, `working-time-account`). Where
`measure-foreign-context-access.ts` counts a foreign Prisma CALL, this script counts a foreign
IMPORT SPECIFIER — the two are siblings, not duplicates: a context can import a foreign helper
function without ever touching Prisma directly, and this gate is the one that catches that shape.
The same tool also builds the production import graph (`--cycles`) and can PROJECT what that graph
would look like under a not-yet-built extraction (`--project`/`--extract-sim`/`--paths` — used
during this phase's planning, not part of the standing CI gate).

Seven flags, one script:

- `--check <n>` — equality gate on the current WORKLOAD (excepted imports subtracted). Standing
  value: **0**.
- `--rows` — every workload row, one per `file:line | form | fromArea | targetModule | {symbols}`.
- `--by-target` — workload grouped by target context, with file counts.
- `--forms` — the `from`/`dynamic-import` split (the identity `workload == from + dynamic-import`
  is this tool's own internal cross-check).
- `--predict <context>` — before converting a context, shows what its own `index.ts` would need to
  re-export and the resulting `lint:import-targets` delta.
- `--cycles [--check <n>]` — counts modules/components in an import CYCLE in the REAL graph
  (`--paths` additionally prints one witness path per still-reachable ordered pair). Standing
  value: **22** (see the next paragraph).
- `--project <contexts>|all [--extract-sim <scenario>]` — projects the graph as if the named
  contexts were already fully converted, optionally simulating a not-yet-real extraction shape.
  Planning-only; the standing CI gate never passes `--project`.

**The cycle count is measured, not assumed, and it stayed one module above every projection that
predicted it.** Before this phase the production import graph was acyclic. Routing every
cross-context import through five `index.ts` files creates a real cycle — ADR 0001 Eintrag H's
Phase 101B Nachtrag has the full account, including why the owner-accepted projection (21) and the
real, measured end state (22) differ by one, and why that is a recorded finding rather than a
number to silently adopt or silently ignore. The CI gate asserts the REAL number
(`--cycles --check 22`), never a projection.

- **Run locally:** `pnpm --filter @clokr/api exec tsx scripts/measure-context-boundary-imports.ts
[--check <n>] [--rows] [--by-target] [--forms] [--predict <context>] [--cycles [--check <n>]
[--paths]] [--project <contexts> [--extract-sim <scenario>]]`
- **Runs in CI as:** two steps, `Measure context-boundary imports` (`--check 0`) and
  `Check context import cycles` (`--cycles --check 22`), both in `.github/workflows/ci.yml`,
  immediately after `Measure cross-context Prisma access`

**How to add a justified exception.** Exceptions live in
`apps/api/scripts/context-boundary-import-exceptions.json` — one object per exception, each
carrying `id`, `file`, `specifier`, `reason` (mechanically required to be >= 30 characters —
long enough to say more than "needed it"), `disappearsIn` (a concrete disappearance point, never
"someday"), and `register` (which ADR entry owns the reasoning). The one `wholeFile: true` entry
(`app.ts`, the composition root) instead carries `expectedCount`, checked by equality — a 46th deep
import from `app.ts` is a finding, not an automatic pass. The script validates parity in BOTH
directions between this file and the inline `eslint-disable-next-line no-restricted-imports`
comments in the source: a comment with no matching entry, or an entry with no matching comment,
both fail the run. **When NOT to add one:** a hit on a clean tree (workload 0) is a finding to
report on Issue #101's Block-2 follow-ups (#102-#104), not an exception to add — the six entries
that exist today are exactly the ones ADR 0001 Eintrag H names, no more.

### `lint-saldo-lock-derivation.ts` (Issue #241/#242)

A static AST interpreter that walks every `SaldoSnapshot.periodStart` comparison carrying a sibling
`periodType: "MONTHLY"` and asks whether the compared value traces back — through local variable
bindings, `.start`/`.end` property access, `.map()`, `new Set(...)`, and same-file helper function
bodies, including one bounded cross-file hop into a `contexts/*/facade/*.ts` function's own
parameter (added by Phase 100b Plan 07, so a refactor that moves a `periodStart` comparison behind
a facade cannot silently downgrade the gate's own verdict on it) — to an actual call to
`monthRangeUtc()`. Three-way verdict: `"safe"` / `"unsafe"` (a finding) / `"unknown"` (the trace
crosses a boundary this single-file gate genuinely cannot resolve — reported explicitly, never
silently counted as a pass). `YEARLY` comparisons are out of scope on purpose (a different,
self-consistent naive-UTC convention `auto-close-month.ts` uses deliberately).

- **Run locally:** `pnpm --filter @clokr/api run lint:saldo-lock-derivation`
- **Runs in CI as:** the `Lint saldo-lock periodStart derivation` step in
  `.github/workflows/ci.yml`, after `Measure cross-context Prisma access`

**How to add a justified exception.** Exceptions live in
`apps/api/scripts/lint-saldo-lock-derivation-exceptions.json`, each carrying a `disposition` field
this gate's schema adds beyond the sibling gates' shape: `"safe"` (genuinely reviewed and correct —
e.g. `dashboard.ts`'s rolling 6-month trend chart, where a TZ-boundary miss shifts a display window
by at most one month with zero Revisionssicherheit consequence) or `"deferred"` (a CONFIRMED,
real bug — Issue #242's naive UTC year boundary — deliberately NOT fixed by the commit that
introduces or extends this gate, tracked by a `trackedIssue`, printed in its own section on every
run so a clean gate can never be misread as "0 known bugs"). **When NOT to add a `"safe"`
exception:** if you have not actually traced the value to `monthRangeUtc()` by hand — a `"safe"`
entry is a claim the script itself no longer checks for you.

## Invocation

All scripts run via `tsx` with the `apps/api` workspace:

```bash
DATABASE_URL=... pnpm --filter @clokr/api exec tsx scripts/<script>.ts \
  --employee-id <uuid> \
  [--actor-id <uuid>] \
  [other-script-specific-flags]
```

See each script's header comment for its exact argv contract.

## Removed scripts

| Script                                  | Status                     | Why                                                                                                                                                                                                      |
| --------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| recalculate-snapshots-after-soll-fix.ts | Removed 2026-08 (Phase 99) | One-time v1.8.4 Ø-Methode migration, applied to prod 2026-06-09/10 and never to be re-run. Also the code path that wiped a documented opening balance (`AuditLog` action `SALDO_RECALC_AFTER_SOLL_FIX`). |
| src/utils/recompute-snapshot.ts         | Removed 2026-08 (Phase 99) | Documented STALE MIRROR of the saldo math and the only importer of the above; a fifth carry-over seeding site.                                                                                           |

The audit-trail-of-record for what these scripts did is the `AuditLog` table (reason strings are
on the Phase 98 deliberate-reason allowlist, `src/utils/saldo-chain-classification.ts`) plus git
history — not the script files. `isSnapshotLocked()` was rescued into
`src/utils/snapshot-lock.ts` before the removal.
