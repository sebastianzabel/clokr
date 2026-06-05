# Manual Data Refresh — prod → int Anonymizer Workflow

The integration environment (`https://clokr-int.example.com`) is periodically refreshed from production using **anonymized** data per **DSGVO Art. 32 (security of processing)** and **BDSG**. This refresh is currently **operator-driven** — no scheduled CronJob, no GitHub Action, no automated trigger.

When an automated pipeline lands later, this manual runbook becomes the fall-back / debugging path.

## TL;DR — Refresh in 6 commands

```bash
# 1. pg_dump prod into a temp file (your SSH user, your laptop)
ssh prod-host 'sudo docker exec clokr-db pg_dump -U clokr -Fc clokr' \
  > /tmp/clokr-prod-$(date -u +%Y%m%dT%H%M%SZ).dump

# 2. Port-forward int's Postgres to localhost so anonymize-dump can connect
kubectl -n clokr port-forward statefulset/clokr-db 5433:5432 &

# 3. (Re)create a staging DB on int that we can mutate freely
PGPASSWORD=<int-pg-password> psql -h localhost -p 5433 -U clokr -d postgres \
  -c "DROP DATABASE IF EXISTS clokr_staging; CREATE DATABASE clokr_staging;"

# 4. Restore the prod dump into int's staging DB
PGPASSWORD=<int-pg-password> pg_restore \
  -h localhost -p 5433 -U clokr -d clokr_staging \
  --no-acl --no-owner /tmp/clokr-prod-*.dump

# 5. Run anonymizer + validator
DATABASE_URL=postgresql://clokr:<int-pg-password>@localhost:5433/clokr_staging \
  pnpm --filter @clokr/api exec tsx scripts/anonymize-dump.ts
DATABASE_URL=postgresql://clokr:<int-pg-password>@localhost:5433/clokr_staging \
  pnpm --filter @clokr/api exec tsx scripts/validate-anonymization.ts

# 6. Atomically swap clokr_staging into clokr (operator decides — only if step 5 PASSED)
PGPASSWORD=<int-pg-password> psql -h localhost -p 5433 -U clokr -d postgres -c "
  SELECT pg_terminate_backend(pid) FROM pg_stat_activity
    WHERE datname IN ('clokr','clokr_staging') AND pid <> pg_backend_pid();
  ALTER DATABASE clokr RENAME TO clokr_old_$(date -u +%Y%m%d);
  ALTER DATABASE clokr_staging RENAME TO clokr;
"
```

Roll the int API/web pods so they pick up the new DB on reconnect: `kubectl -n clokr rollout restart deployment/clokr-api deployment/clokr-web`.

---

## Legal posture

| Concern                                | Mitigation                                                                                                                                                                                                               |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Art. 32 DSGVO — security of processing | All PII columns rewritten before the swap. Plain Postgres protocol is wrapped in SSH (step 1) on the way out of prod.                                                                                                    |
| Art. 17 DSGVO — right to erasure       | Anonymization reuses the route-handler logic at `apps/api/src/routes/employees.ts:716-790` via the shared helper `apps/api/src/utils/anonymize.ts`. Same rules apply to a batch refresh as to a single deletion request. |
| §147 AO / §257 HGB — 10-year retention | Time entries, leave requests, absences, schedules, overtime accounts are **preserved** by row count + values (only PII columns mutate). Retention is unaffected.                                                         |
| Audit trail                            | The anonymizer writes a single `ANONYMIZATION_RUN` AuditLog entry per run with row counts pre/post + duration. The validator reads this entry to verify volume preservation.                                             |

## What gets anonymized

Mirrors CLAUDE.md "DSGVO Employee Deletion = Anonymization" — applied to every employee in the staging DB:

| Model                              | Column                   | Replaced with                                                         |
| ---------------------------------- | ------------------------ | --------------------------------------------------------------------- |
| Employee                           | firstName                | `"Gelöscht"`                                                          |
| Employee                           | lastName, employeeNumber | `"GELÖSCHT-XXX"` (XXX = original employeeNumber or first 8 hex of id) |
| Employee                           | nfcCardId                | `null`                                                                |
| User                               | email                    | `deleted-{id8}@anonymized.local`                                      |
| User                               | passwordHash             | `"ANONYMIZED"`                                                        |
| User                               | isActive                 | `false`                                                               |
| TimeEntry                          | note                     | `null`                                                                |
| LeaveRequest                       | note                     | `null`                                                                |
| Absence                            | note                     | `null`                                                                |
| Absence                            | documentPath             | `null`                                                                |
| AuditLog                           | userId                   | `null` (for the anonymized user's userId column)                      |
| Invitation, OtpToken, RefreshToken | (whole row)              | hard-deleted (not retention-relevant)                                 |

What is **preserved**: TimeEntry rows, LeaveRequest rows, Absence rows, WorkSchedule rows, OvertimeAccount rows — values intact, only PII columns mutated.

## Pre-requisites (one-time)

- SSH access to `prod-host` as a user with `docker exec` on `clokr-db` (the operator's `operator` account)
- `kubectl` context for the `homelab` cluster with read/write in the `clokr` namespace
- Local `psql`, `pg_restore`, `pg_dump` (Postgres 17 client; Homebrew: `brew install libpq && brew link --force libpq`)
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
kubectl -n clokr port-forward statefulset/clokr-db 5433:5432
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

### 5. Anonymize + validate

```bash
export DATABASE_URL=postgresql://clokr:<int-pg-password>@localhost:5433/clokr_staging

pnpm --filter @clokr/api exec tsx scripts/anonymize-dump.ts
# → expect output like:
# Anonymized 53 employees in 447ms
# AuditLog entry written: ANONYMIZATION_RUN, entityId=run-2026-06-05T...

pnpm --filter @clokr/api exec tsx scripts/validate-anonymization.ts
# → expect:
#   ✓ Employee firstName === 'Gelöscht'
#   ✓ User email matches *@anonymized.local
#   ✓ Free-text notes cleared (TimeEntry/LeaveRequest/Absence)
#   ✓ Absence documentPath cleared
#   ✓ AuditLog userId nulled for anonymized users
#   ✓ Employee.nfcCardId cleared + phone scan
#   ✓ Row counts preserved per ANONYMIZATION_RUN log
#
# ✓ PASS — anonymization complete, safe to swap staging → int.
```

If **any** validation rule fails → STOP. Do not swap. Triage:

- `employee-firstname-not-anonymized` — anonymizer was interrupted; rerun anonymize-dump.ts
- `user-email-not-anonymized` — same as above
- `leftover-free-text-notes` — anonymizer didn't touch those tables; check helper coverage
- `retention-row-count-drift` — anonymizer accidentally deleted retention-relevant rows; investigate before any swap

### 6. Atomic swap

Only after step 5 PASSES.

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

### 7. (Optional) drop the old DB after a few days

After validating the new `clokr` works as expected, drop the rollback DB:

```bash
PGPASSWORD=<int-pg-password> psql -h localhost -p 5433 -U clokr -d postgres \
  -c "DROP DATABASE clokr_old_$TODAY;"
```

Keep at least one backup before dropping (`pg_dump` it out first if uncertain).

## Rollback

If the new `clokr` is broken (failed smoke, unexpected data, mistakes in anonymizer), swap back:

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
- `apps/api/src/utils/anonymize.ts` — shared helper (source of truth)
- `apps/api/scripts/anonymize-dump.ts` — batch CLI
- `apps/api/scripts/validate-anonymization.ts` — validation gate
