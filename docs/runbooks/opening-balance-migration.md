# Opening Balance Migration (OB-04) — Operator Runbook

**Audience:** the operator (sole prod-deploy operator).
**Related script:** `apps/api/scripts/migrate-opening-balances.ts` (Phase 99)
**Requirements:** OB-04, OB-05
**Related runbook:** `docs/runbooks/saldo-chain-integrity.md` (Phase 98) — this migration
brackets itself with that audit, before AND after.

---

## 1. What this migrates, and what it does NOT touch

This script moves each employee's ONE documented opening balance out of an unexplained
`SaldoSnapshot.carryOver` jump and into its own `OpeningBalance` row — a first-class,
provenance-carrying model instead of a hand-patched number sitting inside a chain link.

**The script writes ONLY `OpeningBalance` and `AuditLog` rows.** It never writes, updates,
supersedes or deletes a `SaldoSnapshot`. It does not re-close a month. It does not call
`recalculateSnapshots()`. Seeding the chain head changes exactly ONE input to the carry-over
chain identity — `getCarryOverBase()` resolving the new `OpeningBalance.minutes` instead of
`0` the next time anything reads the chain head — and every stored `SaldoSnapshot` value stays
byte-identical through the migration.

**Consequently: no displayed saldo can move because of this migration.** The `OpeningBalance`
row documents a value that the stored chain already reflects; it does not change what is
stored.

The script's own invariant, enforced by CI-style grep and stated in its header comment: a
search for `saldoSnapshot.(update|create|delete|updateMany|deleteMany)` inside
`migrate-opening-balances.ts` returns nothing.

## 2. Before: run the Phase 98 chain-integrity audit and record the output

```bash
DATABASE_URL=<TARGET_DB_URL> pnpm --filter @clokr/api exec tsx scripts/audit-saldo-chain-integrity.ts
```

Record the printed **exit code** and the summary counts (see
`docs/runbooks/saldo-chain-integrity.md` for how to read them). The recorded prod baseline
(2026-08-18) is:

```
exit 0 — 95 active MONTHLY snapshots / 17 employees checked (+2 skipped, no closed months)
       — 89 delta==0 links / 6 documented / 0 UNEXPLAINED / 0 duplicate-month
```

If the BEFORE run does not show `0 UNEXPLAINED` and `0 duplicate-month`, **stop here.** This
migration only moves already-documented deltas onto the new model — it is not a repair tool
for unexplained findings, and it will correctly refuse to touch any employee whose chain isn't
provably zero-drift-after-seeding (see step 4).

## 3. Dry-run (no flags beyond tenant selection)

```bash
DATABASE_URL=<TARGET_DB_URL> pnpm --filter @clokr/api exec tsx scripts/migrate-opening-balances.ts \
  --all-tenants
```

or, scoped to one tenant:

```bash
DATABASE_URL=<TARGET_DB_URL> pnpm --filter @clokr/api exec tsx scripts/migrate-opening-balances.ts \
  --tenant-id <TENANT_UUID>
```

Dry-run is the default — no flags beyond tenant selection are needed, and **nothing is written**
regardless of how the run turns out. Read every proposed row printed in the `[eligible ]`
lines:

- Does the `reason` match what you know about that employee's history?
- Is any row `source=RECONSTRUCTED`? That is honest, not a defect — it means the original
  `AuditLog` justification could not be found, but the value itself is still real and still
  zero-drift. Decide per row whether that is acceptable to carry forward as-is, or whether you
  want to attach a better `evidenceRef`/reason by hand afterwards through
  `POST /api/v1/overtime/opening-balance` (which supersedes, never edits in place).
- Does any row say `carrierRemainsBridgeSnapshot=true`? That is the MAJORITY case (five of the
  six known prod rows are bridge rows). For those employees the bridge `SaldoSnapshot` stays
  the effective carrier of the value — `getCarryOverBase()`'s "skip bridge rows before
  consulting the opening balance" rule means the new `OpeningBalance` row is documentation
  only, not a new source of truth. This is intended, not a bug — it is called out explicitly so
  it is never mistaken for a row that silently does nothing by accident.

## 4. If any employee is reported `needs_review`: stop

```
[NEEDS REVIEW] emp=<id> blocker=<blocker> — <German explanation>
```

**Nothing was written — not for this employee, and not for any other employee in the same
run**, even the ones reported `[eligible ]`. This is deliberate (locked decision D-01): a
migration that writes for five employees and defers the sixth leaves you with a
half-migrated state and no clean rollback story.

The three possible blockers:

- `delta_not_at_chain_head` — the one non-zero delta sits somewhere other than the first
  snapshot in the chain. Seeding an `OpeningBalance` only ever affects the chain head, so this
  chain cannot be reproduced by this migration. Needs manual investigation of that specific
  month.
- `multiple_deltas` — more than one snapshot in the chain has a non-zero delta. A single
  `OpeningBalance` cannot explain more than one deviation.
- `duplicate_month_links` — two active `SaldoSnapshot` rows exist for the same employee-month;
  the chain is unwalkable. Remedy: `scripts/cleanup-tz-duplicate-snapshots.ts` (dry-run first),
  then re-run this migration.

**Expect this to happen at least once.** The ROADMAP itself flags that re-examining these six
chains may surface unrelated drift introduced by fixes shipped since the chains were originally
closed — that is exactly what `needs_review` is for. Work through the named blocker for the
affected employee(s), confirm the underlying chain is sound (re-run the Phase 98 audit if
unsure), and only then re-run this migration.

## 5. Apply

Once the dry-run report shows zero `needs_review` employees and every proposed row has been
read and accepted:

```bash
DATABASE_URL=<TARGET_DB_URL> pnpm --filter @clokr/api exec tsx scripts/migrate-opening-balances.ts \
  --all-tenants --apply --actor-id <OPERATOR_UUID>
```

`--actor-id` is required whenever `--apply` is given — the script refuses to write without it.
It becomes `OpeningBalance.createdBy` and the `AuditLog.userId` on the
`OPENING_BALANCE_MIGRATED` row written for every migrated employee.

All writes for the run happen inside ONE `$transaction` — all rows commit together, or none do.
Running the script again afterwards is safe and a no-op for every already-migrated employee
(an employee with an active `OpeningBalance` is skipped on sight, before any chain is even
walked).

## 6. After: run the Phase 98 audit again and record the output

```bash
DATABASE_URL=<TARGET_DB_URL> pnpm --filter @clokr/api exec tsx scripts/audit-saldo-chain-integrity.ts
```

**The expected result is UNCHANGED — not merely "still 0 unexplained", but byte-identical to
the BEFORE output from step 2:** the same `95 active MONTHLY snapshots`, the same
`89 delta==0` / `6 documented` / `0 UNEXPLAINED` / `0 duplicate-month` split, the same exit
code. Because this migration never writes a `SaldoSnapshot`, there is no mechanism by which the
audit's output could legitimately change as a result of this migration running. **Any
difference between the BEFORE and AFTER audit output means something else touched the data
during the window and must be investigated before proceeding with anything else** — do not
assume it is this migration's doing, and do not assume it is safe to ignore.

## 7. Known follow-up, recorded not fixed

`audit-saldo-chain-integrity.ts` classifies a documented delta via the `AuditLog` reason
allowlist (`src/utils/saldo-chain-classification.ts`) and, as of Phase 99, does not yet know
about the `OpeningBalance` model at all — it will keep classifying a migrated employee's chain
head exactly as it did before the migration (via the allowlist match or the
`bridge-at-chain-start` shape rule), which happens to still be correct because the underlying
`SaldoSnapshot` values are unchanged. Teaching the audit to prefer "an active `OpeningBalance`
row exists for this employee" over the allowlist match is a sensible later improvement — it
would make the audit's "documented" classification traceable to the actual first-class model
instead of a free-text match. It is **deliberately out of scope for Phase 99**.

## 8. Rollback

`OpeningBalance` rows are never deleted (Revisionssicherheit) — a mistaken migration is undone
by superseding the row through `POST /api/v1/overtime/opening-balance` with a
`supersededReason`, exactly like any other correction. Because this migration never touched a
`SaldoSnapshot`, **no saldo restoration is needed or possible through this path** — the stored
chain was never at risk in the first place.

## No-PII note

Output contains truncated employee and tenant ids only — no names, no employee numbers, no
tenant names (same Phase 98 convention as `audit-saldo-chain-integrity.ts`). The proposed
`reason` text for a `RECONSTRUCTED` row does not include any name; the `matched="..."` /
`reason="..."` text for a `MIGRATED_FROM_SNAPSHOT` row echoes an operator-authored free-text
string from `AuditLog` — the same caveat as the Phase 98 runbook applies: these strings are
conventionally non-personal, but redact before sharing externally if one ever happens to
contain a name.

Never commit a real `DATABASE_URL`, tenant id, or employee id into this file or into any issue
referencing a run of this script.
