# apps/api/scripts/

One-off operator and migration-artifact scripts. Inventory every script here,
classified by lifecycle.

## Classification

| Script                            | Date       | Purpose                                                                            | Classification                  |
| --------------------------------- | ---------- | ---------------------------------------------------------------------------------- | ------------------------------- |
| diagnose-saldo.ts                 | 2026-06-08 | Read-only diagnostic of updateOvertimeAccount inputs for one employee              | Migration artifact (Phase 76.5) |
| fix-bogus-reset-snapshots.ts      | 2026-06-08 | One-off cleanup of pre-tracking-reset SaldoSnapshot rows leaking carryOver         | Migration artifact (Phase 76.5) |
| backfill-mai-shifts.ts            | 2026-06-08 | Backfill past-dated Shift rows for one employee from a JSON spec                   | Migration artifact (Phase 76.5) |
| set-opening-balance.ts            | 2026-06-08 | Set opening saldo carryOver on a pre-cutoff SaldoSnapshot                          | Migration artifact (Phase 76.5) |
| cleanup-tz-duplicate-snapshots.ts | 2026-06-08 | Soft-supersede TZ-duplicate SaldoSnapshot rows; AuditLog trail + idempotent re-run | Migration artifact (Phase 76.6) |
| set-time-tracking-exempt.ts       | 2026-06-08 | Toggle Employee.isTimeTrackingExempt + AuditLog (§ 18 ArbZG)                       | Migration artifact (Phase 76.7) |
| anonymize-dump.ts                 | 2026-04    | Batch DSGVO anonymization across all employees in a connected DB (CronJob entry)   | Operator tool                   |
| validate-anonymization.ts         | 2026-04    | Companion verifier for anonymize-dump.ts — asserts the post-condition holds        | Operator tool                   |
| audit-workdays-vs-day-hours.ts    | 2026-05    | Surface WorkSchedule rows whose workDays mismatches the per-day hours              | Audit tool                      |
| audit-workschedule-non-month1.ts  | 2026-05    | Surface WorkSchedule rows whose validFrom is not the 1st of a month (pre-Phase-60) | Audit tool                      |
| backfill-auto-revalidate.ts       | 2026-05    | Re-revalidate TimeEntries marked isInvalid after a leave cancellation              | Migration artifact (Phase 67.2) |

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
