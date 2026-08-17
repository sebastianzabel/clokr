# apps/api/scripts/

One-off operator and migration-artifact scripts. Inventory every script here,
classified by lifecycle.

## Classification

| Script                                         | Date       | Purpose                                                                                                              | Classification                        |
| ---------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| diagnose-saldo.ts                              | 2026-06-08 | Read-only diagnostic of updateOvertimeAccount inputs for one employee                                                | Migration artifact (Phase 76.5)       |
| fix-bogus-reset-snapshots.ts                   | 2026-06-08 | One-off cleanup of pre-tracking-reset SaldoSnapshot rows leaking carryOver                                           | Migration artifact (Phase 76.5)       |
| backfill-mai-shifts.ts                         | 2026-06-08 | Backfill past-dated Shift rows for one employee from a JSON spec                                                     | Migration artifact (Phase 76.5)       |
| set-opening-balance.ts                         | 2026-06-08 | Set opening saldo carryOver on a pre-cutoff SaldoSnapshot                                                            | Migration artifact (Phase 76.5)       |
| cleanup-tz-duplicate-snapshots.ts              | 2026-06-08 | Soft-supersede TZ-duplicate SaldoSnapshot rows; AuditLog trail + idempotent re-run                                   | Migration artifact (Phase 76.6)       |
| set-time-tracking-exempt.ts                    | 2026-06-08 | Toggle Employee.isTimeTrackingExempt + AuditLog (§ 18 ArbZG)                                                         | Migration artifact (Phase 76.7)       |
| recalculate-snapshots-after-soll-fix.ts        | 2026-06-09 | Recompute SaldoSnapshots under v1.8.4 Ø-Methode (BAG 9 AZR 406/17); locked-month-safe; idempotent                    | Migration artifact (Phase 76.12)      |
| recalculate-snapshots-after-shift-netto-fix.ts | 2026-06-11 | Recompute SHIFT_BASED SaldoSnapshots after v1.8.9 brutto→netto fix; locked-month-safe; idempotent                    | Migration artifact (quick-260611-gap) |
| anonymize-dump.ts                              | 2026-04    | Batch DSGVO anonymization across all employees in a connected DB (CronJob entry)                                     | Operator tool                         |
| validate-anonymization.ts                      | 2026-04    | Companion verifier for anonymize-dump.ts — asserts the post-condition holds                                          | Operator tool                         |
| audit-workdays-vs-day-hours.ts                 | 2026-05    | Surface WorkSchedule rows whose workDays mismatches the per-day hours                                                | Audit tool                            |
| audit-workschedule-non-month1.ts               | 2026-05    | Surface WorkSchedule rows whose validFrom is not the 1st of a month (pre-Phase-60)                                   | Audit tool                            |
| backfill-auto-revalidate.ts                    | 2026-05    | Re-revalidate TimeEntries marked isInvalid after a leave cancellation                                                | Migration artifact (Phase 67.2)       |
| audit-saldo-chain-integrity.ts                 | 2026-08-17 | Walk every active MONTHLY SaldoSnapshot chain; report unexplained carry-over deltas (read-only, exits 2 on findings) | Audit tool                            |

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

`audit-saldo-chain-integrity.ts` (Phase 98) is the one audit tool that returns a non-zero exit
code on findings — `0` chain intact, `1` DATABASE_URL missing or DB failure, `2` unexplained
carry-over delta(s) and/or duplicate-month link(s) — so it can be used from CI or cron
unchanged. It performs ZERO writes and deliberately prints truncated employee ids only, with
no names and no employee numbers (DSGVO), unlike `audit-workdays-vs-day-hours.ts` and
`audit-workschedule-non-month1.ts`. Operator runbook: `docs/runbooks/saldo-chain-integrity.md`.

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
