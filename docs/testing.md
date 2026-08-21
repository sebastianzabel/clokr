# API integration test database

The `apps/api` integration suite (`pnpm --filter @clokr/api test`) connects to its own,
genuinely separate PostgreSQL database — `clokr_test` — never the local dev database
`clokr`. This document explains the arrangement, how to run the suite, how the database
is provisioned, how to reset it, what the startup guard's abort means, and what flakiness
is (and isn't) fixed by any of this. See
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

**`pnpm --filter @clokr/api test -- <path>` does not work as a single-file filter.**
Confirmed empirically, not assumed: the `--` is forwarded literally into vitest's own
argument list (`vitest run -- <path>`, not `vitest run <path>`), and vitest does not treat
that as a path filter — it runs the entire suite instead, spinning up a fresh app instance
per file exactly like a full run. Use the two-step form above.

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

`test:setup` does two things, chained with `&&` (never `;` — an unset/empty
`TEST_DATABASE_URL` must abort before the second command can fall through to any default):

1. `apps/api/scripts/ensure-test-database.ts` — creates the `clokr_test` database if it
   doesn't already exist, and stamps a `COMMENT ON DATABASE` marker
   (`apps/api/src/utils/test-database.ts`'s `TEST_DATABASE_MARKER`) that the TI-03 startup
   guard later checks for. Refuses (non-zero exit, before any connection) on a wrong
   database name, a `?schema=` parameter, or `NODE_ENV=production`. Never issues
   `DROP`/`TRUNCATE`/`DELETE`.
2. `prisma migrate deploy` against `clokr_test` — replays the committed migration history
   (`packages/db/prisma/migrations/`), the same command `apps/api/docker-entrypoint.sh`
   uses for every real environment. This **replaced** `prisma db push --accept-data-loss`
   in Phase 101 plan 02 (D-02), because `db push` generates its schema from
   `schema.prisma` alone and cannot express the project's hand-authored **partial** unique
   indexes (`WHERE`-filtered — Prisma's schema DSL has no `WHERE` syntax). Those indexes
   exist only as raw SQL inside specific migrations; `clokr_test` was silently missing all
   three of them under `db push`, which masked real constraint-violation bugs behind
   false-negative test passes. `migrate deploy` produces a byte-for-byte-correct replica
   of what every other environment actually runs. See `docs/migrations.md` for the general
   `migrate deploy` mechanics (P3005, the fresh-vs-baselined distinction) — the same rules
   apply here.

## Clean slate — resetting `clokr_test`

Neither `db push` nor `migrate deploy` truncates data — they only sync schema. A killed
test run, or simply enough accumulated local runs over time, leaves rows behind in
`clokr_test`; the next run's `beforeAll` can then collide with a leftover row (e.g. a
unique-constraint error on a fixture that assumes a clean table).

The reset for this project's docker stack — drop and recreate:

```bash
docker exec clokr-postgres-1 psql -U clokr -d postgres -c 'DROP DATABASE IF EXISTS clokr_test WITH (FORCE)'
pnpm --filter @clokr/api run test:setup
```

The Prisma-native alternative is `prisma db push --force-reset`, which Prisma itself gates
behind the `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION` environment variable (it refuses
to run without it) — safe here since `clokr_test`'s contents are explicitly disposable (see
its own marker comment). The `DROP DATABASE` form above is still preferred, because it also
clears out any leftover `_prisma_migrations` history inconsistency, not just the app
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
baseline. The fix is the same drop-and-recreate above. This is never needed in CI, which
always starts from a fresh Postgres service container, so it exercises the "migrations
apply cleanly from zero" property on every run already.

## The startup guard (TI-03)

Before any test file executes, `apps/api/vitest.setup.ts`'s `globalSetup` requires
possession of the marker `ensure-test-database.ts` stamps
(`apps/api/scripts/test-database-guard.ts`'s `assertTestDatabaseMarker`) — not merely a
matching database name. A wrong target aborts the entire run with zero tests executed and
a message naming the actual host/port/database it found instead. A second, cheaper layer
(`apps/api/vitest.worker-setup.ts`) re-checks inside every worker that the verified target
actually propagated there. Neither layer can be bypassed by an environment variable or
flag — see the guard's own header comment for the full rationale.

## Known remaining flakiness

Removing dev-data contamination removes **one** source of cross-run interference — it does
not make the suite hermetic. Be honest about what is and isn't fixed:

- **Suites still share one database within a single run.** `apps/api/vitest.config.ts`
  pins `fileParallelism: false`, and cleanup between suites is per-suite (`afterAll`
  /`afterEach` in each file), not a transaction rollback or a fresh database per file. A
  test that leaks state can still affect a later test in the same run.
- **Hardcoded-date "time-bomb" tests.** Some fixtures use literal future dates that
  eventually become the past (e.g. a Phase-43 shift-override test hit this in 2026-08).
  Unrelated failure class, not touched by Phase 101.
- **A deterministic 00:00–02:00 local failure window.** Several `today`-relative suites
  seed fixtures at UTC midnight while the endpoints they test resolve "today" in the
  tenant timezone; the two disagree for up to two hours depending on DST. See
  `.planning/phases/98-*/deferred-items.md`. Also unrelated, also not touched here — don't
  judge a red suite run between midnight and 02:00 local.

**Measured effect of this phase** — reported as data, not as "fixed", taken directly from
the plan 01/02 SUMMARYs:

| Stage                                                          | Files   | Passed | Failed | Skipped |
| -------------------------------------------------------------- | ------- | ------ | ------ | ------- |
| Isolated DB, `db push`-provisioned (101-01, wave-1 baseline)   | 177/180 | 1929   | 4      | 3       |
| Isolated DB, `migrate deploy`-provisioned (101-02, D-02 alone) | 180/180 | 1933   | **0**  | 3       |
| + the TI-03 guard's own 14-case test file (101-02 final)       | 181/181 | 1947   | **0**  | 3       |

No "before" run against the old shared-dev-database arrangement was ever performed
deliberately — doing so would mean writing a test run into the dev database again, exactly
the anti-pattern Phase 101 exists to eliminate. All three of the partial-unique-index
failures, and the previously-unresolved `leave.test.ts` full-suite-only flake, disappeared
together when provisioning switched from `db push` to `migrate deploy` (D-02) — see
`101-02-SUMMARY.md` for the full reconciliation of every number in this table.
