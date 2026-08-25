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

## Rehearsal (local, 2026-08-19)

Full end-to-end rehearsal of this runbook on the LOCAL docker-compose stack only
(`postgresql://clokr:password@localhost:5432/clokr`) — `DATABASE_URL` was echoed and confirmed
`localhost:5432` before every DB-touching command; the seeding script additionally refuses to run
at all against any non-`localhost` URL. Nothing here ever touched int or prod.

**Fixture.** Real local data was near-empty for this migration (local dev DB reset/re-seeded
earlier the same day), so a realistic fixture was constructed rather than relying on "nothing to
migrate" as the proof:

- A throwaway tenant + ADMIN user + three EMPLOYEE records (a, b, c), hired 2025-09-01.
- Real `TimeEntry` rows + the REAL `POST /overtime/close-month` endpoint (confirmGaps=true) closed
  genuine `SaldoSnapshot` rows for a and b (Sept 2025) and c (Sept + Oct 2025) — worked/expected/
  balance/carryOver are all real `closeEmployeeMonth()` output, not hand-typed numbers.
- Deltas were then hand-injected directly on the stored `carryOver`, mirroring exactly how the
  real historical corrections happened (an operator patching a snapshot's `carryOver` by hand):
  - **a**: `+4200` on its only (first) month, WITH a matching `AuditLog` row
    (`newValue.reason = "opening balance from old time-tracking system"`, the allowlist entry) →
    expected `MIGRATED_FROM_SNAPSHOT`.
  - **b**: `-1080` on its only (first) month, with NO `AuditLog` reason at all → expected
    `RECONSTRUCTED`.
  - **c**: `+900` on its SECOND month (Oct 2025), i.e. NOT the chain head → expected
    `needs_review` / `delta_not_at_chain_head`.

**Step 2 — audit BEFORE (full fixture in place):**

```
== Tenant: 310de0.. ==
  -- emp=bf9569f4 -- [UNEXPLAINED] month=2025-10 delta=+900 kind=normal auditReasons=0 rule=none
  -- emp=c9d5280f -- [UNEXPLAINED] month=2025-09 delta=-1080 kind=normal auditReasons=0 rule=none
  -- emp=4b83416d -- [documented ] month=2025-09 delta=+4200 rule=allowlist:opening balance from old time-tracking system

Summary: 368 active MONTHLY snapshot(s) / 25 employees / 9 tenants
  delta==0 links: 365   documented: 1   UNEXPLAINED: 2   duplicate-month: 0
Exit code: 2
```

**Step 3 — dry-run, abort path:**

```
$ tsx scripts/migrate-opening-balances.ts --all-tenants
  [eligible    ] emp=4b83416d ... minutes=4200 source=MIGRATED_FROM_SNAPSHOT
  [NEEDS REVIEW] emp=bf9569f4 blocker=delta_not_at_chain_head — Die einzige nicht erklärte
                 Abweichung liegt in Monat 2025-10, nicht am Kettenanfang. ...
  [eligible    ] emp=c9d5280f ... minutes=-1080 source=RECONSTRUCTED

1 employee(s) need review — ABORTING. Nothing written, for nobody, not even the employees
classified eligible above.
Exit code: 2
```

Verified directly against the database (not just trusted from the log): `select count(*) from
"OpeningBalance" where "employeeId" in (a, b, c)` → **0 rows**, for both a and b — proving the
`needs_review` abort really did write nothing for the eligible employees either.

**Step 4 — repair c, re-run dry-run (clean):**

c's month-2 `carryOver` was reverted to its pre-injection (legit, real `closeEmployeeMonth()`)
value. Re-running the dry-run:

```
  [eligible    ] emp=4b83416d month=2025-09 minutes=4200 source=MIGRATED_FROM_SNAPSHOT reason="opening balance from old time-tracking system"
  [skip        ] emp=bf9569f4 — chain already zero-drift, nothing to migrate
  [eligible    ] emp=c9d5280f month=2025-09 minutes=-1080 source=RECONSTRUCTED reason="Eröffnungssaldo aus dem Alt-System, übernommen aus SaldoSnapshot 9b4f64.. (Monat 2025-09, -1080 Min.). ..."

DRY-RUN: 2 OpeningBalance row(s) would be created.
Exit code: 0
```

Exactly the expected sources: a via the allowlist match, b honestly reconstructed, c no longer a
candidate at all.

**Audit run immediately BEFORE `--apply` (the true bracket for the byte-identical claim below):**

```
== Tenant: 310de0.. ==
  -- emp=c9d5280f -- [UNEXPLAINED] month=2025-09 delta=-1080
  -- emp=4b83416d -- [documented ] month=2025-09 delta=+4200 rule=allowlist:...

Summary: 368 active MONTHLY snapshot(s) / 25 employees / 9 tenants
  delta==0 links: 366   documented: 1   UNEXPLAINED: 1   duplicate-month: 0
Exit code: 2
```

(b still shows as `UNEXPLAINED` here and after — expected and unchanged: the Phase 98 audit does
not yet know about `OpeningBalance`, see section 7 below. This is the SAME reason the two audit
runs bracketing the apply must be compared to EACH OTHER, not to the very first "before fixture"
run in Step 2, which additionally still had c's mid-chain deviation present.)

**Step 4 cont'd — apply:**

```
$ tsx scripts/migrate-opening-balances.ts --tenant-id <rehearsal-tenant> --apply --actor-id <local-admin-id>
  [eligible    ] emp=4b83416d ... minutes=4200 source=MIGRATED_FROM_SNAPSHOT
  [skip        ] emp=bf9569f4 — chain already zero-drift, nothing to migrate
  [eligible    ] emp=c9d5280f ... minutes=-1080 source=RECONSTRUCTED

Applied: 2 OpeningBalance row(s) created.
Exit code: 0
```

**Step 5 — audit AFTER, and the snapshot comparison:**

`SaldoSnapshot` dump for a/b/c, before `--apply` vs after `--apply`:

```
a: id=8cb108c7 2025-08-31..2025-09-30 worked=300 expected=10560 balance=-10260 carryOver=-6060
b: id=9b4f6488 2025-08-31..2025-09-30 worked=300 expected=10560 balance=-10260 carryOver=-11340
c: id=7f9363.. 2025-08-31..2025-09-30 worked=300 expected=10560 balance=-10260 carryOver=-10260
c: id=178d78.. 2025-09-30..2025-10-31 worked=300 expected=10080 balance=-9780  carryOver=-20040
```

`diff before.txt after.txt` → **empty — byte-identical.**

Full Phase 98 audit output, before `--apply` vs after `--apply`:

```
Summary: 368 active MONTHLY snapshot(s) / 25 employees / 9 tenants
  delta==0 links: 366   documented: 1   UNEXPLAINED: 1   duplicate-month: 0
Exit code: 2
```

`diff before-apply.txt after-apply.txt` → **empty — byte-identical, same counts, same exit code
(2 — from b's still-open `UNEXPLAINED` finding, unrelated to and unaffected by this migration).**
This is the proof required by section 6 above: the migration wrote `OpeningBalance` + `AuditLog`
rows only, and the `SaldoSnapshot` chain — and therefore this audit's entire view of the world —
did not move by so much as one minute.

**Step 7 — stability under a real recalc trigger.**

Deviation from the plan's literal suggestion (documented per Rule 3 — blocking issue, not an
architectural change): the running local `api` docker container predates Phase 99 Plan 06's
`POST /overtime/opening-balance` route, and `docker compose build api` could not be used to
refresh it — the build hangs indefinitely at `npx prisma generate` fetching `prisma@7.9.1`, which
this sandbox has no outbound network path for. Rather than skip this step, the rehearsal called
the exact same exported functions the route handler calls
(`recalculateSnapshots()` from `apps/api/src/utils/recalculate-snapshots.ts`, plus an
`app.audit()` shim writing `AuditLog` with the identical shape as the real
`apps/api/src/plugins/audit.ts` decorator) directly against CURRENT SOURCE via `tsx` — the same
transaction shape (supersede-then-create inside one `$transaction`) as the route, only skipping
the HTTP/Zod/tenant-isolation wrapper, which this step is not exercising.

Superseded employee a's `OpeningBalance` with a NEW row carrying the SAME value (`4200` minutes,
`source=ADMIN_ENTRY`), then called `recalculateSnapshots(app, employeeA, 2025-09-01)` — the exact
trigger a real supersede-with-same-value through the ADMIN endpoint would fire.

Result: `{"lockedMonthsSkipped":[]}` — no month was skipped, meaning the recompute genuinely ran.
`SaldoSnapshot` dump for a/b/c afterwards is, again, **byte-identical** to the post-`--apply` dump
above (same `diff`, empty), and the Phase 98 audit output is **still byte-identical** to the
before/after-apply runs. This is the real proof the plan asked for: the opening balance is now a
documented INPUT that `getCarryOverBase()` resolves cleanly — recomputing employee a's chain from
scratch reproduces exactly the same stored `carryOver`, not a fragile value that only happens to
still be correct because nothing has touched it yet.

**Cleanup.** All fixture rows (`OpeningBalance`, `AuditLog`, `SaldoSnapshot`, `TimeEntry`,
`WorkSchedule`, `OvertimeAccount`, `Employee`, `User`, `TenantConfig`, `Tenant`) were deleted after
the rehearsal. Re-running the Phase 98 audit confirms the local dev DB is back to its pre-rehearsal
state: `0 UNEXPLAINED / 0 documented`, exit `0`. The seeding/teardown script itself was a scratchpad
artifact (`node:util`-free, no framework dependency beyond `@clokr/db` + `@prisma/adapter-pg`) and
was NOT committed — per this plan's instruction not to add a fixture script under
`apps/api/scripts/`.

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

## Durchführungsprotokoll

Record of every real-environment run of this runbook. One row per decision, append-only —
never rewrite a past entry.

| Date       | Environment | Outcome      | Recorded by                              | Detail                                         |
| ---------- | ----------- | ------------ | ---------------------------------------- | ---------------------------------------------- |
| 2026-08-20 | int + prod  | **DEFERRED** | Owner (via GSD Phase 99, Plan 08 Task 2) | Migration deliberately not yet run. See below. |

### 2026-08-20 — Deferred

**Decision:** `deferred` — Phase 99 closes with the OB-04 data migration deliberately not
executed against int or prod.

**Scope of the deferral.** Neither step of the real-environment sequence has been performed:

- **Not run:** `prisma migrate deploy` on int or prod — the additive `OpeningBalance` migration
  (`CREATE TYPE` + `CREATE TABLE` + partial `CREATE UNIQUE INDEX ... WHERE superseded = false`)
  exists and is committed, but has been applied to the **local dev database only**.
- **Not run:** `scripts/migrate-opening-balances.ts` in any mode against int or prod — no
  dry-run, no `--apply`. The six existing seeded opening balances remain exactly where they
  are today, inside `SaldoSnapshot.carryOver`.
- **No baseline or after audit counts exist for int/prod**, because no migration window was
  opened. The last known prod baseline remains the expected
  `exit 0 — 95 snapshots / 89 delta-0 / 6 documented / 0 unexplained`.

**Why deferring is safe (and why nothing is currently broken).** Without the migration, opening
balances keep behaving exactly as they do today: the v1.9.14 delta-preservation guard in
`recalculateSnapshots()` is untouched and still preserves the hand-injected carry-over values.
The deferral changes no runtime behaviour — it only postpones moving those values onto the new
first-class mechanism. This is the explicit "A — decide whether to proceed now" branch of the
Task 2 checkpoint, not an unplanned omission.

**What was completed and is not in doubt.** All of OB-01, OB-02, OB-03, OB-05, OB-06 and the
local rehearsal (OB-04 Task 1) are done and verified locally, including an `--apply` rehearsal,
the `needs_review` abort path, and a recalc-stability proof whose chain-integrity audit output
was byte-identical before and after in every bracket tested. See § Rehearsal (local, 2026-08-19).

**What remains outstanding.** Only the real-data migration itself: steps **B** through **H** of
the Task 2 checkpoint (deploy → baseline audit → dry-run → review proposed rows → apply →
re-audit unchanged → UI spot-check). The full sequence is preserved verbatim in
`.planning/phases/99-openingbalance-modell/99-08-SUMMARY.md` § "How to verify / what to run".

**Re-entry.** When the migration is scheduled, run this runbook from § 2 unchanged and append a
new row to the table above with the before/after audit counts. Do not edit this entry.

**Carried risk, stated plainly.** Until the migration runs, the six opening balances continue to
depend on the v1.9.14 guard rather than on a documented, auditor-facing `OpeningBalance` row.
That is the exact fragility Phase 99 exists to remove, so this deferral leaves the original
motivation live. OB-07 (re-evaluating whether the v1.9.14 guard can retire) is consequently
**blocked** and must not be actioned while this row reads DEFERRED — retiring the guard without
the migration in place would re-open the erasure path.
