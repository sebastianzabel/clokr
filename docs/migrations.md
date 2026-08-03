# Database Migrations

Clokr uses **versioned Prisma migrations** for all schema changes. This replaces the
old unversioned `prisma db push` boot behaviour.

## Why versioned migrations (audit finding F-C2 / OPS-V1814-01)

`prisma db push` compares the live database to `schema.prisma` and mutates the DB to
match — it can **drop columns/tables or reset data on boot** with no review and no
history. That is unacceptable for an audit-proof (revisionssicher) system.

Versioned migrations fix this:

- **Reviewable** — each change is a committed SQL file in
  `packages/db/prisma/migrations/`, visible in code review.
- **Audit-traceable** — the applied history lives in the `_prisma_migrations` table;
  who/when/what is reconstructable (Revisionssicherheit).
- **Fails _safely_** — running `migrate deploy` against a database that already has the
  schema but was never baselined fails with **P3005** and applies **nothing** (it drops
  nothing). Contrast with `db push`, which would silently "fix" the DB.

The baseline migration is `packages/db/prisma/migrations/0_init/` — a **CREATE-only**
snapshot of the schema as it existed when migrations were introduced. It contains no
`DROP`/`TRUNCATE`/`DELETE` and no destructive `ALTER`.

## Everyday dev workflow

Create and apply a migration locally:

```bash
pnpm --filter @clokr/db exec prisma migrate dev --name <short-description>
```

This:

1. generates a new timestamped migration folder under
   `packages/db/prisma/migrations/`,
2. applies it to your local dev database,
3. regenerates the Prisma client.

**Commit the generated migration folder.** Every environment then applies pending
migrations automatically via `prisma migrate deploy` (run by the container entrypoint,
`apps/api/docker-entrypoint.sh`).

> `migrate dev` needs a **shadow database** (Prisma creates and drops a temporary DB on
> the same server). The local docker `clokr` superuser can do this out of the box.
> `migrate dev` is **dev-only** — never run it against int/prod.

Apply pending migrations manually (normally the entrypoint does this):

```bash
pnpm --filter @clokr/db exec prisma migrate deploy
```

## Fresh / empty database (fresh dev, brand-new int)

On a genuinely empty database, `migrate deploy` simply runs `0_init` (and any later
migrations) in order — no prompts, no data loss. This is exactly what the container
entrypoint does on first boot.

## ⚠️ One-time int/prod baseline runbook — SAFETY-CRITICAL, HUMAN-EXECUTED (COMPLETED)

> **Historical / completed.** This one-time baselining was carried out once per
> environment during the v1.8.x migration-foundation rollout. Both int and prod are now
> baselined and run `migrate deploy` normally. The runbook is retained for reference and
> for any _future_ environment that starts from an un-baselined `db push` state.

At that time the int and prod databases **already contained the full schema** (created by
prior `db push`) but had **no `_prisma_migrations` table yet** — they were _un-baselined_.
Prisma had to be told that `0_init` was already applied, **without executing its DDL**.

**This was NOT automated by any code in this repo.** An operator ran it deliberately,
once per environment, at the post-migration-foundation checkpoint.

Steps (per environment — int first, then prod):

1. **Confirm the target and back up first.** Make sure `DATABASE_URL` points at the
   correct, already-populated environment, then take a full backup:

   ```bash
   pg_dump "$DATABASE_URL" > backup-<env>-$(date +%F).sql
   ```

2. **Record the baseline as applied — runs NO DDL** (creates/alters/drops nothing; it
   only inserts a row into `_prisma_migrations`):

   ```bash
   DATABASE_URL=<env-dsn> pnpm --filter @clokr/db exec prisma migrate resolve --applied 0_init
   ```

3. **Verify:**

   ```bash
   DATABASE_URL=<env-dsn> pnpm --filter @clokr/db exec prisma migrate status
   # Expect: "Database schema is up to date!"
   ```

**NEVER** run `prisma migrate deploy` or `prisma db push` against int/prod **before**
the `migrate resolve --applied 0_init` step above. Doing so risks touching live data.
After baselining, future migrations flow normally via `migrate deploy`.

## Failure semantics — P3005 is the SAFE failure

If `migrate deploy` reports:

```
P3005: The database schema is not empty.
```

…the database was **not baselined**. This is the _safe_ failure — Prisma applied
nothing and dropped nothing. **Do not** force it and **do not** `db push`. Run the
`migrate resolve --applied 0_init` step from the runbook above instead.

## Production entrypoint guard

`apps/api/docker-entrypoint.sh` runs `prisma migrate deploy` whenever a migrations
directory is present (now always, since `0_init` ships in the image). If no migrations
dir is present **and** `NODE_ENV=production`, the entrypoint prints a loud fatal error
and **exits 1** — it will **never** silently fall back to `db push` in production.
Dev/test keep the `db push` fallback for iteration speed.

## CI drift check

CI runs a drift guard that fails the build if `schema.prisma` has diverged from the
committed migrations history (e.g. someone edited the schema without `migrate dev`, or
regenerated `0_init`):

```bash
pnpm --filter @clokr/db exec prisma migrate diff \
  --from-migrations prisma/migrations \
  --to-schema prisma/schema.prisma \
  --exit-code
```

Exit code `2` means drift → the job fails. Note: `--from-migrations` **replays** the
migrations into a **shadow database**, so this check needs a Postgres service and a
`SHADOW_DATABASE_URL` (wired up in `.github/workflows/ci.yml`; Prisma 7 reads the shadow
URL from `packages/db/prisma.config.ts`). It is **not** a purely offline check.

## Adding schema changes in later phases

Phases that add columns/indexes (e.g. 76.19/76.20/76.21) create a **new** `migrate dev`
migration on top of `0_init`. They **must never regenerate `0_init`** — that baseline is
frozen.

## Retention EOL policy (COMP-V1814-07)

Clokr uses a **two-stage retention lifecycle** for employee data:

**Stage 1 — Soft-delete / documented archive** (`data-retention.ts`)

The `dataRetentionPlugin` runs annually (Jan 2nd, 03:00 Europe/Berlin) and soft-deletes
time entries, leave requests, and absences older than the tenant's `dataRetentionYears`
configuration (default 10, minimum 2). Soft-delete sets `deletedAt` — the rows are
preserved for audit trail but hidden from normal queries. This IS the documented archive:
it satisfies §147 AO / §257 HGB retention requirements.

**Stage 2 — Hard-delete** (`DELETE /api/v1/employees/:id/hard-delete`)

Irreversible erasure of the employee record and all related data, invoked only when DSGVO
Art. 17 requires it after the longest applicable retention period. Hard-delete is gated by
**two unconditional guards**:

1. **§16 Abs. 2 ArbZG 2-year floor** — The employee's `exitDate` (or `createdAt` if no
   exit date is recorded) must be more than 2 full calendar years in the past. No
   `forceDelete` flag or admin override can bypass this floor. Returns HTTP 409 with
   `floorExpiresAt`.

2. **4-eyes gate inside the retention window** — If the full retention period has not yet
   expired but an ADMIN requests `forceDelete: true`, a second ADMIN must first call
   `POST /api/v1/employees/:id/hard-delete/authorize`. This writes a
   `HARD_DELETE_AUTHORIZED` AuditLog entry (TTL 15 minutes). The hard-delete then checks
   for a valid authorization authored by a **different** admin (`userId ≠ caller`) within
   the last 15 minutes. Self-authorization is rejected. Returns HTTP 409 with
   `"4-Augen-Prinzip"` message if no valid token is found.

Only after both guards pass does the `$transaction` delete cascade proceed.
