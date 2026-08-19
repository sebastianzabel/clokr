# apps/api/scripts/

One-off operator and migration-artifact scripts. Inventory every script here,
classified by lifecycle.

## Classification

| Script                                         | Date       | Purpose                                                                                                                                                                                  | Classification                        |
| ---------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| diagnose-saldo.ts                              | 2026-06-08 | Read-only diagnostic of updateOvertimeAccount inputs for one employee                                                                                                                    | Migration artifact (Phase 76.5)       |
| fix-bogus-reset-snapshots.ts                   | 2026-06-08 | One-off cleanup of pre-tracking-reset SaldoSnapshot rows leaking carryOver                                                                                                               | Migration artifact (Phase 76.5)       |
| backfill-mai-shifts.ts                         | 2026-06-08 | Backfill past-dated Shift rows for one employee from a JSON spec                                                                                                                         | Migration artifact (Phase 76.5)       |
| set-opening-balance.ts                         | 2026-06-08 | Set opening saldo carryOver on a pre-cutoff SaldoSnapshot                                                                                                                                | Migration artifact (Phase 76.5)       |
| cleanup-tz-duplicate-snapshots.ts              | 2026-06-08 | Soft-supersede TZ-duplicate SaldoSnapshot rows; AuditLog trail + idempotent re-run                                                                                                       | Migration artifact (Phase 76.6)       |
| set-time-tracking-exempt.ts                    | 2026-06-08 | Toggle Employee.isTimeTrackingExempt + AuditLog (§ 18 ArbZG)                                                                                                                             | Migration artifact (Phase 76.7)       |
| recalculate-snapshots-after-shift-netto-fix.ts | 2026-06-11 | Recompute SHIFT_BASED SaldoSnapshots after v1.8.9 brutto→netto fix; locked-month-safe; idempotent                                                                                        | Migration artifact (quick-260611-gap) |
| anonymize-dump.ts                              | 2026-04    | Batch DSGVO anonymization across all employees in a connected DB (CronJob entry)                                                                                                         | Operator tool                         |
| validate-anonymization.ts                      | 2026-04    | Companion verifier for anonymize-dump.ts — asserts the post-condition holds                                                                                                              | Operator tool                         |
| audit-workdays-vs-day-hours.ts                 | 2026-05    | Surface WorkSchedule rows whose workDays mismatches the per-day hours                                                                                                                    | Audit tool                            |
| audit-workschedule-non-month1.ts               | 2026-05    | Surface WorkSchedule rows whose validFrom is not the 1st of a month (pre-Phase-60)                                                                                                       | Audit tool                            |
| backfill-auto-revalidate.ts                    | 2026-05    | Re-revalidate TimeEntries marked isInvalid after a leave cancellation                                                                                                                    | Migration artifact (Phase 67.2)       |
| audit-saldo-chain-integrity.ts                 | 2026-08-17 | Walk every active MONTHLY SaldoSnapshot chain; report unexplained carry-over deltas (read-only, exits 2 on findings)                                                                     | Audit tool                            |
| migrate-opening-balances.ts                    | 2026-08-19 | Move documented opening balances out of SaldoSnapshot.carryOver onto the OpeningBalance model; dry-run default, per-employee zero-drift assertion, aborts writing nothing on any failure | Migration artifact (Phase 99)         |

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

`migrate-opening-balances.ts` (Phase 99) follows this convention like every other migration
artifact — `--apply` is opt-in, dry-run is the default — but adds one extra guarantee on top:
it never mutates `SaldoSnapshot` at all, only `OpeningBalance` and `AuditLog`. See
`docs/runbooks/opening-balance-migration.md` for the full operator procedure.

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

## Removed scripts

| Script                                  | Status                     | Why                                                                                                                                                                                                      |
| --------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| recalculate-snapshots-after-soll-fix.ts | Removed 2026-08 (Phase 99) | One-time v1.8.4 Ø-Methode migration, applied to prod 2026-06-09/10 and never to be re-run. Also the code path that wiped a documented opening balance (`AuditLog` action `SALDO_RECALC_AFTER_SOLL_FIX`). |
| src/utils/recompute-snapshot.ts         | Removed 2026-08 (Phase 99) | Documented STALE MIRROR of the saldo math and the only importer of the above; a fifth carry-over seeding site.                                                                                           |

The audit-trail-of-record for what these scripts did is the `AuditLog` table (reason strings are
on the Phase 98 deliberate-reason allowlist, `src/utils/saldo-chain-classification.ts`) plus git
history — not the script files. `isSnapshotLocked()` was rescued into
`src/utils/snapshot-lock.ts` before the removal.
