# Manual Data Refresh — prod → int Pseudonymizer Workflow

The integration environment (`https://clokr-int.example.com`) is periodically refreshed from production using **pseudonymized** data per **DSGVO Art. 32 (security of processing)** and **BDSG**. This refresh is currently **operator-driven** — no scheduled CronJob, no GitHub Action, no automated trigger.

`scripts/pseudonymize-dump.ts` (this workflow) gives each employee a distinct realistic fake name and preserves `Employee.id` + `employeeNumber` so int reports stay readable; its sibling `anonymize-dump.ts` is the full DSGVO-Art.-17 erasure that turns EVERY employee into "Gelöscht"/"GELÖSCHT-XXX" — do not use it here.

When an automated pipeline lands later, this manual runbook becomes the fall-back / debugging path.

## TL;DR — Refresh in 8 commands

```bash
# 1. pg_dump prod into a temp file (your SSH user, your laptop)
ssh prod-host 'sudo docker exec clokr-db pg_dump -U clokr -Fc clokr' \
  > /tmp/clokr-prod-$(date -u +%Y%m%dT%H%M%SZ).dump

# 2. Port-forward int's Postgres to localhost so pseudonymize-dump can connect
kubectl -n clokr port-forward statefulset/clokr-postgres 5433:5432 &

# 3. (Re)create a staging DB on int that we can mutate freely
PGPASSWORD=<int-pg-password> psql -h localhost -p 5433 -U clokr -d postgres \
  -c "DROP DATABASE IF EXISTS clokr_staging; CREATE DATABASE clokr_staging;"

# 4. Restore the prod dump into int's staging DB
PGPASSWORD=<int-pg-password> pg_restore \
  -h localhost -p 5433 -U clokr -d clokr_staging \
  --no-acl --no-owner /tmp/clokr-prod-*.dump

# 5. Apply pending migrations to clokr_staging (a dump can predate the current schema)
DATABASE_URL=postgresql://clokr:<int-pg-password>@localhost:5433/clokr_staging \
  pnpm --filter @clokr/db exec prisma migrate deploy

# 6. Pseudonymize (self-verifying — exits non-zero on any residual identifier)
DATABASE_URL=postgresql://clokr:<int-pg-password>@localhost:5433/clokr_staging \
  pnpm --filter @clokr/api exec tsx scripts/pseudonymize-dump.ts

# 7. Atomically swap clokr_staging into clokr (operator decides — only if step 6 PASSED)
PGPASSWORD=<int-pg-password> psql -h localhost -p 5433 -U clokr -d postgres -c "
  SELECT pg_terminate_backend(pid) FROM pg_stat_activity
    WHERE datname IN ('clokr','clokr_staging') AND pid <> pg_backend_pid();
  ALTER DATABASE clokr RENAME TO clokr_old_$(date -u +%Y%m%d);
  ALTER DATABASE clokr_staging RENAME TO clokr;
"
```

Roll the int API/web pods so they pick up the new DB on reconnect: `kubectl -n clokr rollout restart deployment/clokr-api deployment/clokr-web`.

```bash
# 8. Restore an admin login — the pseudonymizer set every User.passwordHash to
#    the literal "ANONYMIZED", so nobody can log in to the freshly-swapped clokr yet.
DATABASE_URL=postgresql://clokr:<int-pg-password>@localhost:5433/clokr \
  pnpm --filter @clokr/api exec tsx scripts/seed-int-admin.ts
```

**Never `prisma migrate dev`** — see step 5 below. `migrate deploy` does not run `prisma generate`.

---

## Legal posture

| Concern                                | Mitigation                                                                                                                                                                                                                                                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Art. 32 DSGVO — security of processing | All direct-identifier columns rewritten before the swap. Plain Postgres protocol is wrapped in SSH (step 1) on the way out of prod.                                                                                                                                                                                |
| Art. 17 DSGVO — right to erasure       | This workflow **pseudonymizes** (Art. 4 Nr. 5): direct identifiers (name, email, NFC, credentials) are replaced while `Employee.id`/`employeeNumber` are deliberately kept — explicitly **not** Art.-17 erasure. The Art.-17 path remains the single-employee route handler via `apps/api/src/utils/anonymize.ts`. |
| §147 AO / §257 HGB — 10-year retention | Time entries, leave requests, absences, schedules, overtime accounts are **preserved** by row count + values (only direct-identifier columns mutate). Retention is unaffected.                                                                                                                                     |
| Audit trail                            | The pseudonymizer writes a single `PSEUDONYMIZATION_RUN` AuditLog entry per run carrying `processed`, `durationMs`, and the residual-identifier check counts. Verification is **inline** in the script — it exits non-zero on failure; there is no separate validator to run.                                      |
| Residual risk — free-text notes        | `TimeEntry`/`LeaveRequest`/`Absence` free-text notes are **deliberately left untouched** so int data stays usable, and may contain incidental personal data. int is internet-reachable and protected only by login — treat it as **not** PII-free, and keep access restricted to the operator.                     |

## What gets pseudonymized

Applied to every employee in the staging DB (`apps/api/scripts/pseudonymize-dump.ts`):

| Model                              | Column              | Replaced with                                                                                        |
| ---------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------- |
| Employee                           | firstName, lastName | distinct realistic fake name from a fixed pool, deterministic by `id asc` order (re-runs idempotent) |
| Employee                           | nfcCardId           | `null`                                                                                               |
| User                               | email               | `int-{employeeNumber-or-id8}@example.invalid`                                                        |
| User                               | passwordHash        | `"ANONYMIZED"` (no login possible — see step 8)                                                      |
| Invitation, OtpToken, RefreshToken | (whole row)         | hard-deleted                                                                                         |

What is **preserved**: `Employee.id`, `Employee.employeeNumber`, `User.isActive`, `AuditLog`, and all time/leave/absence/schedule/overtime rows **including their free-text notes**.

## Pre-requisites (one-time)

- SSH access to `prod-host` as a user with `docker exec` on `clokr-db` (the operator's `operator` account)
- `kubectl` context for the `homelab` cluster with read/write in the `clokr` namespace
- Local `psql`, `pg_restore`, `pg_dump` (Postgres 18 client; Homebrew: `brew install libpq && brew link --force libpq`)
- Repo checked out with `pnpm install` already run

## Step-by-step (verbose)

### 1. Snapshot prod

Run from your laptop. Replace timestamp:

```bash
TS=$(date -u +%Y%m%dT%H%M%SZ)
ssh prod-host 'sudo docker exec clokr-db pg_dump -U clokr -Fc clokr' \
  > /tmp/clokr-prod-$TS.dump
ls -lh /tmp/clokr-prod-$TS.dump
```

A clean dump should be several MB → tens of MB depending on tenant size. If it's tiny (< 100 KB) something went wrong — inspect the dump format with `pg_restore -l /tmp/clokr-prod-$TS.dump | head` before proceeding.

### 2. Bring int's Postgres reachable

```bash
kubectl -n clokr port-forward statefulset/clokr-postgres 5433:5432
# leave running in another terminal
```

Verify in a third terminal: `psql -h localhost -p 5433 -U clokr -d postgres -c '\l'` — should list `clokr` (and possibly `clokr_staging` from a prior aborted run).

### 3. Recreate the staging DB

```bash
PGPASSWORD=<int-pg-password> psql -h localhost -p 5433 -U clokr -d postgres -c "
  DROP DATABASE IF EXISTS clokr_staging;
  CREATE DATABASE clokr_staging WITH OWNER clokr;
"
```

The int Postgres password is the value the operator injected via the ArgoCD UI Parameters tab. Read it from `kubectl -n clokr get secret <secret-name> -o jsonpath='{.data.postgres-password}' | base64 -d` if needed.

### 4. Restore the dump

```bash
PGPASSWORD=<int-pg-password> pg_restore \
  -h localhost -p 5433 -U clokr -d clokr_staging \
  --no-acl --no-owner --clean --if-exists \
  /tmp/clokr-prod-$TS.dump
```

Expect a stream of `CREATE` + `ALTER` + `COPY` lines. Warnings about `permission denied for extension` are normal (we ran `--no-acl`).

### 5. Apply pending migrations to `clokr_staging`

```bash
DATABASE_URL=postgresql://clokr:<int-pg-password>@localhost:5433/clokr_staging \
  pnpm --filter @clokr/db exec prisma migrate deploy
```

Required because the dump can predate the current schema: this happened for real when prod was
still on 1.9.18 while `User.lastSeenReleaseVersion` only shipped with v1.10.0 (migration
`packages/db/prisma/migrations/20260830220940_add_last_seen_release_version/`) — the pseudonymizer
then aborted with `PrismaClientKnownRequestError P2022 ColumnNotFound` because it queried a column
the restored dump didn't have yet.

**Never `prisma migrate dev`** — per `CLAUDE.md` ("Creating a migration"), it resets the target
database on drift, without a confirmation prompt in a non-interactive shell. `migrate deploy` also
does **not** run `prisma generate` — if you changed the schema locally, generate separately.

### 6. Pseudonymize

```bash
export DATABASE_URL=postgresql://clokr:<int-pg-password>@localhost:5433/clokr_staging

pnpm --filter @clokr/api exec tsx scripts/pseudonymize-dump.ts
# → expect output like:
# [pseudonymize] starting run pseudonymize-2026-09-12T10:15:00.000Z
# [pseudonymize] found 53 employees
# [pseudonymize] pseudonymized 53/53 employees in 447ms
# [pseudonymize] verify → residual real emails=0, live passwords=0, nfc set=0, still-"Gelöscht"=0
# [pseudonymize] ✓ PASS — names pseudonymized, logins/NFC disabled, IDs preserved.
```

The script carries its own inline verification pass and exits non-zero on failure — there is no
separate validator to run. It is idempotent (name assignment is deterministic by `id asc`), so a
re-run after fixing a problem is safe.

If it fails → STOP. Do not swap. Triage:

- `residual real emails > 0` or `live passwords > 0` — a `User` row the employee walk never reached
  (the script iterates Employees, so a `User` with no `Employee` row is not covered). Investigate;
  do not swap.
- `nfc set > 0` — an `Employee` kept its `nfcCardId`; do not swap.
- `still-"Gelöscht" > 0` — informational, expected 0; non-zero means some employee rows were not
  processed.
- `PrismaClientKnownRequestError P2022 ColumnNotFound` — step 5 (`migrate deploy`) was skipped or
  failed, and the dump predates a migration. Apply migrations, then re-run this step.

On a hard verification failure the script prints:

```
[pseudonymize] VERIFICATION FAILED — residual identifiers remain. Do NOT swap.
```

### 7. Atomic swap

Only after step 6 PASSES.

```bash
TODAY=$(date -u +%Y%m%d)
PGPASSWORD=<int-pg-password> psql -h localhost -p 5433 -U clokr -d postgres -c "
  -- Disconnect everyone from clokr + clokr_staging so RENAME can succeed
  SELECT pg_terminate_backend(pid) FROM pg_stat_activity
    WHERE datname IN ('clokr','clokr_staging') AND pid <> pg_backend_pid();
  -- Atomic rename pair
  ALTER DATABASE clokr RENAME TO clokr_old_$TODAY;
  ALTER DATABASE clokr_staging RENAME TO clokr;
"
```

Verify: `psql -h localhost -p 5433 -U clokr -d postgres -c '\l'` → new `clokr` exists, old archived to `clokr_old_YYYYMMDD`.

Restart the API + Web pods so they reconnect against the new DB:

```bash
kubectl -n clokr rollout restart deployment/clokr-api deployment/clokr-web
kubectl -n clokr rollout status deployment/clokr-api --timeout=2m
kubectl -n clokr rollout status deployment/clokr-web --timeout=2m
```

Smoke against int's HTTPS endpoint:

```bash
curl -sf https://clokr-int.example.com/api/v1/health | jq .
curl -sf https://clokr-int.example.com/api/v1/version | jq .
```

Both should return JSON; health.status="ok", version is the deployed tag.

### 8. Restore an admin login

The pseudonymizer sets every `User.passwordHash` to the literal `"ANONYMIZED"`, so nobody can log
in to the freshly-swapped `clokr` yet. Run against the now-live DB through the same port-forward:

```bash
DATABASE_URL=postgresql://clokr:<int-pg-password>@localhost:5433/clokr \
  pnpm --filter @clokr/api exec tsx scripts/seed-int-admin.ts
```

Example output:

```
[seed-int-admin] ✓ login restored
  email:    int-a1b2c3d4@example.invalid
  password: <generated-password>
  Change it in the app if this environment is shared.
```

The script picks an **existing active ADMIN** (lowest id) and never creates a person. Useful flags:

- `--email <address>` — pin a specific admin instead of the deterministic lowest-id pick
- `--password <value>` — supply a password instead of letting the script generate one
- `--disable-2fa` — only needed if the tenant has 2FA on; otherwise `POST /auth/login` returns
  202 `{ requiresOtp: true }` and mails the code to the pseudonymized, undeliverable
  `@example.invalid` address, and the restored password alone won't get you in

### 9. (Optional) drop the old DB(s) after a few days

`clokr_old_*` archives accumulate — one per refresh; three currently exist on int. List them with
`\l`, and drop the ones you've confirmed the current `clokr` has superseded:

After validating the new `clokr` works as expected, drop the rollback DB:

```bash
PGPASSWORD=<int-pg-password> psql -h localhost -p 5433 -U clokr -d postgres \
  -c "DROP DATABASE clokr_old_$TODAY;"
```

Keep at least one backup before dropping (`pg_dump` it out first if uncertain).

## Rollback

If the new `clokr` is broken (failed smoke, unexpected data, mistakes in the pseudonymizer), swap back:

```bash
PGPASSWORD=<int-pg-password> psql -h localhost -p 5433 -U clokr -d postgres -c "
  SELECT pg_terminate_backend(pid) FROM pg_stat_activity
    WHERE datname IN ('clokr','clokr_old_$TODAY') AND pid <> pg_backend_pid();
  ALTER DATABASE clokr RENAME TO clokr_failed_$TODAY;
  ALTER DATABASE clokr_old_$TODAY RENAME TO clokr;
"
kubectl -n clokr rollout restart deployment/clokr-api deployment/clokr-web
```

## What's NOT in scope for this manual workflow

- No automated `pg_dump` on a schedule (would need a clokr-anonymizer SSH user with forced-command and an anonymizer_readonly PG role — deferred)
- No `workflow_dispatch` trigger from GitHub (the operator explicitly does not want GitHub-side k8s integration)
- No k3s CronJob (template ships in `charts/clokr-app/templates/cronjob-anonymizer.yaml` but `anonymizer.enabled` defaults to `false` in `values-int.yaml`)
- No DB-probe / login-probe / authenticated E2E-smoke (Phase 71 D-19; Phase 73's territory)

## Companion docs

- `docs/int-environment.md` — int env topology (ArgoCD, Helm chart, smoke gate)
- `docs/prod-deploy.md` — prod-side deploy + rollback
- `CLAUDE.md` "DSGVO Employee Deletion = Anonymization" — single-employee rules
- `apps/api/scripts/pseudonymize-dump.ts` — batch CLI used by this workflow, self-verifying
- `apps/api/scripts/seed-int-admin.ts` — restores a login after the refresh (step 8)
- `apps/api/scripts/anonymize-dump.ts` + `apps/api/scripts/validate-anonymization.ts` — the
  single-employee, Art.-17 erasure pair. **Not used by this workflow.** `validate-anonymization.ts`
  asserts `firstName === 'Gelöscht'` and therefore **fails** against pseudonymized data.
- `apps/api/src/utils/anonymize.ts` — shared erasure helper (source of truth for the Art.-17 path)
