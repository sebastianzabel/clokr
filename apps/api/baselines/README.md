# Saldo Path Parity Baseline

Purpose: this is the AC4 (Phase 113b, `.planning/phases/113B-.../113B-CONTEXT.md` D-09) artifact
for `T22 Charakterisierungs-Baseline vor dem Umbau` — a before/after comparison of the four saldo
calculation paths (live, close, cron, recalc) that must agree with each other and with their own
pre-#99 selves. It is produced and checked by
[`measure-saldo-path-parity.ts`](../scripts/measure-saldo-path-parity.ts).

**This is NOT a correctness claim.** Whether the numbers below are the RIGHT numbers is the golden
matrix's job — the golden matrix (`apps/api/src/__tests__/golden-matrix.test.ts`,
`apps/api/src/__tests__/golden-azubi-jan2026.test.ts`, D-10) answers "is the saldo calculation
correct"; this baseline only claims that the four paths agree with each other, and that a later
run of the same command agrees with this one.

## What the JSON is

`saldo-path-parity-baseline.json` is a stably-sorted (recursively key-sorted, 2-space indent,
trailing newline) document produced by seeding the SHIFT_BASED Azubi January-2026 golden fixture
(lifted from `golden-azubi-jan2026.test.ts`'s own `beforeAll`, D-18 — never a second,
independently-built fixture) and running it through:

- **cron** — `app.tryAutoCloseMonth()`
- **manualClose** — `POST /api/v1/overtime/close-month`
- **recalc** — `recalculateSnapshots()` (after an unlock + re-close cycle gives it a fresh,
  unlocked snapshot to act on — see the script's own comment at that step for why)
- **pureCore** — `closeEmployeeMonth()` called directly, with no HTTP layer at all
- **live** — `updateOvertimeAccount()` + a read of `OvertimeAccount.balanceHours`

Every leaf value is a plain number, keyed only by this script's own labels (scenario id, path
name, field name) — never a database id, an employee name, a tenant name, or an e-mail address
(D-11). No timestamp, hostname, git sha, or duration is ever written into it: any one of those
would make the file differ on every re-run and destroy the diff, which is the file's only reason
to exist.

## HEAD this baseline describes

Commit `61746aede7da503ebe4f151c3d16dba68de9b0b9` (branch
`chore/113b-charakterisierungs-baseline`), captured 2026-09-15 — before Phase 99–101's context-cut
rebuild touches any of the four paths.

## How to reproduce it

```bash
pnpm --filter @clokr/api run test:setup
pnpm --filter @clokr/api exec tsx scripts/measure-saldo-path-parity.ts
```

Running this twice in a row with no code change produces a byte-identical file — `diff` the two
runs and it prints nothing. That is the reproducibility proof AC4 asks for, verbatim, in
`.planning/phases/113B-.../113B-02-SUMMARY.md`.

## How to check it (the post-rebuild gate)

```bash
pnpm --filter @clokr/api run test:setup
pnpm --filter @clokr/api exec tsx scripts/measure-saldo-path-parity.ts --check
```

- **exit 0** — the rebuild moved nothing across these four paths for this fixture.
- **exit 2** — read the printed diff. It names the exact scenario, path (`cron`/`manualClose`/
  `recalc`/`pureCore`/`live`), and field whose value moved, with the before/after numbers on the
  two lines directly under it.

## Rules for this file

- **Never regenerate it during the #99–#101 rebuild "to make the diff green".** Regenerating
  erases the exact evidence this file exists to carry — a `--check` failure after the rebuild is
  the finding, not a bug in the baseline.
- **The script writes to per-worker test database 1 and must not be run while
  `pnpm --filter @clokr/api test` is running** — worker 1 is then in active use by the suite, and
  writing fixture rows into it mid-run would corrupt whatever that run is doing.
- If the two-run reproducibility check above ever fails, the cause is a nondeterministic field
  leaking into the document (a timestamp, a duration, a database id) — fix
  `buildBaselineDocument()` in the script; do not hand-edit this file to make the runs agree.
