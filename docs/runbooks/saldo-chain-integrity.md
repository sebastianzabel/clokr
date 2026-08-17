# Saldo Chain Integrity Audit — Operator Runbook

**Audience:** the operator (sole prod-deploy operator).
**Related script:** `apps/api/scripts/audit-saldo-chain-integrity.ts` (Phase 98)
**Requirements:** AUDIT-CHAIN-01 .. AUDIT-CHAIN-05

---

> **READ-ONLY — NO REPAIR MODE, AND NONE MAY EVER BE ADDED**
>
> This script performs ZERO writes. It has no `--apply` flag, no `--fix` flag, no `--repair`
> flag, and none may ever be added — this is a LOCKED Phase 98 decision, not an oversight. A
> detector that can also repair will eventually be run in repair mode by accident on payroll
> data. If a future change ever needs to _correct_ a chain, that is a separate, deliberately
> reviewed tool — never a flag bolted onto this one.

---

## No-PII note

Output contains **truncated employee ids only** — no names, no employee numbers, no tenant
names. The report is safe to paste into an issue tracker or CI log as-is.

**Caveat:** the `matched="<reason>"` field on each finding echoes an operator-authored free-text
`reason` string pulled from `AuditLog` (see the allowlist in
`apps/api/src/utils/saldo-chain-classification.ts`). These strings are conventionally
non-personal ("opening balance from old time-tracking system", "retroactive recalculation"), but
if a future reason string ever happens to contain a name, redact it before sharing the report
externally.

## Why this exists

`recalculateSnapshots()` re-threads the carry-over chain on every retroactive Saldo change, and
until v1.9.14 it silently erased hand-injected opening balances in the process — every call site
wraps it in `.catch()` with log-only handling, so even a failed or partial run produced no
visible signal. On prod, a documented pre-tracking anchor snapshot was zeroed outright, and a
second row's carry-over moved from 5216 to 4200 minutes (about 17h) with nothing pointing at it
for roughly three months. Both were found only by accident, while investigating an unrelated
symptom. v1.9.14 stops further loss going forward; this audit is what makes the condition
observable — v1.9.14 alone does not.

## Delivery mode — DECISION (AUDIT-CHAIN-05)

**manual-first.** The script is invoked by hand, exactly like its `audit-*.ts` siblings
(`audit-workdays-vs-day-hours.ts`, `audit-workschedule-non-month1.ts`), and returns a non-zero
exit code so it can be dropped into CI or cron unchanged the moment that is wanted.

**Why not scheduled yet:** the false-positive rate against real prod data is not yet known
outside a single calibration run. A job that alerts on payroll data needs a considered alerting
path (who gets paged, how noise is triaged, what counts as "acted on"); wiring one up before the
noise behaviour is understood trains everyone to ignore the alert — which is worse than having no
alert at all.

**Revisit trigger (written down, not remembered):** schedule it after **three consecutive manual
prod runs that report zero unexplained findings**, or once every finding on the current prod
baseline has been migrated onto the Phase 99 `OpeningBalance` model — whichever comes first.

**How it would be scheduled** (deferred design; the infrastructure is already present, this
phase deliberately does not build it): a `cron.schedule(...)` task registered in an `onReady`
hook, wrapped in `withAdvisoryLock(app.prisma, ADVISORY_LOCK_KEYS.<NEW_KEY>, ...)`, following the
existing pattern in `apps/api/src/plugins/attendance-checker.ts`, fanning out findings via
`app.notify()` to all tenant ADMINs (left unmapped in `EMAIL_TYPE_MAP` for a first cut, i.e.
in-app only). Explicitly OUT of scope for Phase 98.

**In-product surfacing** (Admin → Audit & Log) is also deferred, and it raises a scope question
worth writing down: persisting the audit's own findings as `AuditLog` rows would be the _only_
write this tool ever performs, which directly conflicts with the read-only lock stated above.
Any future work here must resolve that tension explicitly rather than quietly adding a write.

## Invocation

Placeholders only — **never** commit a real connection string, tenant id or employee id into
this file.

```bash
# local dev (docker compose stack)
DATABASE_URL=<LOCAL_DB_URL> pnpm --filter @clokr/api exec tsx scripts/audit-saldo-chain-integrity.ts

# int / prod — read-only, safe against live data; prefer a READ-ONLY DB role where available
DATABASE_URL=<TARGET_DB_URL> pnpm --filter @clokr/api exec tsx scripts/audit-saldo-chain-integrity.ts
```

> Note: `pnpm --filter @clokr/api exec` remaps any non-zero child exit code to a generic `1`
> (`ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL`). Always read the script's own printed
> `Exit code: <n>` line — do not trust the shell's `$?` after the `pnpm exec` wrapper. For a CI
> integration, invoke `tsx` directly (bypassing the `pnpm exec` wrapper) so `$?` is trustworthy.

## Exit codes

| Exit code | Meaning                                                              |
| --------- | -------------------------------------------------------------------- |
| `0`       | chain intact — no unexplained deltas, no duplicate-month links       |
| `1`       | `DATABASE_URL` missing, or a DB connection/query failure             |
| `2`       | unexplained carry-over delta(s) and/or duplicate-month link(s) found |

## Reading the output

The script prints one summary line per bucket. Each bucket below states what it means AND what
to do about it.

- **`delta==0 links`** — the quiet majority: the chain identity
  (`carryOver == carryOverIn + balanceMinutes`) held exactly. Nothing to do.

- **`documented deltas`** — a deliberate injection matched the allowlist in
  `apps/api/src/utils/saldo-chain-classification.ts`, or the link is a bridge row sitting at the
  head of a chain. Nothing to do now — these are exactly the rows Phase 99 (`OpeningBalance`)
  migrates onto a first-class model. Note that a documented row can still have been partially
  eroded later by a different, unlogged event: check the printed `auditReasons=<n>` count and
  review the full lineage (see the forensic query below) if the resulting amount looks wrong.

- **`UNEXPLAINED deltas`** — minutes appeared or vanished with no deliberate action on record.
  Escalation steps:
  1. Note `emp=`, `month=`, `row=`, `delta=` from the printed finding line.
  2. Pull the full lineage with the query in "Lineage forensic query" below.
  3. If a genuinely deliberate reason string exists in the lineage's `AuditLog` rows that is
     simply missing from the allowlist, add it there with a comment and re-run the audit.
  4. Otherwise treat it as a real incident and open a debug session — do **NOT** "correct" the
     snapshot by hand outside of a reviewed migration path.

- **`TRACK_ONLY links skipped`** — MONTHLY_HOURS + TRACK_ONLY employees never carry a saldo;
  `closeEmployeeMonth()` forces `carryOver = 0` for them by design, so these links violate the
  chain identity on purpose and are excluded rather than reported.

- **`duplicate-month links`** — two active rows exist for one employee-month, so the chain is
  unwalkable there. This condition fails the audit (exit `2`) on purpose — an unwalkable chain
  cannot be proven intact, and silence is exactly the failure mode this script exists to
  eliminate. Remedy: `apps/api/scripts/cleanup-tz-duplicate-snapshots.ts` (dry-run first).

- **`employees with no closed months (skipped)`** — legitimate and common: new hires, or
  employees whose entire tenure so far sits inside the still-open month. Reported as its own
  counter, separately from `delta==0 links`, so it is never confused with "no violations found".

## Lineage forensic query

Read-only, for escalation step 2 above. `SaldoSnapshot` has no `supersededBy` forward pointer, so
row ids do **NOT** survive a supersede/recreate cycle: the currently-active row's own audit trail
starts at its own creation, and earlier deliberate acts live on now-superseded ids. Always search
the full lineage of ids for the month, not just the active row's id.

```sql
-- All SaldoSnapshot rows (active AND superseded) for one employee-month.
SELECT id, "periodStart", "periodEnd", "carryOver", "balanceMinutes", superseded, "supersededReason"
FROM "SaldoSnapshot"
WHERE "employeeId" = '<EMP_ID>' AND "periodType" = 'MONTHLY'
  AND to_char("periodEnd", 'YYYY-MM') = '<YYYY-MM>'
ORDER BY "closedAt";

-- Their full audit trail, oldest first.
SELECT "createdAt", action, "entityId", "userId", "userAgent",
       "oldValue"->>'carryOver'     AS old_carry,
       "newValue"->>'carryOver'     AS new_carry,
       "newValue"->>'reason'        AS reason,
       "newValue"->>'injectedDelta' AS injected_delta
FROM "AuditLog"
WHERE entity = 'SaldoSnapshot' AND "entityId" = ANY(ARRAY['<ROW_ID_1>','<ROW_ID_2>'])
ORDER BY "createdAt";
```

## Calibration baseline (2026-08-17, v1.9.14 read-only prod dry-run)

Recorded verbatim so a future run can be compared against it: **95** active MONTHLY snapshots
across **19** employees in **1** tenant; **89** with delta `0`; exactly **6** non-zero — five
bridge rows at `-1080`, `90`, `540`, `600`, `750` minutes and one real-activity row at `6129`
(`worked = expected = 900`, `balance = 0`). A materially different split on the same prod dataset
is a bug in the audit before it is a discovery. The same split is pinned as a fixture test in
`apps/api/src/utils/__tests__/saldo-chain-integrity-calibration.test.ts`.

## When to run

- As part of release-prep.
- On incident response for any saldo anomaly report.
- **Mandatory:** immediately BEFORE and immediately AFTER the Phase 99 `OpeningBalance`
  migration (OB-04), since this audit is exactly what proves that migration left every chain
  intact.
