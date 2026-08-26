# API integration test database

The `apps/api` integration suite (`pnpm --filter @clokr/api test`) connects to its own,
genuinely separate PostgreSQL databases — never the local dev database `clokr`. As of
Phase 106 the suite runs its test files in parallel, and each Vitest worker connects to its
own database (`clokr_test_1` … `clokr_test_<n>`), cloned from a migrated template
(`clokr_test`) — see "Worker databases" below. This document explains the arrangement, how
to run the suite, how the databases are provisioned, how to reset them, what the startup
guard's abort means, and what flakiness is (and isn't) fixed by any of this. See
`.planning/phases/101-testisolation-integrationstests-schreiben-in-die-dev-datenbank/`
for the full history (Phase 101, D-01/D-02).

**Before 2026-08-21 this separation did not actually exist, silently.**
`apps/api/.env.test` pointed `TEST_DATABASE_URL` at `.../clokr?schema=test` — the SAME
database as dev, distinguished only by a `?schema=` query parameter. That parameter is a
Prisma-only connection-string convention; `pg.Pool` (the driver `apps/api/src/plugins/
prisma.ts` actually builds a connection with) does not interpret it and silently ignores
it, so `PrismaPg` fell back to the `public` schema regardless — the same schema local dev
uses. Every integration test run was reading and writing the dev database while `pretest`
dutifully maintained an unrelated `test` schema that nothing ever connected to. Phase 101
(D-01) fixed this with a genuinely separate DATABASE rather than a schema parameter, so
there is no `search_path`/`?schema=` special case left for any future connection path to
forget.

## Running the tests

Full suite: `pnpm --filter @clokr/api test`. This runs the `pretest` hook (provisioning —
see below) and then `vitest run`.

A single file or subset: provision explicitly first, then invoke vitest directly —

```bash
pnpm --filter @clokr/api run test:setup
pnpm --filter @clokr/api exec vitest run <path>
```

`exec vitest run` bypasses pnpm's script lifecycle entirely, so it **skips `pretest`** —
that's why `test:setup` has to be run first, by hand, for a targeted subset.

The suite now runs `TEST_DATABASE_WORKER_COUNT` (`apps/api/src/utils/test-database.ts`, pinned
at 4) test files in parallel — `apps/api/vitest.config.ts` sets `fileParallelism: true` and
`maxWorkers: TEST_DATABASE_WORKER_COUNT` — with each worker connected to its own database
(`clokr_test_1` … `clokr_test_<n>`). The commands above are unchanged; that is deliberate (see
"Worker databases" below).

**`pnpm --filter @clokr/api test -- <path>` does not work as a single-file filter.**
Confirmed empirically, not assumed: the `--` is forwarded literally into vitest's own
argument list (`vitest run -- <path>`, not `vitest run <path>`), and vitest does not treat
that as a path filter — it runs the entire suite instead, spinning up a fresh app instance
per file exactly like a full run. Use the two-step form above.

## Object storage (MinIO) — required by `section9-upload.test.ts`

One suite, `apps/api/src/__tests__/section9-upload.test.ts` (12 tests, Phase 104), performs a
**real** object-storage round-trip: it uploads a paper AU document, reads the bytes back verbatim,
and proves the object is genuinely gone again after a DSGVO Art. 17 deletion. It is the only test
in the repo that talks to MinIO for real — every other storage call in the suite is spied on
(`anonymize-helper.test.ts`) or wrapped in a non-fatal `.catch()`.

There is deliberately **no skip guard**. If the object store is unreachable these 12 tests fail
with `ECONNREFUSED`. That is the intended behaviour: the § 9 AU document is an Art. 9 DSGVO health
datum, and "it can be erased again" is a claim that has to be re-proven on every run, not silently
skipped.

**Locally:** `docker compose up -d minio` (see `docker-compose.yml`) publishes MinIO on
`localhost:9000` with `minioadmin` / `minioadmin`. `apps/api/vitest.setup.ts` defaults
`MINIO_ENDPOINT` to `localhost` (a `??=` default, so a shell value or `.env.test` still wins), so
no further configuration is needed — the API container's own default of `minio` is a hostname that
only resolves inside the compose network. The `clokr` bucket is created automatically on boot by
`apps/api/src/plugins/storage.ts`; you do not need to create it.

**In CI:** `.github/workflows/ci.yml`'s `test` job starts the same MinIO image with an explicit
`docker run … server /data` step and waits for `GET /minio/health/live` before any test runs, then
exports `MINIO_ENDPOINT` / `MINIO_PORT` / `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` / `MINIO_BUCKET`.

It is **not** a `services:` container, and that is not an oversight: GitHub Actions service
containers cannot override a container's command, and `minio/minio`'s default `CMD` is bare
`minio` with no `server /data` subcommand — verified with
`docker inspect --format '{{json .Config.Cmd}}' minio/minio:latest` — so such a container exits
immediately after printing usage. `docker-compose.yml` can use a service definition only because
compose supports `command:`.

## Why a `pretest` script, not a `docker-entrypoint-initdb.d` mount

Postgres's own convention for first-boot provisioning — dropping `.sql`/`.sh` files into
`docker-entrypoint-initdb.d/` — only runs when the container starts against a **completely
empty** data directory. `docker-compose.yml`'s `postgres` service persists its data in the
named volume `postgres_data`; on any machine where that volume already exists (which is
the common case — the first `docker compose up` created it, and it survives every
subsequent `docker compose down`/`up` cycle), an init script dropped into that directory
would **never run again**. It would work once, on a brand-new machine, and then silently
do nothing for every developer who already has the stack running — exactly the kind of
silent, easy-to-miss gap Phase 101 exists to eliminate.

A `pretest`/`test:setup` script (`apps/api/scripts/ensure-test-database.ts`, wired via
`apps/api/package.json`'s `pretest` / `pretest:coverage` / `pretest:watch` / `test:setup`
scripts) runs on **every** test invocation, locally and in CI, regardless of the Postgres
volume's history. It is idempotent — safe to re-run — and it independently refuses (before
opening any connection) to run against anything other than the dedicated test target. That
property is what makes it a better fit here than an init-time-only mount.

## How provisioning works (D-02: `migrate deploy`, not `db push`)

`test:setup` does three things now, chained with `&&` (never `;` — an unset/empty
`TEST_DATABASE_URL` must abort before the next command can fall through to any default). The
order is not negotiable — each step depends on the previous one having actually committed:

1. `apps/api/scripts/ensure-test-database.ts` — creates the `clokr_test` TEMPLATE database if
   it doesn't already exist, and stamps a `COMMENT ON DATABASE` marker
   (`apps/api/src/utils/test-database.ts`'s `TEST_DATABASE_MARKER`) that the TI-03 startup
   guard later checks for. Refuses (non-zero exit, before any connection) on a database name
   outside the test namespace, a `?schema=` parameter, or `NODE_ENV=production`. Never issues
   `DROP`/`TRUNCATE`/`DELETE`.
2. `prisma migrate deploy` against the TEMPLATE `clokr_test` — replays the committed
   migration history (`packages/db/prisma/migrations/`), the same command
   `apps/api/docker-entrypoint.sh` uses for every real environment. This **replaced**
   `prisma db push --accept-data-loss` in Phase 101 plan 02 (D-02), because `db push`
   generates its schema from `schema.prisma` alone and cannot express the project's
   hand-authored **partial** unique indexes (`WHERE`-filtered — Prisma's schema DSL has no
   `WHERE` syntax). Those indexes exist only as raw SQL inside specific migrations;
   `clokr_test` was silently missing all three of them under `db push`, which masked real
   constraint-violation bugs behind false-negative test passes. `migrate deploy` produces a
   byte-for-byte-correct replica of what every other environment actually runs. See
   `docs/migrations.md` for the general `migrate deploy` mechanics (P3005, the
   fresh-vs-baselined distinction) — the same rules apply here. This step MUST run against the
   template, not a worker database — see "Worker databases" below for why.
3. `apps/api/scripts/reset-test-databases.ts` — drops and re-clones the N per-worker
   databases (`clokr_test_1` … `clokr_test_<n>`) from the now-migrated template via
   `CREATE DATABASE ... TEMPLATE`, and stamps each clone with the marker individually (Phase
   106, D-04/D-05). This is the step that makes D-04 safe and cheap: because a `TEMPLATE` copy
   is byte-for-byte, every worker database carries those three hand-authored partial indexes
   too, and the "migrations replay cleanly from zero" property from step 2 is paid **once**
   per `test:setup`, not once per worker.

## Worker databases

- The TEMPLATE is `clokr_test` — migrated once per `test:setup`, never directly connected to
  by a running test.
- The workers are `clokr_test_1` … `clokr_test_<N>` (N = `TEST_DATABASE_WORKER_COUNT`,
  currently 4), each a `CREATE DATABASE ... TEMPLATE` clone of the template.
- The anchored namespace pattern is `^clokr_test(_\d+)?$` (Phase 106, D-06), and it lives in
  exactly one place: `apps/api/src/utils/test-database.ts`'s `TEST_DATABASE_NAME_PATTERN`.
  Nothing else in the repository restates it.
- The name is convenience; the marker is still the actual authorization mechanism, exactly as
  in Phase 101. A `TEMPLATE` copy does **not** inherit `COMMENT ON DATABASE` — it lives in
  `pg_shdescription`, keyed to the database OID, not to anything schema- or data-level — which
  is why `reset-test-databases.ts` stamps every worker database individually, immediately
  after its own `CREATE DATABASE ... TEMPLATE`.
- `apps/api/scripts/reset-test-databases.ts` is the only script in this repository that may
  issue `DROP DATABASE`, and it is excluded from the production runtime image by an
  `apps/api/Dockerfile` build gate (named-file removal plus a behavioural absence check).

## Clean slate — resetting the test databases

Neither `db push` nor `migrate deploy` truncates data — they only sync schema. But as of Phase
106, `reset-test-databases.ts` runs as the third link of every `test:setup` invocation and
unconditionally drops and re-clones all N worker databases from the template — so residue in a
worker database cannot survive a run (D-05). **Running `pnpm --filter @clokr/api run
test:setup` is the routine remedy now**; the hand-rolled `DROP DATABASE` recipe below is no
longer the everyday tool. It is still needed for two narrower cases:

**(a) The TEMPLATE itself needs recreating** — e.g. a pre-Phase-101 `clokr_test` with no
`_prisma_migrations` bookkeeping table (see the P3005 paragraph below):

```bash
docker exec clokr-postgres-1 psql -U clokr -d postgres -c 'DROP DATABASE IF EXISTS clokr_test WITH (FORCE)'
pnpm --filter @clokr/api run test:setup
```

**(b) An unmarked worker database was left behind by a crashed run** — `reset-test-databases.ts`
refuses to drop a database that is in the worker namespace but does not carry the marker (it
cannot prove its own tooling created it), and prints the exact remedy, naming the database:

```
reset-test-databases: REFUSED to drop "clokr_test_1" — it is in the test namespace but does not
  carry the "clokr-test-database:v1" marker, so this tooling cannot prove it created it.
  ...
  Remedy (destructive, do it deliberately):
    docker exec clokr-postgres-1 psql -U clokr -d postgres -c 'DROP DATABASE "clokr_test_1" WITH (FORCE)'
  then re-run: pnpm --filter @clokr/api run test:setup
```

This usually means a previous run died between `CREATE DATABASE` and the marker stamp — see
`apps/api/scripts/reset-test-databases.ts`'s own header comment for the full rationale.

The Prisma-native alternative for case (a) is `prisma db push --force-reset`, which Prisma
itself gates behind the `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION` environment variable (it
refuses to run without it) — safe here since the template's contents are explicitly disposable
(see its own marker comment). The `DROP DATABASE` form above is still preferred, because it
also clears out any leftover `_prisma_migrations` history inconsistency, not just the app
tables.

**Before Phase 101, this force-reset advice was pointed at the wrong target and could not
have worked.** The previously-documented remedy was `db push --force-reset` against
`TEST_DATABASE_URL`'s `?schema=test` — but the `pg` driver this app connects with never
applied that `?schema=` parameter (D-01's root cause), so both the suite itself and any
"reset" of it were operating on the `test` schema, a schema nothing ever actually
connected to. Resetting `test` therefore never cleared the residue anyone was hitting,
because the residue was **dev data sitting in `public`**, completely unaffected by a reset
scoped to `test`. This is the single most useful correction in this document: if you recall
a `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION` force-reset "fixing" a flaky run before
2026-08-21, it didn't — the flake either resolved on its own (CI always starts from a fresh
Postgres service container and never saw this class of residue) or had a different,
unrelated cause (see "Known remaining flakiness" below).

**One case you'll hit exactly once per developer machine:** if your local `clokr_test`
predates Phase 101 plan 02 (i.e. it was provisioned by the old `db push`-based
`test:setup`), it has the app's tables but no `_prisma_migrations` bookkeeping table —
`migrate deploy` will refuse to run against it (`P3005: the database schema is not
empty`), the same failure mode `docs/migrations.md` describes for int/prod's one-time
baseline. The fix is the same drop-and-recreate above (case (a)). This is never needed in CI,
which always starts from a fresh Postgres service container, so it exercises the "migrations
apply cleanly from zero" property on every run already.

## The startup guard (TI-03)

Before any test file executes, `apps/api/vitest.setup.ts`'s `globalSetup` requires possession
of the marker `ensure-test-database.ts`/`reset-test-databases.ts` stamp
(`apps/api/scripts/test-database-guard.ts`'s `assertTestDatabaseMarker`) — not merely a
matching database name — and, as of Phase 106, does so for the TEMPLATE **and every one of
the N per-worker databases** by exact name, all in the parent process before a single worker
is spawned. A wrong or missing target aborts the entire run with zero tests executed and a
message naming the actual host/port/database it found instead. `globalSetup` deliberately
assigns no `DATABASE_URL` itself.

A second, per-worker layer (`apps/api/vitest.worker-setup.ts`, a `setupFiles` entry, so it
runs once per test file inside every worker) now does two things: it re-checks that the
verified target actually propagated into this worker's `process.env`, and it MAPS
`VITEST_POOL_ID` to this worker's own database (`clokr_test_<n>`) — it is the single owner of
the `DATABASE_URL` assignment in the whole harness. An unset or out-of-range pool id is a hard
error, never a fallback to worker 1 or to the template. The reason this matters concretely: in
CI, the fallback value that a silent default would resolve to is the `test` job's own
`DATABASE_URL` — the dev-shaped reference database — so this layer is deliberately fail-closed
rather than fail-open. Neither layer can be bypassed by an environment variable or flag — see
each guard's own header comment for the full rationale.

## Known remaining flakiness

Removing dev-data contamination removes **one** source of cross-run interference — it does
not make the suite hermetic. Be honest about what is and isn't fixed:

- **Fixed by Phase 106: cross-suite interference across the whole run, and residue
  surviving between runs.** As of Phase 106, `apps/api/vitest.config.ts` sets
  `fileParallelism: true`; each of the N Vitest workers connects to its own database
  (`clokr_test_1` … `clokr_test_<n>`, see "Worker databases" above), and `test:setup`
  drops and re-clones every worker database from the migrated template on every
  invocation (D-05) — so a test run always starts from a clean database, and a file can no
  longer leak state into a file running in a _different_ worker. **Not fixed:** files that
  land in the _same_ worker (roughly `199 / N` of them) still share that one worker's
  database sequentially, with cleanup still per-suite (`afterAll`/`afterEach` in each
  file), not a transaction rollback or a fresh database per file — a test that leaks state
  can still affect a later test scheduled onto the same worker in the same run.
  Per-test-file database isolation remains deferred.
- **Hardcoded-date "time-bomb" tests.** Some fixtures use literal future dates that
  eventually become the past (e.g. a Phase-43 shift-override test hit this in 2026-08).
  Unrelated failure class, not touched by Phase 101.
- **A deterministic 00:00–02:00 local failure window (issue #34) — fixed for the 13
  suites that carried the bug.** Root cause: date helpers did LOCAL arithmetic
  (`d.setDate(d.getDate() - n)`) and then UTC formatting (`d.toISOString().split("T")[0]`),
  while the endpoints under test resolve "today" in the TENANT timezone
  (`todayInTz`/`dateStrInTz`, `apps/api/src/utils/timezone.ts`). In that window the UTC
  calendar day is still yesterday, so e.g. a 10-day retro-window helper silently computed
  an 11-day-old date and tripped `RETRO_WINDOW_EXCEEDED`. Fixed by routing every affected
  helper through `apps/api/src/__tests__/test-dates.ts` — the single, shared, tenant-TZ
  date helper for the whole suite; see "Reproducing tenant-timezone date bugs" below.
  `.planning/phases/98-*/deferred-items.md` (the original report) is superseded by this
  fix for the files it covers.
- **The object-storage suite needs a live MinIO.** `section9-upload.test.ts` fails with
  `ECONNREFUSED` when nothing is listening on `MINIO_ENDPOINT:MINIO_PORT` — by design, no skip
  guard (see the object-storage section above). If those tests are the only red ones, start MinIO
  before concluding anything about the code.

## Reproducing tenant-timezone date bugs (`CLOKR_TEST_FAKE_CLOCK`)

Issue #34's failure window (00:00–02:00 local, see above) only reproduces naturally between
midnight and roughly 2am — waiting for it is not a workable development loop. Reproduce it on
demand, at any hour, with one opt-in env var:

```bash
pnpm --filter @clokr/api run test:setup
CLOKR_TEST_FAKE_CLOCK=00:30 pnpm --filter @clokr/api exec vitest run src/__tests__/time-entries.test.ts
```

`CLOKR_TEST_FAKE_CLOCK="HH:MM"` shifts the process-level `Date` (via `apps/api/vitest.clock-setup.ts`,
the FIRST `vitest.config.ts` `setupFiles` entry) to today's date at that wall-clock time in
`CLOKR_TEST_FAKE_CLOCK_TZ` (default `Europe/Berlin`). Absent the env var, the file is a complete
no-op — zero effect on CI or a normal local run.

**`TZ=Europe/Berlin pnpm ... test` does NOT reproduce this bug.** `toISOString()` always formats in
UTC regardless of the process `TZ` — the divergence is between UTC-formatted output and
tenant-TZ-resolved endpoint logic, not between two different local formattings. Only shifting
`Date` itself (what this harness does) reproduces it.

**`apps/api/src/__tests__/test-dates.ts` is the ONLY place test date math may live.** Every helper
that derives a calendar day from "now" (`todayStr`, `pastDateStr`, `futureDateStr`,
`daysAgoStrInTz`, `nextWeekdayStr`, `mondayOfWeekStr`, `monthsAheadStr`) or reads a stored
`@db.Date` value (`dbDateStr`) lives there — no test file should keep a private copy of this math.

**Known harness limitation — do not "fix" by weakening a test.** Shifting the process clock does
NOT shift external, unshifted clocks the suite also talks to:

- **MinIO** (`section9-upload.test.ts`): the MinIO S3 signature scheme rejects requests whose
  client clock differs from the server's by more than a small tolerance
  (`RequestTimeTooSkewed`). Any `CLOKR_TEST_FAKE_CLOCK` value that differs from real wall-clock
  time by more than that tolerance — 00:30 and 12:00 both do, unless you happen to run the suite
  within minutes of that clock time — will make every MinIO-touching test in that file fail with
  HTTP 500. This is a property of the fake-clock harness itself, not a regression in the code
  under test; do not add a skip or loosen the assertion to paper over it.
- **Postgres `@default(now())` / `NOW()` columns**: a JS-side `new Date()` "before" cutoff compared
  against a DB-generated `createdAt` can produce a false positive/negative once the shift is large
  enough that the JS clock and the (unshifted) DB clock disagree about ordering
  (`presence-webhook.test.ts` REQ-10 hit this once during development of this harness, intermittently
  depending on the exact shift/run-time combination; `audit-trail.test.ts`'s "PUT
  /api/v1/settings/work writes AuditLog with action UPDATE on TenantConfig" case hits the same
  root cause deterministically at `CLOKR_TEST_FAKE_CLOCK=00:30` — the `beforeTs = new Date()`
  cutoff is shifted into the past relative to the real, unshifted DB clock, so the `gte: beforeTs`
  query matches every prior TenantConfig UPDATE audit log written during the run, and
  `logs[0]` — unordered — can return one of those instead of this test's own entry; see Phase 106
  plan 05's R7 section in `106-MEASUREMENTS.md` for the full four-way diagnosis). If you see this,
  name the exact test in your summary — do not touch the assertion.

**Measured effect of this phase** — reported as data, not as "fixed", taken directly from
the plan 01/02 SUMMARYs:

| Stage                                                          | Files   | Passed | Failed | Skipped |
| -------------------------------------------------------------- | ------- | ------ | ------ | ------- |
| Isolated DB, `db push`-provisioned (101-01, wave-1 baseline)   | 177/180 | 1929   | 4      | 3       |
| Isolated DB, `migrate deploy`-provisioned (101-02, D-02 alone) | 180/180 | 1933   | **0**  | 3       |
| + the TI-03 guard's own 14-case test file (101-02 final)       | 181/181 | 1947   | **0**  | 3       |
| Phase 106 — parallel, N=4 databases (`fileParallelism: true`)  | 199/199 | 2231   | **0**  | 3       |

`test`-job CI wall clock, same job (`.github/workflows/ci.yml`'s `test` job), same runner
shape: **BEFORE 1019s** (run `32994847691`, unmodified sequential config) → **FINAL 590s**
(run `33014113453`, parallel + the one applied cost lever) — a genuine 429s / 42%
improvement, but **NOT MET** against R1's 360s (6 min) target; the remaining driver (Vitest's
own per-file `isolate: true` bootstrap cost, ~446s of the FINAL run) is named, not hidden, in
`.planning/phases/106-.../106-MEASUREMENTS.md` § "R1 FINAL", with its two prerequisite fixes
explicitly placed outside this phase's scope.

No "before" run against the old shared-dev-database arrangement was ever performed
deliberately — doing so would mean writing a test run into the dev database again, exactly
the anti-pattern Phase 101 exists to eliminate. All three of the partial-unique-index
failures, and the previously-unresolved `leave.test.ts` full-suite-only flake, disappeared
together when provisioning switched from `db push` to `migrate deploy` (D-02) — see
`101-02-SUMMARY.md` for the full reconciliation of every number in this table.
