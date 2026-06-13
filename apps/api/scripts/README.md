# apps/api/scripts/

One-off operator and migration-artifact scripts. Inventory every script here,
classified by lifecycle.

## Classification

| Script                                         | Date       | Purpose                                                                                           | Classification                        |
| ---------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------- | ------------------------------------- |
| diagnose-saldo.ts                              | 2026-06-08 | Read-only diagnostic of updateOvertimeAccount inputs for one employee                             | Migration artifact (Phase 76.5)       |
| fix-bogus-reset-snapshots.ts                   | 2026-06-08 | One-off cleanup of pre-tracking-reset SaldoSnapshot rows leaking carryOver                        | Migration artifact (Phase 76.5)       |
| backfill-mai-shifts.ts                         | 2026-06-08 | Backfill past-dated Shift rows for one employee from a JSON spec                                  | Migration artifact (Phase 76.5)       |
| set-opening-balance.ts                         | 2026-06-08 | Set opening saldo carryOver on a pre-cutoff SaldoSnapshot                                         | Migration artifact (Phase 76.5)       |
| cleanup-tz-duplicate-snapshots.ts              | 2026-06-08 | Soft-supersede TZ-duplicate SaldoSnapshot rows; AuditLog trail + idempotent re-run                | Migration artifact (Phase 76.6)       |
| set-time-tracking-exempt.ts                    | 2026-06-08 | Toggle Employee.isTimeTrackingExempt + AuditLog (§ 18 ArbZG)                                      | Migration artifact (Phase 76.7)       |
| recalculate-snapshots-after-soll-fix.ts        | 2026-06-09 | Recompute SaldoSnapshots under v1.8.4 Ø-Methode (BAG 9 AZR 406/17); locked-month-safe; idempotent | Migration artifact (Phase 76.12)      |
| recalculate-snapshots-after-shift-netto-fix.ts | 2026-06-11 | Recompute SHIFT_BASED SaldoSnapshots after v1.8.9 brutto→netto fix; locked-month-safe; idempotent | Migration artifact (quick-260611-gap) |
| anonymize-dump.ts                              | 2026-04    | Batch DSGVO anonymization across all employees in a connected DB (CronJob entry)                  | Operator tool                         |
| validate-anonymization.ts                      | 2026-04    | Companion verifier for anonymize-dump.ts — asserts the post-condition holds                       | Operator tool                         |
| audit-workdays-vs-day-hours.ts                 | 2026-05    | Surface WorkSchedule rows whose workDays mismatches the per-day hours                             | Audit tool                            |
| audit-workschedule-non-month1.ts               | 2026-05    | Surface WorkSchedule rows whose validFrom is not the 1st of a month (pre-Phase-60)                | Audit tool                            |
| backfill-auto-revalidate.ts                    | 2026-05    | Re-revalidate TimeEntries marked isInvalid after a leave cancellation                             | Migration artifact (Phase 67.2)       |
| migrate-bs-to-work-event.ts                    | 2026-06-12 | Per-tenant atomic migration of Absence type=VOCATIONAL_SCHOOL → WorkEvent; flips workEventModelLive flag at end of tx; idempotent; AuditLog summary row per run; requires --operator-user-id | Migration artifact (Phase 80)         |
| rollback-work-event-to-bs.ts                   | 2026-06-12 | Inverse of migrate-bs-to-work-event.ts; reactivates Absence rows + soft-deletes WorkEvent + clears workEventModelLive flag; restores Absence.note byte-equivalence; requires --operator-user-id | Migration artifact (Phase 80)         |

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

## Operator tools

Operator tools are intended to be re-run as needed. They should be safe to
invoke against any environment with the appropriate DATABASE_URL.

## Audit tools

Audit tools are read-only and intended to surface data-integrity concerns
that the schema cannot enforce retroactively. Re-run as part of release-prep
or incident response.

## Invocation

All scripts run via `tsx` with the `apps/api` workspace:

```bash
DATABASE_URL=... pnpm --filter @clokr/api exec tsx scripts/<script>.ts \
  --employee-id <uuid> \
  [--actor-id <uuid>] \
  [other-script-specific-flags]
```

See each script's header comment for its exact argv contract.

## v1.8.4 Ø-Methode Snapshot-Recalc

### Purpose

v1.8.4 fixed the broken Soll-reduction formula
`weeklyHours × Kalendertage ÷ 7` (which counted Sa+So as workdays) and
replaced it with the BAG-konforme Ø-Methode
`weeklyHours ÷ workDaysPerWeek × workdaysInRange`. The legal source is
BAG 9 AZR 406/17: when an employee works fewer than six Werktage per
week, vacation/absence Soll must be reduced proportionally to the
average weekly distribution — not by raw calendar days.

`recalculate-snapshots-after-soll-fix.ts` migrates already-stored
`SaldoSnapshot` rows that were computed with the pre-v1.8.4 formula.
The script re-runs the now-fixed math against every snapshot, compares
the values, and writes one `AuditLog` row per modification with the
full `oldValue` for restoration purposes.

### When to run

**AFTER** the v1.8.4 image is deployed AND the new code is serving
traffic. Running the script before deploy is a no-op — the running
pre-v1.8.4 code will simply re-write the snapshots with the old formula
again at the next Monatsabschluss.

### Deploy sequence

1. Merge the v1.8.4 PR to `main`.
2. Wait for the `main` CI pipeline to publish
   `ghcr.io/.../clokr-api:sha-<SHA>` and the `v1.8.4` tag artifact.
3. Deploy to **int** and verify `GET /api/v1/version` returns `v1.8.4`.
4. Run **dry-run** on int (no writes):
   ```bash
   DATABASE_URL=... pnpm --filter @clokr/api exec tsx \
     scripts/recalculate-snapshots-after-soll-fix.ts --all-tenants
   ```
   Review the summary JSON: `recalculated` count, `skippedLocked`
   entries, and per-tenant delta size.
5. Run **--apply** on int:
   ```bash
   DATABASE_URL=... pnpm --filter @clokr/api exec tsx \
     scripts/recalculate-snapshots-after-soll-fix.ts --all-tenants --apply
   ```
   Verify `AuditLog` rows with `action = SALDO_RECALC_AFTER_SOLL_FIX`
   appear and the snapshot values match the dry-run preview.
6. Promote the v1.8.4 image to **prod** via the tag-as-source-of-truth
   workflow (sha-pinned, never env-var-driven).
7. Verify `GET /api/v1/version` on prod returns `v1.8.4`.
8. Run **dry-run** on prod:
   ```bash
   DATABASE_URL=... pnpm --filter @clokr/api exec tsx \
     scripts/recalculate-snapshots-after-soll-fix.ts --all-tenants
   ```
   Review the summary JSON one more time before mutating audit-relevant
   data.
9. Run **--apply** on prod:
   ```bash
   DATABASE_URL=... pnpm --filter @clokr/api exec tsx \
     scripts/recalculate-snapshots-after-soll-fix.ts --all-tenants --apply
   ```
   Confirm `AuditLog` rows are written.
10. Spot-check a known affected employee's saldo via
    `GET /api/v1/overtime/:id` to confirm the live Saldo now reflects
    the Ø-Methode values (e.g. an A.S.-style 4-day/week fixture if
    reproducible in prod).

### Sample output (--apply on a representative tenant)

```json
{
  "dryRun": false,
  "tenantsScanned": 3,
  "snapshotsScanned": 142,
  "recalculated": 23,
  "unchanged": 117,
  "skippedLocked": [
    {
      "snapshotId": "00000000-0000-0000-0000-000000000001",
      "employeeId": "00000000-0000-0000-0000-000000000002",
      "tenantId": "00000000-0000-0000-0000-000000000003",
      "periodStart": "2025-12-01T00:00:00.000Z",
      "deltaBalanceMinutes": -407
    }
  ]
}
```

- `recalculated`: snapshots that were modified.
- `unchanged`: noop matches — old values already equal Ø-Methode values
  (idempotent re-run, see D-20 below).
- `skippedLocked`: snapshots whose month is locked
  (`TimeEntry.isLocked = true` anywhere in the period). The script
  shows the delta but never writes — Revisionssicherheit per
  CLAUDE.md "Immutability after lock".

### Rollback

The script does NOT provide an automatic rollback flag. Each modified
snapshot has an `AuditLog` row with the full pre-modification
`oldValue` JSON (`workedMinutes`, `expectedMinutes`, `balanceMinutes`,
`carryOver`). To restore a single snapshot:

1. Query `AuditLog` for the affected
   `entity = 'SaldoSnapshot'`, `entityId = <snapshot-id>`,
   `action = 'SALDO_RECALC_AFTER_SOLL_FIX'`.
2. Copy `AuditLog.oldValue` back into `SaldoSnapshot` via a separate,
   operator-written UPDATE (NOT through this script).
3. Write a new `AuditLog` row for the restore action.

No bulk-rollback is offered intentionally — Revisionssicherheit
requires that any restoration be a deliberate, manually-audited action.
Locked months were never modified in the first place.

### Safety guarantees

- **Never hard-deletes rows** — every change is a `SaldoSnapshot.update`
  inside a `$transaction` paired with an `AuditLog.create`.
- **Never writes to locked months on `--apply`** — locked snapshots
  (any `TimeEntry.isLocked = true` in the period) appear in
  `summary.skippedLocked` but are skipped.
- **Idempotent** — re-running `--apply` on already-recalced snapshots
  writes zero new `AuditLog` rows (noop detection compares all four
  numeric fields before writing).
- **Requires `--tenant-id` OR `--all-tenants`** — no silent default.
  The script throws "Tenant-Auswahl erforderlich…" (German per D-17)
  and exits non-zero otherwise.

## Phase 80 — WorkEvent Migration

### Purpose

v1.9 promotes BS-Tag (Berufsschule) from `Absence type=VOCATIONAL_SCHOOL`
to a dedicated `WorkEvent` table so future day-event types
(FIELD_SERVICE, BUSINESS_TRIP, TRAINING, OTHER) become data-only
additions. `migrate-bs-to-work-event.ts` performs the per-tenant atomic
flag flip; `rollback-work-event-to-bs.ts` ships in the same PR as the
inverse operation. NO dual-write — the coexistence window is closed by
transactional semantics (per-tenant `prisma.$transaction` commits the
soft-delete + WorkEvent insert + `TenantConfig.workEventModelLive=true`
flag flip in one atomic step).

The migration produces a SUMMARY-only `AuditLog` row per tenant per run
during the bulk import — operator userId is REQUIRED via
`--operator-user-id <uuid>` (Revisionssicherheit per CLAUDE.md;
operator-attributable). Runtime CRUD on WorkEvent post-migration remains
audit-proof in the usual per-row sense.

The inverse rollback exists in the same PR (M-6 mitigation — never ship
forward without rollback). It reconstructs the original `Absence` state
byte-equivalently using the `legacyAbsenceId` link as source of truth.

### When to run

**AFTER** the v1.9 image is deployed AND the new code is serving
traffic. **AFTER** int verification passes. Per-tenant big-bang —
operators target ONE tenant per run.

### Deploy sequence

1. Merge the v1.9 PR (Phase 80) to `main`.
2. Wait for the `main` CI pipeline to publish
   `ghcr.io/.../clokr-api:sha-<SHA>` and the `v1.9` tag artifact.
3. Deploy to **int** and verify `GET /api/v1/version` returns `v1.9`.
4. **W6 — Scale API to EXACTLY 1 replica** (CRITICAL — the in-process
   pause set is single-replica only; on 2+ replicas the other replicas
   keep generating during the migration window):
   ```bash
   # k3s / k8s (int):
   kubectl scale deployment clokr-api --replicas=1
   kubectl rollout status deployment clokr-api --timeout=60s
   # docker compose (local dev):
   docker compose up --scale api=1 -d
   ```
   Verify with `kubectl get pods -l app=clokr-api` (exactly 1 Running
   pod) or `docker compose ps api` (exactly 1 container) BEFORE the
   next step.
5. **Pre-flight safety query** on int (dry-run is the default — no
   `--apply` flag):
   ```bash
   DATABASE_URL=... pnpm --filter @clokr/api exec tsx \
     scripts/migrate-bs-to-work-event.ts \
     --tenant-id <tenant-uuid> \
     --operator-user-id <operator-uuid>
   ```
   Review the JSON summary: `sourceCount`, `nonAzubiLegacyCount`,
   `existingWorkEventCount`, `wouldCreate`, `wouldSkip`.
6. If `nonAzubiLegacyCount > 0`: investigate the legacy rows first
   (M-5 — Absence VS rows whose employee is NOT classified AZUBI).
   Either fix the rows OR re-run with `--allow-non-azubi-legacy`
   after a deliberate operator decision (the flag value is recorded
   in `AuditLog.newValue.allowNonAzubiLegacy`).
7. If `existingWorkEventCount > 0` (W5 — Phase 79 operator-created
   WorkEvent VS rows without `legacyAbsenceId`): investigate. Either
   reconcile manually OR proceed with `--allow-existing-work-events`
   (count recorded in
   `AuditLog.newValue.dataQualityIssues.existingWorkEventsWithoutLegacyLink`).
8. Run `--apply` on int:
   ```bash
   DATABASE_URL=... pnpm --filter @clokr/api exec tsx \
     scripts/migrate-bs-to-work-event.ts \
     --tenant-id <tenant-uuid> \
     --operator-user-id <operator-uuid> \
     --apply
   ```
   Verify the AuditLog row:
   `SELECT * FROM "AuditLog" WHERE action = 'WORK_EVENT_MIGRATION_V19'
   AND "entityId" = '<tenant-uuid>' ORDER BY "createdAt" DESC LIMIT 1;`
   The `userId` MUST equal the `--operator-user-id` you passed
   (B2 — never null). Verify
   `tenantConfig.workEventModelLive = true` for the tenant.
9. **W8 — Wait 1-2 seconds before saldo spot-check**. In-flight
   requests started BEFORE the migration commit may still observe
   the old flag value via the 5-min `getTenantWorkEventModelLive`
   cache until they complete. The wait gives them time to drain.
   Then spot-check `GET /api/v1/overtime/<employeeId>` — saldo must
   match the pre-migration value byte-for-byte (the precompute phase
   mirrors the legacy aggregator output).
10. **Scale API back to normal replica count** AFTER the migration
    commits AND verification passes:
    ```bash
    kubectl scale deployment clokr-api --replicas=2  # or prod count
    kubectl rollout status deployment clokr-api --timeout=60s
    ```
11. If an anomaly is detected (saldo drift, DATEV PDF byte mismatch,
    or any production incident attributable to the migration) →
    run rollback IMMEDIATELY. Scale back to 1 replica FIRST:
    ```bash
    kubectl scale deployment clokr-api --replicas=1
    DATABASE_URL=... pnpm --filter @clokr/api exec tsx \
      scripts/rollback-work-event-to-bs.ts \
      --tenant-id <tenant-uuid> \
      --operator-user-id <operator-uuid> \
      --apply
    ```
    Verify `tenantConfig.workEventModelLive = false`; AuditLog row
    with `action = 'WORK_EVENT_ROLLBACK_V19'` exists; `Absence.note`
    round-trips byte-for-byte (B4 — `MIGRATION_NOTE_PATTERN` regex
    strips the migration suffix, pre-existing notes survive
    unchanged).
12. Promote the v1.9 image to **prod** via the tag-as-source-of-truth
    workflow (sha-pinned, never env-var-driven).
13. Repeat steps 4-10 on prod for each tenant individually
    (per-tenant big-bang per 80-CONTEXT.md decision; `--all-tenants`
    is explicitly OUT OF SCOPE).

### Sample dry-run output

```json
{
  "tenantId": "00000000-0000-0000-0000-000000000001",
  "operatorUserId": "00000000-0000-0000-0000-000000000002",
  "dryRun": true,
  "runId": "00000000-0000-0000-0000-0000000000aa",
  "sourceCount": 42,
  "nonAzubiLegacyCount": 0,
  "existingWorkEventCount": 0,
  "wouldCreate": 42,
  "wouldSkip": 0,
  "durationMs": 350
}
```

- `sourceCount`: candidate Absence VS rows (filtered by `tenantId`,
  `type=VOCATIONAL_SCHOOL`, `deletedAt=null`).
- `nonAzubiLegacyCount`: subset whose employee is NOT classified
  AZUBI — operator must opt in via `--allow-non-azubi-legacy`.
- `existingWorkEventCount`: WorkEvent VS rows without
  `legacyAbsenceId` (Phase 79 operator-created) — operator must opt
  in via `--allow-existing-work-events` (W5).
- `wouldCreate`: net new WorkEvent rows the apply step will insert.
- `wouldSkip`: source rows already mapped via `legacyAbsenceId` link
  (idempotent re-run signal).

### Safety guarantees

- **Per-tenant atomic transaction** — the entire migration
  (soft-delete source Absence rows + insert WorkEvent rows + flag
  flip) runs inside a single `prisma.$transaction(async (tx) => …,
  { timeout: 60_000 })`. On any failure the whole tenant rolls back
  (C-2 mitigation — no partial state at tenant boundary).
- **Pre-migration safety query** halts on non-AZUBI Absence VS rows
  unless `--allow-non-azubi-legacy` is passed (M-5).
- **Existing-WorkEvent safety query** halts on Phase 79
  operator-created WorkEvent VS rows lacking `legacyAbsenceId`
  unless `--allow-existing-work-events` is passed (W5).
- **Generator paused per-tenant** during the migration window via
  `pauseTenantGeneration(tenantId)` (M-4 — cron will NOT insert
  fresh Absence rows mid-migration). REQUIRES single-replica
  scaling (W6) because the pause set is in-process only.
- **Idempotent** — re-running `--apply` produces
  `createdCount: 0, skipped: <prior createdCount>`. The
  `@@unique([employeeId, date, type])` constraint on `WorkEvent`
  surfaces a `P2002`; the script catches it (W7 type-narrowing on
  the unique target — `P2002` on `legacyAbsenceId` is treated as a
  concurrent-run signal and rethrown, rolling back the whole tx).
- **Precompute phase resolves all `workedMinutes` +
  `expectedMinutes` BEFORE any soft-delete** (B1 — prevents
  block-week minute corruption mid-migration).
- **Summary-only AuditLog** — ONE row per tenant per run with
  operator userId attribution (M-2 + B2). NOT per-source-row
  (would be ~thousands of rows; audit-trail noise).
- **Inverse rollback ships in the same PR** (M-6).
- **`Absence.note` byte-equivalence** guaranteed by
  `preserveOriginalNote` (forward) and the `MIGRATION_NOTE_PATTERN`
  regex strip (rollback) — B4.
- **NEVER hard-deletes rows** — every source row is soft-deleted
  via `deletedAt = now()` with a `legacyAbsenceId` link to the new
  WorkEvent row (Revisionssicherheit per CLAUDE.md).
- **`--operator-user-id <uuid>` is REQUIRED** on BOTH forward and
  rollback scripts. The script validates the UUID exists in the
  `User` table before opening the transaction (fail-fast). The
  AuditLog row's `userId` field carries this value — never null.

### Reference

For the full operator playbook (pre-flight checklist, recovery
scenarios, rollback procedure with W8 cache-wait detail), see
`docs/work-event-migration-runbook.md`.
