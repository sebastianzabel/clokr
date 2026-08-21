# API integration test database

The `apps/api` integration suite (`pnpm --filter @clokr/api test`) connects to its own,
genuinely separate PostgreSQL database — `clokr_test` — never the local dev database
`clokr`. This document explains how that database is provisioned, why it is provisioned
the way it is, and what to do if you hit a provisioning error after pulling a change to
this mechanism. See `.planning/phases/101-testisolation-integrationstests-schreiben-in-die-dev-datenbank/`
for the full history (Phase 101, D-01/D-02).

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

## If `pnpm test` fails right after pulling this change (P3005-shaped error)

If your local `clokr_test` already existed **before** this change (provisioned by the old
`db push`-based `test:setup`), it has the app's tables but no `_prisma_migrations`
bookkeeping table — `migrate deploy` will refuse to run against it
(`P3005: the database schema is not empty`), the same failure mode `docs/migrations.md`
describes for int/prod's one-time baseline. Unlike int/prod, `clokr_test`'s contents are
explicitly disposable (see its own marker comment), so the fix is simpler than the
int/prod baseline runbook: **drop it and let it be recreated from zero** —

```bash
docker exec clokr-postgres-1 psql -U clokr -d postgres -c 'DROP DATABASE IF EXISTS clokr_test WITH (FORCE)'
pnpm --filter @clokr/api run test:setup
```

This is a **one-time** step per developer machine (and never needed in CI, which always
starts from a fresh Postgres service container, so it exercises this "migrations apply
cleanly from zero" property on every run already). After this, `pnpm test` provisions and
migrates normally on every subsequent run.

## The startup guard (TI-03)

Before any test file executes, `apps/api/vitest.setup.ts`'s `globalSetup` requires
possession of the marker `ensure-test-database.ts` stamps
(`apps/api/scripts/test-database-guard.ts`'s `assertTestDatabaseMarker`) — not merely a
matching database name. A wrong target aborts the entire run with zero tests executed and
a message naming the actual host/port/database it found instead. A second, cheaper layer
(`apps/api/vitest.worker-setup.ts`) re-checks inside every worker that the verified target
actually propagated there. Neither layer can be bypassed by an environment variable or
flag — see the guard's own header comment for the full rationale.
