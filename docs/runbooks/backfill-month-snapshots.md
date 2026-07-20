# Backfill Month Snapshots — Supervised Prod Rollout Runbook

**Audience:** the operator (sole prod-deploy operator).
**Related script:** `apps/api/scripts/backfill-month-snapshots.ts` (Phase 76.30 Plan 00)
**Requirement:** ROLL-01

---

> **HIGHEST-RISK OPERATION — READ BEFORE PROCEEDING**
>
> `--apply` writes real SaldoSnapshots, locks TimeEntries, and rewrites live `OvertimeAccount.balanceHours`
> for payroll-relevant data. Negative saldi land directly in the live system visible to employees and
> managers. There is NO "undo" button — rollback requires manual API calls per employee per month
> (see Step 6). A corrupt carryOver chain propagates forward through ALL subsequent months.
>
> **Mandatory pre-conditions before ANY `--apply` run:**
>
> 1. Fresh `pg_dump` backup (Step 1) — verified and stored.
> 2. Dry-run reviewed and signed off by the operator (Step 3).
>
> **No PII in this document.** All commands use placeholders (`<TARGET_DB_URL>`, `<TENANT_ID>`,
> `<EMP_ID>`, `<YYYY-MM>`). The per-employee diff report produced in Step 3 is a LOCAL file
> (gitignored). Do NOT commit it.

---

## Script flags reference

```bash
# Dry-run (DEFAULT — writes ZERO rows):
DATABASE_URL=<TARGET_DB_URL> pnpm --filter @clokr/api exec tsx \
  scripts/backfill-month-snapshots.ts

# Opt-in write — reads apply-minded flags below:
DATABASE_URL=<TARGET_DB_URL> pnpm --filter @clokr/api exec tsx \
  scripts/backfill-month-snapshots.ts \
  --apply \
  [--tenant <TENANT_ID>] \
  [--employee <EMP_ID>[,<EMP_ID>,...]] \
  [--until <YYYY-MM>]
```

| Flag                   | Meaning                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| _(none)_               | **Dry-run** — prints per-employee diff, writes nothing                                                                                      |
| `--apply`              | **Opt-in write** — closes open months oldest→newest, writes SaldoSnapshot + locks TimeEntries + upserts OvertimeAccount + BACKFILL AuditLog |
| `--tenant <TENANT_ID>` | Restrict to one tenant UUID                                                                                                                 |
| `--employee <EMP_ID>`  | Restrict to one or more employee IDs (comma-separated, repeatable)                                                                          |
| `--until <YYYY-MM>`    | Month ceiling (inclusive; default: previous calendar month)                                                                                 |

The script is **idempotent**: months with an existing active (`superseded=false`) SaldoSnapshot are
skipped and their carryOver is threaded forward unchanged.

---

## Step 0 — Env sequencing: dev → int → prod

Run the procedure below in this order for each environment. Do NOT skip to prod.

### 0.1 dev (local Docker)

```bash
# DATABASE_URL points at the local docker-compose postgres:
export TARGET_DB_URL="postgresql://clokr:clokr@localhost:5432/clokr"
```

Run the full procedure (Steps 1–8) on dev first. Verify the dry-run diff matches expectations.
Do not proceed to int until the dev run is clean.

### 0.2 int (k3s/homelab)

> **int is currently pinned off main to a v1.8.x tag** (v1.8.17 as of 2026-07-20, via
> `~/git/homelab clokr-app.yaml`). See `docs/int-environment.md`.

Before running on int:

1. **Forward-port / bump int to the same version as prod** will run. Edit `homelab/argocd-apps/clokr-app.yaml`
   to point at the release tag that contains Phase 76.30 Plan 00 (the backfill script). Wait for
   ArgoCD to sync and the smoke-test to pass before continuing.
2. **Verify cron parity** (see Step 2 below) — confirm int's `auto-close-month.ts` is the same
   version as prod (same commit SHA). A pinned tag drift here means the cron behaviour in int does
   not match prod.

Connect to int Postgres:

```bash
kubectl -n clokr port-forward statefulset/clokr-db 5432:5432
# In another terminal:
export TARGET_DB_URL="postgresql://<INT_DB_USER>:<INT_DB_PASS>@localhost:5432/clokr"
```

### 0.3 prod (prod-host VPS)

Run only after the int procedure is complete and the diff output looks correct.

```bash
# SSH to prod-host, then get the DATABASE_URL from the running container env:
ssh prod-host
export TARGET_DB_URL="$(docker compose -f ${CLOKR_DIR}/docker-compose.prod.yml \
  exec api printenv DATABASE_URL)"
```

---

## Step 1 — Backup FIRST (mandatory, no exceptions)

Take a fresh `pg_dump` of the target environment **before any write**. Confirm the dump file is
non-zero before proceeding.

```bash
DUMP_FILE="clokr-backfill-pre-$(date +%Y%m%dT%H%M%S).pgdump"

pg_dump \
  --format=custom \
  --compress=9 \
  --no-acl \
  --no-owner \
  "${TARGET_DB_URL}" \
  --file="${DUMP_FILE}"

# Verify the dump is non-zero:
ls -lh "${DUMP_FILE}"
# Expected: a file > 0 bytes. If 0 bytes or command failed — STOP and investigate.

echo "Backup stored at: $(pwd)/${DUMP_FILE}"
```

Store the dump on the operator machine (not on prod-host itself). Keep it until you have confirmed
the post-apply verification in Step 5 is green.

**If pg_dump fails or produces a zero-byte file — STOP. Do not proceed.**

---

## Step 2 — Pause / reconcile the auto-close cron

The `auto-close-month` cron (`apps/api/src/plugins/auto-close-month.ts`) runs daily at **06:00**
for all tenants. It closes prior months using the SYSTEM actor (`closedBy: null`, AuditLog
`newValue.origin = "SYSTEM"`) and respects the retro day-N window + `closeMonthWithGapsAllowed`
setting.

If the cron fires mid-backfill it can close months that the backfill script has not yet reached,
with potentially different semantics (e.g. older image on int with stale gap logic). This corrupts
the carryOver chain.

### 2.1 Verify cron parity

Before starting the backfill, confirm the running container's `auto-close-month.ts` is at the same
commit as the backfill script. On prod:

```bash
ssh prod-host
docker compose -f ${CLOKR_DIR}/docker-compose.prod.yml \
  exec api node -e "console.log(process.env.CLOKR_VERSION)"
# Should match the release tag you deployed for Phase 76.30.
```

On int:

```bash
kubectl -n clokr exec deployment/clokr-api -- \
  node -e "console.log(process.env.CLOKR_VERSION)"
```

If the version does not match — **STOP**. Forward-port the environment first (Step 0.2).

### 2.2 Pause the cron

Option A (preferred): run the backfill before 06:00 local time, or immediately after the 06:00
run completes, so the next fire is >23h away. Check when it last fired:

```bash
# On prod — scan API logs for the most recent cron trigger:
docker compose -f ${CLOKR_DIR}/docker-compose.prod.yml \
  logs --since=24h api | grep "Auto-Monatsabschluss"
```

On int:

```bash
kubectl -n clokr logs deployment/clokr-api --since=24h | grep "Auto-Monatsabschluss"
```

Option B: scale the API pod to 0 replicas for the duration (this disables all cron jobs in-process).

```bash
# prod (Docker Compose — stop the API container):
docker compose -f ${CLOKR_DIR}/docker-compose.prod.yml stop api

# int (Kubernetes — scale to 0):
kubectl -n clokr scale deployment clokr-api --replicas=0
```

> If you use Option B, note the time you stopped the API so you can restart it promptly after
> Step 5 verification (Step 8).

**Why this matters:** The auto-close cron uses a backward backfill loop (SNAP-02 / Phase 76.27).
If it closes a month mid-procedure, the backfill script's idempotency check will skip it and thread
the cron's carryOver forward — which may differ from the backfill's expected carryOver if the two
versions compute slightly differently.

---

## Step 3 — Dry-run + operator sign-off

Run the script with NO flags (dry-run). It writes zero rows and emits a per-employee diff table
to stdout:

```bash
# All tenants, all employees, ceiling = previous calendar month:
DATABASE_URL="${TARGET_DB_URL}" pnpm --filter @clokr/api exec tsx \
  scripts/backfill-month-snapshots.ts \
  2>&1 | tee /tmp/backfill-dry-run.txt
```

Or scoped to a single tenant:

```bash
DATABASE_URL="${TARGET_DB_URL}" pnpm --filter @clokr/api exec tsx \
  scripts/backfill-month-snapshots.ts \
  --tenant <TENANT_ID> \
  2>&1 | tee /tmp/backfill-dry-run.txt
```

### 3.1 Reviewing the diff output

Each affected employee produces a line like:

```
[DRY-RUN] employeeId=<EMP_ID> — 5 open month(s): 2026-01, 2026-02, 2026-03, 2026-04, 2026-05 |
          oldBalance=64.00h → projectedCarryOver=-3.25h
```

For each employee in the diff, verify:

- The **open months** match your expectation (the months known to be stuck-open, e.g. since Jan 2026).
- The **oldBalance** is the current (broken) live saldo visible in the UI.
- The **projectedCarryOver** is the corrected value after closing all open months. Confirm it is
  plausible (negative = employee owes hours; positive = bank of overtime hours).
- For the known "+64h anomaly" case: the projectedCarryOver should be neutral (near 0) or negative,
  NOT positive 64h. If it still shows +64h something is wrong — investigate before proceeding.

The diff report at `/tmp/backfill-dry-run.txt` is **LOCAL and gitignored**. Do NOT commit it. It
contains employee IDs (not names, but still internal IDs — see Step 8 for cleanup).

### 3.2 Operator sign-off checklist

Before running `--apply`, confirm ALL of the following:

- [ ] pg_dump backup is on disk and non-zero (Step 1).
- [ ] Cron is paused or timing is safe (Step 2).
- [ ] Dry-run diff output reviewed. Open months match expectation.
- [ ] All `projectedCarryOver` values are plausible. No anomalous large positives.
- [ ] No `[ERROR]` lines in the dry-run output.
- [ ] Summary table shows the expected `Open months found` count.

**Do NOT proceed to `--apply` until all boxes are checked.**

---

## Step 4 — `--apply` (narrow batch first, then widen)

### 4.1 Single-employee pilot run

Start with a single representative employee from the cohort. Choose one where the dry-run
projectedCarryOver is clearly understood (e.g. the "known +64h anomaly" case).

```bash
DATABASE_URL="${TARGET_DB_URL}" pnpm --filter @clokr/api exec tsx \
  scripts/backfill-month-snapshots.ts \
  --apply \
  --tenant <TENANT_ID> \
  --employee <EMP_ID> \
  2>&1 | tee /tmp/backfill-apply-pilot.txt
```

Expected output line:

```
[APPLIED] employeeId=<EMP_ID> — closed N month(s): 2026-01, ..., 2026-05
          oldBalance=64.00h → projectedCarryOver=-3.25h
```

After the pilot, run the **post-apply verification** for this employee (Step 5) before continuing.

### 4.2 Tenant-scoped batch run

Once the pilot is verified, run the full batch for the tenant:

```bash
DATABASE_URL="${TARGET_DB_URL}" pnpm --filter @clokr/api exec tsx \
  scripts/backfill-month-snapshots.ts \
  --apply \
  --tenant <TENANT_ID> \
  2>&1 | tee /tmp/backfill-apply-tenant.txt
```

Run Step 5 verification for the full cohort after this.

### 4.3 All tenants (if applicable)

If multiple tenants are affected, repeat the `--tenant`-scoped run for each before doing a global run.
A global `--apply` (no `--tenant`) is the last resort — only after each tenant is individually verified.

**The script is idempotent.** Re-running `--apply` on an already-closed month is safe — the
idempotency check (`superseded=false` snapshot exists) skips it and threads carryOver forward unchanged.

---

## Step 5 — Post-apply verification

For each employee in the backfilled cohort, verify the live saldo equals the sum of their
active snapshot carryOvers.

### 5.1 Live saldo via GET /overtime

```bash
# Replace <BASE_URL> with the env's API URL (e.g. https://clokr.example.com for prod)
# Replace <ADMIN_TOKEN> with a valid ADMIN JWT for that tenant
curl -sS \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  "<BASE_URL>/api/v1/overtime/<EMP_ID>" | jq '.balanceHours'
```

### 5.2 Active snapshot carryOvers via GET /overtime/snapshots

```bash
curl -sS \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  "<BASE_URL>/api/v1/overtime/snapshots/<EMP_ID>" \
  | jq '[.[] | select(.superseded == false) | .carryOver] | add'
# Result is in MINUTES. Divide by 60 to convert to hours.
```

**Invariant:** `GET /overtime/<EMP_ID>.balanceHours` must equal the sum of `carryOver` across all
`superseded=false` snapshots **divided by 60** (hours). A discrepancy means the OvertimeAccount was
not updated correctly — do NOT proceed; investigate before closing additional employees.

### 5.3 AuditLog confirmation

Confirm each closed month produced a BACKFILL AuditLog entry (origin=BACKFILL, no userId = SYSTEM):

```bash
# Via Prisma (in scripts or psql):
# SELECT "entityId", "newValue", "createdAt"
#   FROM "AuditLog"
#   WHERE "action" = 'CREATE'
#     AND "entity" = 'SaldoSnapshot'
#     AND "newValue"->>'origin' = 'BACKFILL'
#     AND "entityId" = '<EMP_ID>'
#   ORDER BY "createdAt" DESC;
```

---

## Step 6 — Rollback (reverse-chronological via unlock-month)

If the post-apply verification fails, or the operator decides to revert, use the
`POST /api/v1/overtime/unlock-month` endpoint to supersede snapshots.

**CRITICAL: Unlock in REVERSE chronological order — newest closed month FIRST, then older.**

The carryOver chain runs oldest→newest (each month's carryOverOut becomes the next month's
carryOverIn). If you unlock an older month first while newer snapshots are still active, the newer
months contain stale carryOver values that no longer reflect the changed older month. Unlocking
newest→oldest unwinds the chain correctly.

### 6.1 Unlock a single month

```bash
# ADMIN JWT required
curl -sS -X POST \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "employeeId": "<EMP_ID>",
    "year": <YEAR>,
    "month": <MONTH_NUMBER>,
    "reason": "Backfill rollback — Phase 76.30 — <OPERATOR_INITIALS> <DATE>"
  }' \
  "<BASE_URL>/api/v1/overtime/unlock-month"
```

The `reason` field is **mandatory** (`Revisionssicherheit` — traceability requirement). It is stored
in `SaldoSnapshot.supersededReason`. Use a descriptive reason that lets a future auditor understand
what happened.

The endpoint:

- Marks the snapshot `superseded=true` (NOT hard-deleted — Revisionssicherheit).
- Unlocks all TimeEntries in the month (`isLocked=false`).
- Writes an UNLOCK AuditLog entry (inside the same transaction).
- Triggers a live recompute of `OvertimeAccount.balanceHours`.

### 6.2 Full rollback sequence for a multi-month close

Suppose months 2026-01 through 2026-05 were closed. Unlock in reverse:

```bash
for MONTH in 5 4 3 2 1; do
  curl -sS -X POST \
    -H "Authorization: Bearer <ADMIN_TOKEN>" \
    -H "Content-Type: application/json" \
    -d "{
      \"employeeId\": \"<EMP_ID>\",
      \"year\": 2026,
      \"month\": ${MONTH},
      \"reason\": \"Backfill rollback — Phase 76.30 — <OPERATOR_INITIALS> $(date +%Y-%m-%d)\"
    }" \
    "<BASE_URL>/api/v1/overtime/unlock-month"
  echo "Unlocked 2026-${MONTH}"
done
```

After each unlock the API automatically recomputes `OvertimeAccount.balanceHours`. After
unlocking all months, run the verification from Step 5 to confirm the live saldo has reverted to
the pre-backfill value (which should match the `oldBalance` from the dry-run report).

### 6.3 Restore from pg_dump (last resort)

If the unlock-month approach is insufficient (e.g. the API is down, or data integrity is severely
corrupted), restore from the pg_dump taken in Step 1:

```bash
# STOP all containers that might write to the DB first!
# dev:
docker compose -f docker-compose.yml stop api web

# Restore:
pg_restore \
  --dbname="${TARGET_DB_URL}" \
  --clean \
  --if-exists \
  --no-acl \
  --no-owner \
  "${DUMP_FILE}"

# Restart:
docker compose -f docker-compose.yml up -d api web
```

> DB restore is **destructive** — it overwrites ALL data since the backup. Only use this if the
> unlock-month path cannot recover the state. Announce the maintenance window first.

---

## Step 7 — Environment-specific notes (int before prod)

### int — pinned to v1.8.x

int is currently pinned off main to a v1.8.x tag via `~/git/homelab clokr-app.yaml`. Before
running the backfill on int:

1. Check the pinned tag: `cat ~/git/homelab/argocd-apps/clokr-app.yaml | grep targetRevision`
2. If the pinned tag does not include Phase 76.30 Plan 00 (the backfill script), bump it to the
   release that does.
3. ArgoCD will auto-sync within ~3 minutes. Confirm with:
   ```bash
   argocd app get clokr   # should show Synced + Healthy
   kubectl -n clokr exec deployment/clokr-api -- \
     node -e "console.log(process.env.CLOKR_VERSION)"
   ```
4. Run the full procedure (Steps 1–6) on int before touching prod.

### prod — manual deploy, prod-host

Per the prod deploy decision (D-04): deploy is **manual**. There is no CI auto-deploy to prod.

Confirm prod is on the correct version before starting:

```bash
ssh prod-host
curl -sf https://clokr.example.com/api/v1/version | jq .version
```

---

## Step 8 — Post-run cleanup

After the post-apply verification (Step 5) passes for all affected employees:

1. **Re-enable the cron** (if you used Option B in Step 2 to stop the API):

   ```bash
   # prod:
   docker compose -f ${CLOKR_DIR}/docker-compose.prod.yml up -d api

   # int:
   kubectl -n clokr scale deployment clokr-api --replicas=1
   ```

   Verify the API is healthy:

   ```bash
   curl -sf https://clokr.example.com/api/v1/health | jq .status
   # Expected: "ok"
   ```

2. **Delete or secure the local diff report.** The file `/tmp/backfill-dry-run.txt` (and any
   apply logs) contain employee IDs. Delete them after the procedure is complete:

   ```bash
   rm -f /tmp/backfill-dry-run.txt /tmp/backfill-apply-pilot.txt /tmp/backfill-apply-tenant.txt
   ```

3. **Record completion** in the internal tracking system (AuditLog + local intel). Do NOT add
   employee/tenant names or IDs to any file that is committed to git.

---

## Decision log

- **2026-07-20** — Phase 76.30 Plan 01 wrote this runbook. Requires Plan 00 (backfill script)
  to be deployed before execution.
- Rollback via `unlock-month` supersedes snapshots (not hard-delete) per Revisionssicherheit
  requirement (CLAUDE.md audit-proof rules). Hard-delete of SaldoSnapshot is forbidden.
- The per-employee diff report stays local/gitignored to satisfy the no-PII-in-git requirement
  (MEMORY: "No PII in GitHub artifacts").

---

## Companion documents

- [`apps/api/scripts/backfill-month-snapshots.ts`](../../apps/api/scripts/backfill-month-snapshots.ts) — The script this runbook drives (Phase 76.30 Plan 00)
- [`apps/api/src/plugins/auto-close-month.ts`](../../apps/api/src/plugins/auto-close-month.ts) — The cron to pause/reconcile during backfill
- [`apps/api/src/routes/overtime.ts`](../../apps/api/src/routes/overtime.ts) — `unlock-month` endpoint (rollback, lines 1149–1228)
- [`docs/prod-deploy.md`](../prod-deploy.md) — Prod deploy runbook (SSH, Docker Compose, smoke tests)
- [`docs/int-environment.md`](../int-environment.md) — Int environment (k3s, ArgoCD, pinned tag management)
