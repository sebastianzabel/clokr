# WorkEvent Migration Runbook

Per-tenant migration playbook for moving from the legacy
`Absence type=VOCATIONAL_SCHOOL` model to the new `WorkEvent` model
(v1.9 Phase 80).

This document is the operator's source-of-truth playbook. The complementary
`apps/api/scripts/README.md` "Phase 80 — WorkEvent Migration" section
documents the deploy sequence at a high level; this file goes deeper into
the why, what to verify, and how to recover.

## Background

- **Why**: BS-Tag (Berufsschule) used to live as `Absence` with
  `type=VOCATIONAL_SCHOOL`. v1.9 promotes it to a dedicated `WorkEvent`
  table so future day-event types (FIELD_SERVICE, BUSINESS_TRIP,
  TRAINING, OTHER) become data-only additions rather than each requiring
  a new `Absence` enum value.
- **Per-tenant big-bang**: `TenantConfig.workEventModelLive` is a boolean
  flag. Flipping it atomically at the end of the per-tenant migration
  transaction guarantees no coexistence window (PITFALLS.md C-1/C-2/C-3
  mitigations). `--all-tenants` is explicitly OUT OF SCOPE — operators
  target ONE tenant per run.
- **Pre-prod relaxed AuditLog**: ONE summary `AuditLog` row per tenant
  per run during the bulk migration. Runtime mutations (CRUD on
  `WorkEvent` post-migration) remain audit-proof in the usual per-row
  sense per CLAUDE.md Revisionssicherheit rules.
- **Operator attribution is mandatory**: BOTH forward and rollback
  require `--operator-user-id <uuid>`. The script validates the UUID
  exists in the `User` table before opening the transaction
  (fail-fast). The `AuditLog` row's `userId` carries this value —
  never null (Revisionssicherheit per CLAUDE.md).

## Pre-flight Checklist

- [ ] v1.9 code is deployed and serving traffic on the target
      environment. Verify with `GET /api/v1/version`.
- [ ] Database backup (or snapshot) of the target environment has
      been verified — rollback path exists at the DB level too.
- [ ] No active `Monatsabschluss` batch is running for the target
      tenant (check for unfinished `auto-close-month` cron runs).
- [ ] No pending TimeEntry mutations are in flight from operator
      tooling (single-replica assumption).
- [ ] **W6 — API is scaled to EXACTLY 1 replica** before running
      `--apply`. The in-memory pause set
      (`PAUSED_TENANTS` in `apps/api/src/utils/vocational-school-generator.ts`)
      is single-replica only. Commands:
      - k3s / k8s:
        `kubectl scale deployment clokr-api --replicas=1` then
        `kubectl rollout status deployment clokr-api --timeout=60s`
        to confirm.
      - docker compose: `docker compose up --scale api=1 -d`.
      - Verify with `kubectl get pods -l app=clokr-api` (exactly 1
        Running pod) or `docker compose ps api` (exactly 1
        container).
      - Scale back to normal replica count AFTER migration commits
        AND verification passes (Step 5 below + Step 10 in the
        README deploy sequence).
- [ ] Operator has the tenant UUID handy.
- [ ] Operator has a valid user UUID for `--operator-user-id`
      (their own user id from the `User` table — audit-trail
      attribution).
- [ ] Operator understands: per-tenant migration is atomic; either
      the entire tenant is migrated or nothing changes.

## Forward Migration (Absence → WorkEvent)

### Step 1 — Dry-run for visibility

```bash
DATABASE_URL=... pnpm --filter @clokr/api exec tsx \
  scripts/migrate-bs-to-work-event.ts \
  --tenant-id <tenant-uuid> \
  --operator-user-id <operator-uuid>
```

Expected JSON shape (`--apply` flag omitted = dry-run):

```json
{
  "tenantId": "...",
  "operatorUserId": "...",
  "dryRun": true,
  "runId": "...",
  "sourceCount": 42,
  "nonAzubiLegacyCount": 0,
  "existingWorkEventCount": 0,
  "wouldCreate": 42,
  "wouldSkip": 0,
  "durationMs": 350
}
```

### Step 2 — Inspect non-AZUBI legacy rows (M-5)

If `nonAzubiLegacyCount > 0`: there are Absence VS rows whose
employee is NOT classified AZUBI. This indicates an upstream data
entry bug. Decision tree:

- **Fix upstream first** (preferred): update the affected employees'
  `classification` to AZUBI (or remove the bad Absence VS rows
  manually with full audit trail) and re-run dry-run.
- **Proceed with `--allow-non-azubi-legacy`**: deliberate operator
  decision; the flag value is recorded in
  `AuditLog.newValue.allowNonAzubiLegacy = true` for audit trail.

### Step 3 — Inspect existing WorkEvent VS rows (W5)

If `existingWorkEventCount > 0`: there are pre-existing WorkEvent
VS rows lacking `legacyAbsenceId` — these were created via Phase 79
endpoints (operator-created entries). Decision tree:

- **Investigate first**: confirm they are legitimate operator-created
  entries (not orphans from a prior failed migration).
- **Proceed with `--allow-existing-work-events`**: the count is
  recorded in
  `AuditLog.newValue.dataQualityIssues.existingWorkEventsWithoutLegacyLink`
  for audit trail.

### Step 4 — Apply

```bash
DATABASE_URL=... pnpm --filter @clokr/api exec tsx \
  scripts/migrate-bs-to-work-event.ts \
  --tenant-id <tenant-uuid> \
  --operator-user-id <operator-uuid> \
  --apply
```

Stdout's first line is the correlation header (IN-10):
`[migrate-bs-to-work-event] runId=<uuid> tenantId=<uuid> operatorUserId=<uuid> apply=true`.
Capture the `runId` for `AuditLog` cross-reference.

### Step 5 — Post-migration verification

- **W8 — Wait 1-2 seconds** before any saldo spot-check. In-flight
  requests started BEFORE the migration commit may still observe the
  old flag value via the 5-min `getTenantWorkEventModelLive` cache
  until they complete. The wait gives them time to drain.
- Verify the AuditLog row:
  ```sql
  SELECT * FROM "AuditLog"
  WHERE action = 'WORK_EVENT_MIGRATION_V19'
    AND "entityId" = '<tenant-uuid>'
  ORDER BY "createdAt" DESC LIMIT 1;
  ```
  The `userId` MUST equal the `--operator-user-id` you passed
  (B2 — never null).
- Verify the flag:
  ```sql
  SELECT "workEventModelLive" FROM "TenantConfig"
  WHERE "tenantId" = '<tenant-uuid>';
  ```
  Expected: `true`.
- Spot-check saldo: `GET /api/v1/overtime/<employeeId>` should return
  identical saldo before / after migration (byte-equivalent because
  the precompute mirrors the legacy aggregator output).
- Spot-check BC proxy: `GET /api/v1/vocational-school/upcoming`
  should now read from `WorkEvent` after the flag flip.
- **Scale API back to the normal replica count** AFTER verification
  passes:
  ```bash
  kubectl scale deployment clokr-api --replicas=2  # or prod count
  kubectl rollout status deployment clokr-api --timeout=60s
  ```

## Rollback (WorkEvent → Absence)

### When to roll back

- Saldo regression detected (live saldo deviates from pre-migration
  value by > 1 minute for any employee × month).
- PDF export byte-equivalence check fails (DATEV PDF differs).
- Any production incident attributable to the migration.

### Rollback procedure

```bash
# W6 — Scale to 1 replica FIRST.
kubectl scale deployment clokr-api --replicas=1
kubectl rollout status deployment clokr-api --timeout=60s

DATABASE_URL=... pnpm --filter @clokr/api exec tsx \
  scripts/rollback-work-event-to-bs.ts \
  --tenant-id <tenant-uuid> \
  --operator-user-id <operator-uuid> \
  --apply
```

### Step 4 — Post-rollback verification

- **W8 — Wait 1-2 seconds** before saldo spot-check (same 5-min
  cache concern as the forward path).
- Verify the AuditLog row:
  ```sql
  SELECT * FROM "AuditLog"
  WHERE action = 'WORK_EVENT_ROLLBACK_V19'
    AND "entityId" = '<tenant-uuid>'
  ORDER BY "createdAt" DESC LIMIT 1;
  ```
  The `userId` MUST equal the `--operator-user-id` you passed (B2).
- Verify the flag flipped back: `workEventModelLive === false` for
  the tenant.
- Verify `Absence.note` byte-equivalence: spot-check a few rows that
  had operator-authored notes (e.g.
  `"AZUBI XY hat Sondergenehmigung vom Berufsschullehrer"`). The
  note should be restored byte-for-byte (B4). The
  `MIGRATION_NOTE_PATTERN` regex strips the
  `[Migrated to WorkEvent. Run: ...]` suffix; pre-existing notes
  survive unchanged.
- Verify `WorkEvent` rows are soft-deleted (`deletedAt !== null`)
  with a rollback note like
  `"Rolled back to Absence <abs-uuid>. Run: <runId>"` —
  Revisionssicherheit residue, never hard-deleted.
- Scale API back to normal replica count.

## Recovery Scenarios

### Scenario A: P2002 during migration

The migration script catches `P2002` ONLY when the unique target is
`['employeeId', 'date', 'type']` (W7 type-narrowing). The affected
row is reported in `skipped`. The transaction does NOT roll back
for this case — the existing `WorkEvent` row is treated as "already
migrated" (idempotency). Re-running is safe.

**`P2002` on `legacyAbsenceId` is rethrown** (different unique
target — indicates a concurrent run on the same source). The whole
transaction rolls back. Investigate the cause (e.g. another operator
running the same script) before retrying.

### Scenario B: Transaction timeout

Default Prisma transaction timeout is 5s. The script raises it to
60s. The precompute phase (which calls
`getVocationalSchoolMinutesForDate` per row) runs OUTSIDE the
transaction so the tx itself is write-only and fast. For tenants
with >100k Absence VS rows: deferred multi-batch concern (W9
documented limit). If a timeout still occurs, the entire per-tenant
tx rolls back — `workEventModelLive` stays `false`, no partial
state.

### Scenario C: Generator race (M-4)

The script calls `pauseTenantGeneration(tenantId)` BEFORE opening
the transaction and `resumeTenantGeneration(tenantId)` in a
`finally` block. The cron skips paused tenants. If the script
process crashes mid-migration (uncaught throw), the pause set
lives in process memory — restart the API process to clear it OR
re-run the script (the cron is daily at 02:30, plenty of time to
recover).

**W6 multi-replica risk**: the pause API is in the API server
process. The migration script connects to the DB directly (out of
process), but the pause set lives in the API server replicas. On
2+ replicas, the script's pause call ONLY pauses ONE replica (the
one the load balancer happens to route the call to — and in
practice there is no such call: the script lives in process and
operates on its own in-process Set, so OTHER replicas are
completely unpaused). Always verify single-replica state before
running `--apply`. The runbook makes this a hard checklist item.

### Scenario D: Operator typo (wrong tenant)

Run the rollback script with the same `--tenant-id` AND
`--operator-user-id`. The `legacyAbsenceId` link reconstructs the
original `Absence` state exactly; the `MIGRATION_NOTE_PATTERN`
regex restores `Absence.note` byte-equivalently.

### Scenario E: Cache invalidation race (W8)

The `getTenantWorkEventModelLive` cache (in
`apps/api/src/utils/work-event.ts`) has 5-min TTL. After the
migration commits, `invalidateTenantWorkEventModelLiveCache(tenantId)`
should be invoked on the API server process — BUT requests already
in-flight (started BEFORE the migration commit) may still observe
the cached `false` value until they complete. Wait 1-2 seconds
before running any saldo spot-check to let in-flight requests
drain. This applies to BOTH forward and rollback paths.

## Reference

- Phase 80 CONTEXT:
  `.planning/phases/80-operator-migration-per-tenant-flag/80-CONTEXT.md`
- Phase 80 plans:
  - Plan 80-01 (forward script): `80-01-PLAN.md` → produces
    `apps/api/scripts/migrate-bs-to-work-event.ts`.
  - Plan 80-02 (rollback script): `80-02-PLAN.md` → produces
    `apps/api/scripts/rollback-work-event-to-bs.ts`.
  - Plan 80-03 (this PR): pause API + this runbook + README
    deploy sequence.
- Requirements: MIGRATE-V19-01, MIGRATE-V19-02, MIGRATE-V19-03,
  TEST-V19-02.
- Audit-proof rules: `CLAUDE.md` § "Audit-Proof /
  Revisionssicherheit".
- Cache invalidation helper:
  `invalidateTenantWorkEventModelLiveCache(tenantId)` in
  `apps/api/src/utils/work-event.ts`.
- Pause API:
  `pauseTenantGeneration(tenantId)` /
  `resumeTenantGeneration(tenantId)` /
  `isTenantPaused(tenantId)` /
  `_resetPausedTenantsForTests()` in
  `apps/api/src/utils/vocational-school-generator.ts`.
- Daily cron call site:
  `apps/api/src/plugins/vocational-school-generator.ts` (02:30
  schedule; per-tenant skip uses the pause set).
