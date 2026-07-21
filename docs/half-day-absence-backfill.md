# Half-Day Absence Saldo Backfill Runbook

**Phase:** 76.32.1 — Half-Day Absence Saldo Correctness
**Status:** Owner-gated. Executor/CI MUST NOT run `--apply`.
**Classification:** Audit-sensitive — affected employee IDs stay in AuditLog and local intel only.

---

## Background

### What the defect was

`Absence` rows with fractional `days` (e.g. `days = 0.5` for a half-day sick leave) were valued as
**full calendar days** by every saldo path. The `days` column was never read by the saldo pipeline;
only the `[startDate, endDate]` range was used, always at full daily Soll.

**Direction of error: systematic OVER-CREDIT of Soll-reduction.**
A half-day absence (`days = 0.5`) caused the pipeline to reduce expected minutes by a full day's
Soll instead of half a day's Soll. This inflated `balanceMinutes` (and therefore `carryOverOut`) by
approximately half a daily Soll per affected half-day absence-day. Because carry-over chains forward,
one affected closed month propagates the error to all subsequent snapshots for that employee.

**Root cause:** `Absence` lacked a `halfDay Boolean` field. The fix (Phase 76.32.1) adds
`Absence.halfDay` and threads it through all saldo paths, mirroring the already-proven
`LeaveRequest.halfDay` mechanism.

**Note:** No current API route or web form creates fractional-day Absence rows. The defect is latent
for human-entered data and only materializes if `days <> ROUND(days)` rows exist (e.g. via data
import or direct DB write). The read-only probe (Step 1 below) quantifies actual exposure.

---

## Invariant: Closed months are immutable

Per Revisionssicherheit (CLAUDE.md), a closed month's `SaldoSnapshot` MUST NOT be edited in place.
All corrections flow through the audited recalculate-and-reclose mechanism:

- Each correction creates a new (or updated) snapshot via `closeEmployeeMonth`.
- Every corrected snapshot is logged in `AuditLog` with `origin = BACKFILL`.
- Unaffected (byte-identical) snapshots are never rewritten.
- The month must be explicitly unlocked before recalculation and re-locked after.

---

## Procedure

### Step 1 — Run the read-only exposure probe

```bash
DATABASE_URL=<prod-connection-string> \
  pnpm --filter @clokr/api exec tsx scripts/audit-fractional-absences.ts
```

This script is **read-only** (zero DB mutations, no `--apply`). It prints:

- Total count of fractional `Absence` rows (`days <> ROUND(days)`, `deletedAt IS NULL`,
  `type <> 'VOCATIONAL_SCHOOL'`).
- Per-employee count breakdown and affected calendar months (shape only, local console).

**If count == 0:** Ship the Phase 76.32.1 fix as a forward-only correctness fix.
No backfill is needed. Stop here.

**If count > 0:** Continue to Step 2.

---

### Step 2 — Take a database backup before any write

```bash
# Example: pg_dump to a timestamped file
pg_dump "$DATABASE_URL" -Fc -f "clokr-pre-halfday-backfill-$(date +%Y%m%d%H%M%S).dump"
```

Verify the dump is readable before proceeding.

---

### Step 3 — Dry-run: compute deltas for affected employees

For each affected employee identified in Step 1, compute the expected delta between:

- **Old stored `balanceMinutes`** (from the earliest affected closed month's `SaldoSnapshot`).
- **Recomputed `balanceMinutes`** (what `closeEmployeeMonth` would produce after the fix).

Use `scripts/diagnose-saldo.ts` or a targeted read-only query against `SaldoSnapshot` for the
affected employee IDs and months. Document each delta in a local file (NEVER commit employee IDs
or balance amounts to the repository — these are PII-adjacent).

Dry-run summary format (keep local):

```
employeeId: <id>  earliest_affected_month: YYYY-MM  delta_minutes: -NNN
```

Present this summary to the owner for sign-off before Step 4.

---

### Step 4 — Owner sign-off

The owner (not the executor, not CI) reviews the dry-run deltas and explicitly approves the backfill.

Criteria for approval:

- Deltas are in the expected direction (negative, i.e. saldo was over-credited).
- Magnitude is consistent with the defect model (+half-daily-Soll per affected half-day absence-day).
- No surprises (unexpectedly large deltas or positive deltas require investigation before proceeding).

**Executor MUST NOT proceed to Step 5 without explicit owner sign-off.**

---

### Step 5 — Apply: unlock → recompute → re-close (reverse-chronological order)

Process affected employees in reverse chronological order of their earliest affected month
(latest months first, earliest months last) to avoid carry-over chain contamination.

For each affected employee:

1. **Unlock the earliest affected closed month** for that employee.
   Use the admin API or a direct DB update (audited) to set `isLocked = false` on the
   `SaldoSnapshot` for the target month.

2. **Recompute from that month forward** using `recalculate-snapshots.ts` (the existing
   audited retroactive recalc):

   ```bash
   # This is the owner-run --apply step.
   # Executor MUST NOT run this without owner sign-off from Step 4.
   DATABASE_URL=<prod-connection-string> \
     pnpm --filter @clokr/api exec tsx scripts/recalculate-snapshots-after-soll-fix.ts \
     --employeeId <id> --fromMonth YYYY-MM --apply
   ```

   Or via the admin API endpoint for retroactive recalculation if available.

3. **Verify the corrected snapshot** matches the expected delta from Step 3.

4. **Re-close (re-lock) the month** once the corrected value is confirmed.

Each recomputed snapshot must carry `origin = BACKFILL` in its `AuditLog` entry. The existing
`closeEmployeeMonth` + `recalculate-snapshots.ts` flow already logs this origin for audit-trail
compliance.

---

## AuditLog and PII handling

- Affected employee IDs: logged to `AuditLog` (with `origin = BACKFILL`) by the recalc flow.
  These are the authoritative, compliance-visible records.
- Local dry-run output (Step 3): keep in a local file, never commit to the repository.
- This document and every committed artifact: PII-free (no employee IDs, no company names,
  no balance amounts).

Per the project saldo-anomaly tracking convention, affected MA IDs go into AuditLog only —
never into tracked docs or committed files.

---

## Executor/CI gate

**The executor and CI MUST NOT run `--apply` on any recompute script.**

The `--apply` flag in any `recalculate-snapshots-*.ts` script is an **owner action** that requires:

1. A completed dry-run (Step 3).
2. Explicit owner sign-off (Step 4).
3. A current database backup (Step 2).

Running `--apply` without these prerequisites risks silently corrupting carry-over chains for
multiple employees across multiple months, with no easy rollback (closed months are immutable).

---

## References

- Phase 76.32.1 research: `.planning/research/HALF-DAY-ABSENCE-DEFECT.md` §7 (backfill assessment)
- Probe script: `apps/api/scripts/audit-fractional-absences.ts` (read-only, zero mutations)
- Recompute utility: `apps/api/src/utils/recalculate-snapshots.ts`
- Revisionssicherheit rules: `CLAUDE.md` (Audit-Proof / Revisionssicherheit section)
- Saldo-anomaly tracking convention: memory entry "Saldo-anomaly MA tracking"
