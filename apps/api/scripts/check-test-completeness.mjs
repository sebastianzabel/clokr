#!/usr/bin/env node
/**
 * D-09 (Phase 106): hard floor on collected test files and tests.
 *
 * Parallelisation can silently collect fewer files than intended. Every collected test would still
 * pass, coverage would dip only slightly, and the 40% line threshold could still be cleared — so
 * R6 ("no .skip, no weakened assertion") would be violated in effect while CI stayed green. This
 * script turns that class of silent failure into a red build.
 *
 * The price, accepted deliberately in D-09: these two numbers must be raised when tests are added.
 * The failure message says exactly that, and exactly how.
 *
 * NOTE: the JSON reporter's own `numTotalTestSuites` field counts `describe` blocks across all
 * files, NOT files (see 106-MEASUREMENTS.md § "Suite size (D-09 floor inputs)" — a 197-file suite
 * reported numTotalTestSuites=800). The true file count is `testResults.length`, which matches
 * vitest's own terminal "Test Files N passed (N)" summary exactly. Do NOT read numTotalTestSuites
 * for MIN_FILES.
 */
import { readFileSync } from "node:fs";

// Re-measured 2026-09-16 on `chore/100b-fassade` @ 18468ed5, plan 100B-01 Task 1: MIN_FILES rises
// from 249 to 250 (one new file, scripts/__tests__/measure-foreign-context-access.test.ts) and
// MIN_TESTS rises from 2839 to 2869 — exactly the 30 new test cases that file adds (verified with
// `pnpm exec vitest run scripts/__tests__/measure-foreign-context-access.test.ts`, "30 tests" in
// its own output). No other test file changed in this plan. Every later 100b plan asserts equality
// against THIS number, not the pre-phase 2839.
//
// Plan 100B-02: no new test FILE (both edited files already existed) — MIN_FILES stays 250.
// MIN_TESTS rises from 2869 to 2874: +2 in shift-week-leave-absence-minutes.test.ts (cases E, F)
// and +3 in contexts/absence/__tests__/leave-check.test.ts (the LeaveRequest branch: tenant-name
// pre-change pin, CANCELLATION_REQUESTED status, branch ordering) — 2869 + 2 + 3 = 2874. Verified
// with `pnpm exec vitest run` on each file individually ("6 tests" in both cases, up from 4 and 3
// respectively) before the full-suite run.
//
// Plan 100B-03: one new test FILE (scripts/__tests__/lint-facade-signatures.test.ts) — MIN_FILES
// rises from 250 to 251. MIN_TESTS rises from 2874 to 2895: +21 test cases in that file (verified
// with `pnpm exec vitest run scripts/__tests__/lint-facade-signatures.test.ts`, "21 tests" in its
// own output) — 2874 + 21 = 2895. No other test file changed in this plan.
//
// Plan 100B-04: one new test FILE (scripts/__tests__/lint-tenant-scoping-facade.test.ts) —
// MIN_FILES rises from 251 to 252. MIN_TESTS rises from 2895 to 2911: +16 test cases in that file
// (verified with `pnpm exec vitest run scripts/__tests__/lint-tenant-scoping-facade.test.ts`, "16
// tests" in its own output) — 2895 + 16 = 2911. No other test file changed in this plan; confirmed
// against the full-suite run's own "Test Files 252 passed (252)" / "Tests 2908 passed | 3 skipped
// (2911)" summary.
//
// Plan 100B-05: one new test FILE
// (src/contexts/scheduling/__tests__/facade-shifts.test.ts) — MIN_FILES rises from 252 to 253.
// MIN_TESTS rises from 2911 to 2916: +5 test cases in that file (verified with `pnpm exec vitest
// run src/contexts/scheduling/__tests__/facade-shifts.test.ts`, "5 tests" in its own output) —
// 2911 + 5 = 2916. No other test file changed in this plan.
//
// Plan 100B-06: one new test FILE
// (src/contexts/working-time-account/__tests__/facade-overtime-account.test.ts) — MIN_FILES rises
// from 253 to 254. MIN_TESTS rises from 2916 to 2925: +9 test cases in that file (verified with
// `pnpm exec vitest run src/contexts/working-time-account/__tests__/facade-overtime-account.test.ts`,
// "9 tests" in its own output) — 2916 + 9 = 2925. No other test file changed in this plan.
//
// Issue #241: no new test FILE (src/__tests__/test-dates.test.ts already existed) — MIN_FILES
// stays 254. MIN_TESTS rises from 2925 to 2928: +3 test cases for the new
// `saldoSnapshotPeriodBounds` fixture helper (verified with `pnpm exec vitest run
// src/__tests__/test-dates.test.ts`, "18 tests" in its own output, up from 15) — 2925 + 3 = 2928.
// The three existing tests this issue fixed (vocational-school-endpoints.test.ts x2,
// shifts-conflicts.test.ts x1) only changed HOW their existing SaldoSnapshot fixtures are built,
// not the test count.
//
// Issue #241 (fourth site — vocational-school-generator.ts's own BERSCH-09 lock-skip, the
// same defect the three sites above already fixed): no new test FILE. MIN_FILES stays 254.
// MIN_TESTS rises from 2928 to 2929: +1 new test case ("BERSCH-09 (Issue #241, consequence 1) —
// a locked month at the window's OWN leading edge...") in
// src/__tests__/vocational-school.test.ts (verified with `pnpm exec vitest run
// src/__tests__/vocational-school.test.ts`, "26 tests" in its own output, up from 25) —
// 2928 + 1 = 2929. Three existing tests (vocational-school.test.ts x2,
// vocational-school-retroactive.test.ts x3) only changed HOW their SaldoSnapshot fixtures are
// built (naive Date.UTC -> saldoSnapshotPeriodBounds()), not the test count.
//
// Issue #241 (fifth site — shift-cleanup.ts's own locked-month guard, the same defect the four
// sites above already fixed — plus the gate itself, scripts/lint-saldo-lock-derivation.ts): one
// new test FILE (scripts/__tests__/lint-saldo-lock-derivation.test.ts) — MIN_FILES rises from
// 254 to 255. MIN_TESTS rises from 2929 to 2960: +31 test cases in that new file (verified with
// `pnpm exec vitest run scripts/__tests__/lint-saldo-lock-derivation.test.ts`, "31 tests" in its
// own output) — 2929 + 31 = 2960. The existing `src/__tests__/shift-cleanup.test.ts` T5 test only
// changed HOW its SaldoSnapshot fixture is built (naive Date.UTC -> saldoSnapshotPeriodBounds()),
// not the test count.
// Phase 100B Plan 07 (Wave 3, final) — one new test FILE
// (contexts/working-time-account/__tests__/facade-saldo-snapshot.test.ts) — MIN_FILES rises
// from 255 to 256. MIN_TESTS rises from 2960 to 2981: +21 test cases in that new file (verified
// with `pnpm exec vitest run .../facade-saldo-snapshot.test.ts`, "21 tests" in its own output) —
// 2960 + 21 = 2981. Plus the facade-parameter-resolution regression guard added to the EXISTING
// `scripts/__tests__/lint-saldo-lock-derivation.test.ts` (no new FILE — MIN_FILES unchanged at
// 256): +7 test cases (31 -> 38, verified the same way) — MIN_TESTS rises from 2981 to 2988.
//
// Phase 100B Plan 08 (Wave 4) — one new test FILE
// (contexts/time-tracking/__tests__/facade-time-entries.test.ts) — MIN_FILES rises from 256 to
// 257. MIN_TESTS rises from 2988 to 3004: +16 test cases in that new file (verified with
// `pnpm exec vitest run .../facade-time-entries.test.ts`, "16 tests" in its own output) —
// 2988 + 16 = 3004. No other test file's test COUNT changed in this plan.
//
// Phase 100B Plan 09 (Wave 4, closing) — one new test FILE
// (contexts/time-tracking/__tests__/facade-presence-devices.test.ts) — MIN_FILES rises from 257
// to 258. MIN_TESTS rises from 3004 to 3012: +8 test cases in that new file (verified with
// `pnpm exec vitest run .../facade-presence-devices.test.ts`, "8 tests" in its own output) —
// 3004 + 8 = 3012. `src/__tests__/me-wifi.test.ts`'s existing "employee cannot delete another
// employee's device" test case gained two extra assertions (404 not 403, device-still-there) but
// stayed ONE test case — its file's own test COUNT (17) is unchanged, so it adds nothing here.
//
// Phase 100B Plan 10 (Wave 5, opening) — one new test FILE
// (contexts/absence/__tests__/facade-entitlements.test.ts) — MIN_FILES rises from 258 to 259.
// MIN_TESTS rises from 3012 to 3035: +23 test cases in that new file (verified with
// `pnpm exec vitest run .../facade-entitlements.test.ts`, "23 tests" in its own output) —
// 3012 + 23 = 3035. No other test file's test COUNT changed in this plan.
//
// Phase 100B Plan 11 (Wave 5) — one new test FILE
// (contexts/absence/__tests__/facade-vocational-school-patterns.test.ts) — MIN_FILES rises from
// 259 to 260. MIN_TESTS rises from 3035 to 3044: +9 test cases in that new file (verified with
// `pnpm exec vitest run .../facade-vocational-school-patterns.test.ts`, "9 tests" in its own
// output) — 3035 + 9 = 3044. No other test file's test COUNT changed in this plan.
//
// Phase 100B Plan 12 (Wave 5, closing model) — one new test FILE
// (contexts/absence/__tests__/facade-absences.test.ts) — MIN_FILES rises from 260 to 261.
// MIN_TESTS rises from 3044 to 3057: +13 test cases in that new file (verified with
// `pnpm exec vitest run .../facade-absences.test.ts`, "13 tests" in its own output) —
// 3044 + 13 = 3057. No other test file's test COUNT changed in this plan.
//
// Phase 100B Plan 13 (Wave 5, LAST conversion plan — workload reaches zero) — one new test FILE
// (contexts/absence/__tests__/facade-leave-requests.test.ts) — MIN_FILES rises from 261 to 262.
// MIN_TESTS rises from 3057 to 3076: +19 test cases in that new file (verified with
// `pnpm exec vitest run .../facade-leave-requests.test.ts`, "19 tests" in its own output) —
// 3057 + 19 = 3076. No other test file's test COUNT changed in this plan.
//
// Phase 100B Plan 14 (AC-4, closing wave 6) — no new test FILE (leave-check.test.ts already
// existed) — MIN_FILES stays 262. MIN_TESTS rises from 3076 to 3077: the LeaveRequest branch's
// describe block gained a fourth case (the null-LeaveType.code -> OTHER fallback) while its
// original "tenant-editable name" case was replaced rather than added alongside — net +1 test in
// that file (verified with `pnpm exec vitest run .../leave-check.test.ts`, "7 tests" in its own
// output, up from 6) — 3076 + 1 = 3077.
//
// Plan 243-01 (Wave 1, task 1) — one new test FILE (src/__tests__/route-surface.test.ts) —
// MIN_FILES rises from 262 to 263. MIN_TESTS rises from 3077 to 3080: +3 test cases in that new
// file (verified with `pnpm exec vitest run src/__tests__/route-surface.test.ts`, "3 tests" in
// its own output) — 3077 + 3 = 3080. No other test file's test COUNT changed in this plan.
//
// Plan 235-01 (Wave 1, task 3) — FINDING before the bump: this file's own constants (263/3080,
// last touched by Plan 243-01) were ALREADY STALE at Phase 235's start (`main @ 83077d15`), before
// this plan changed anything. `83077d15` is Phase 101B's own closing merge commit (10 plan waves,
// ending 101B-10) and it added `scripts/__tests__/measure-context-boundary-imports.test.ts` plus
// many new test cases in existing files across those 10 waves, without ANY of them bumping this
// floor's constants — no trail entry for "101B" exists above this one. Because this gate is a
// LOWER bound (`files < MIN_FILES || tests < MIN_TESTS`), the stale 263/3080 floor kept passing
// trivially throughout the whole phase; nothing broke, but the floor verified less than it
// appeared to, silently, for ten plan waves — the same drift class this phase (235) exists to stop
// happening on the guards that walk the source tree. This gate does not (it reads a JSON report,
// not the tree), so it is outside the AST classifier's scope, but the SAME discipline applies:
// measure, don't inherit. Cross-validated three ways before touching the constants: (1) a full
// `pnpm --filter @clokr/api test` run on this plan's own HEAD reported "Test Files 265 passed
// (265)" / "Tests 3163 passed | 3 skipped (3166)"; (2) this plan's own new file
// (scripts/__tests__/lint-guard-vacuity-detect.test.ts) is the ONLY test file this plan added, with
// "20 tests" in its own single-file run, so the PRE-task state is arithmetically 265-1=264 files,
// 3166-20=3146 tests; (3) `.planning/STATE.md:54` independently records Phase 101B-10's own closing
// full-suite run as "264 files / 3143 passed / 3 skipped" — 3143+3=3146, matching (2) exactly.
// MIN_FILES therefore rises from the MEASURED 264 (not the stale 263) to 265. MIN_TESTS rises from
// the MEASURED 3146 (not the stale 3080) to 3166 — 3146 + 20 = 3166, matching the full-suite run's
// own totals in (1) exactly.
//
// Plan 235-02 (Wave 2) — one new test FILE (scripts/__tests__/lint-guard-vacuity.test.ts) —
// MIN_FILES rises from 265 to 266. MIN_TESTS rises from 3166 to 3184: +16 test cases in that new
// file (verified with `pnpm exec vitest run scripts/__tests__/lint-guard-vacuity.test.ts`, "16
// tests" in its own output) PLUS +2 test cases in the EXISTING
// scripts/__tests__/lint-guard-vacuity-detect.test.ts (20 -> 22, verified with `pnpm exec vitest
// run scripts/__tests__/lint-guard-vacuity-detect.test.ts`, "22 tests" in its own output, up from
// plan 235-01's 20) — the two fixtures this plan added to pin the classifier gaps it found while
// baseline-verifying against the real tree (`guarded-contains-assert.ts`,
// `chained-call-on-walk-containing-fn.ts`). 3166 + 16 + 2 = 3184, matching a fresh full-suite run's
// own "Test Files 266 passed (266)" / "Tests 3181 passed | 3 skipped (3184)" totals exactly.
//
// Plan 235-03 (Wave 3, 2026-09-18) — no new test FILE (all five touched files already existed) —
// MIN_FILES stays 266. MIN_TESTS rises from 3184 to 3189: this plan retrofitted Group A's five
// vacuous guards with a non-empty input-set proof each (`context-area-map.test.ts`,
// `lint-guard-vacuity-detect.test.ts`, `lint-tenant-scoping-candidates.test.ts`, `-facade.test.ts`,
// `-verdict.test.ts`) — none of the five edits added a new `it()` block, so none of them
// contributes here directly (each per-file count is unchanged: 17/22/11/16/19 tests, all verified
// individually with `pnpm exec vitest run <file>`). The +5 comes entirely from
// `scripts/__tests__/lint-guard-vacuity.test.ts`'s OWN generated whole-set red proof
// (`describe.each(provedGuards())`, plan 235-02): it reads the REAL tree, so it grows by exactly
// one generated test case per guard this plan flips from vacuous to proved — 4 proved guards
// before this plan, 9 after (verified with `pnpm exec vitest run
// scripts/__tests__/lint-guard-vacuity.test.ts` at three points: 16 tests on the pre-plan HEAD
// `6697cedc`, 17 after this plan's context-area-map.test.ts fix alone, 21 after all five fixes —
// a clean +5, matching this bump exactly). 3184 + 5 = 3189, matching a fresh full-suite run's own
// "Test Files 266 passed (266)" / "Tests 3186 passed | 3 skipped (3189)" totals exactly.
// Plan 235-06 (Wave 3, 2026-09-18) — no new test FILE, and all four touched files live under
// apps/web/src/__tests__, OUTSIDE this apps/api suite entirely — MIN_FILES stays 266. MIN_TESTS
// rises from 3189 to 3193: this plan retrofitted Group D's four vacuous guards
// (`layout-boundaries.test.ts`, `admin-unsaved-registry.test.ts`,
// `admin-vacation-save-wiring.test.ts`, `admin-availability-detail-save-wiring.test.ts`, all
// apps/web files, none counted by THIS floor) with a non-empty input-set proof each — the +4 comes
// entirely, again, from `scripts/__tests__/lint-guard-vacuity.test.ts`'s own generated whole-set
// red proof (`describe.each(provedGuards())`, plan 235-02): it reads the REAL tree repo-wide, not
// only apps/api, so proving four apps/web guards non-vacuous still grows this apps/api test file's
// own case count by exactly one generated case per guard flipped from vacuous to proved — 21 tests
// in that file on the pre-plan HEAD `03897c1c` (verified: `pnpm exec vitest run
// scripts/__tests__/lint-guard-vacuity.test.ts` reports "21 tests" with this plan's four edits
// stashed out), 25 after (same command, same file, edits restored) — a clean +4, matching this
// bump exactly. 3189 + 4 = 3193, matching a fresh full-suite run's own "Test Files 266 passed
// (266)" / "Tests 3190 passed | 3 skipped (3193)" totals exactly.
// Plan 235-04 (Wave 4, 2026-09-18) — no new test FILE (all five touched apps/api files already
// existed: `absence-vocabulary-guard.test.ts`, `leave-type-identity-guard.test.ts`,
// `notification-email-policy.test.ts`, `section9-carryover-deadline.test.ts`,
// `release-notes.test.ts`) — MIN_FILES stays 266. Each of the five gained a non-empty input-set
// proof, but none of the five edits added a new `it()`/`it.each()` block (verified: `grep -c`
// against each file's pre-plan HEAD `b7e65ecb` copy — identical it()-declaration counts before and
// after, for all five). MIN_TESTS rises from 3193 to 3197: the +4 comes entirely, again, from
// `scripts/__tests__/lint-guard-vacuity.test.ts`'s own generated whole-set red proof
// (`describe.each(provedGuards())`, plan 235-02) — four of this plan's five guards flip from
// vacuous to proved (`leave-type-identity-guard.test.ts`, `section9-carryover-deadline.test.ts`,
// `notification-email-policy.test.ts`, `release-notes.test.ts`; `absence-vocabulary-guard.test.ts`
// was ALREADY proved before this plan and contributes no new generated case). This plan ALSO
// generalised that red proof itself (`deleteEveryProofUntilVacuous`, same file): retrofitting
// `absence-vocabulary-guard.test.ts` gave it TWO independent, structurally unrelated proofs in the
// same file (G5's pre-existing "contains" and this plan's new G6 "length"), and the classifier's
// per-file, single-winning-shape report meant the old single-shot-deletion version of this red
// proof could delete the reported winner and still find the OTHER proof standing — correctly
// proved, incorrectly read as a broken red proof. The generalisation does not add a test CASE, only
// changes what one existing generated case does, so it is not part of this +4. Measured at three
// points, `pnpm exec vitest run scripts/__tests__/lint-guard-vacuity.test.ts`: 25 tests on the true
// pre-plan HEAD `b7e65ecb` (all three plan-04-touched files AND the harness reverted to that
// commit's content), 27 tests (1 failing — the absence-vocabulary-guard.test.ts multi-proof case
// above) after this plan's Task 2 alone (committed, harness not yet generalised), 29 tests all
// passing after Task 3 plus the harness generalisation — a clean +4 end to end, matching this bump
// exactly. 3193 + 4 = 3197, matching a fresh full-suite run's own "Test Files 266 passed (266)" /
// "Tests 3194 passed | 3 skipped (3197)" totals exactly.
// Plan 235-07 (Wave 4, 2026-09-18) — no new apps/api test FILE: `apps/web/scripts/lint-ui.mjs`,
// `lint-ui-classes.mjs`, `lint-save-pattern.mjs` and root `scripts/lint-comment-language.mjs` are
// all `.mjs` tools, not `.test.ts` files, and the NEW test cases this plan added
// (`scripts/__tests__/lint-comment-language.test.mjs`, +4 cases) live at repo ROOT, run via
// `pnpm test:scripts`, entirely outside this apps/api vitest instance (same reasoning as Plan
// 235-06's note re: `apps/web/src/__tests__`) — MIN_FILES stays 266. `235-BASELINE.md`'s own
// "Zusammenfassung für Pläne 03-09" table names Group E as 2 vacuous guards
// (`apps/web/scripts/lint-save-pattern.mjs`, `scripts/lint-comment-language.mjs`), not 4 — the
// other two `.mjs` tools this plan also fixed are NOT classified as guards at all by
// `lint-guard-vacuity`'s own AST classifier (a real, separately-documented blind spot: their
// `execSync(\`find '${scope}' ...\`)` calls use a template literal WITH substitutions, which
// `ts.isStringLiteralLike` does not recognise — see `235-BEFUND-E.md` Finding 0), so fixing them
// moves no `--check` number and adds no generated case here.
// **Finding, per this phase's own standing rule (equality targets come from the baseline, not
// plan prose):** `235-07-PLAN.md`'s own `<verification>` section states "the generated whole-set
// red proof grew by exactly four" — that number is copy-paste residue from Plan 235-04's SUMMARY
// (which DID grow by 4) and disagrees with `235-BASELINE.md`'s Group E count of 2. The baseline
// wins: measured directly, `pnpm --filter @clokr/api exec vitest run
// scripts/__tests__/lint-guard-vacuity.test.ts` reports 29 tests on this plan's own starting HEAD
// `6d74bbe1`, 31 after (Task 2 flips `lint-save-pattern.mjs`, Task 3 flips
// `scripts/lint-comment-language.mjs`) — a clean **+2**, matching Group E's baseline count exactly,
// not +4. MIN_TESTS rises from 3197 to 3199. 3197 + 2 = 3199, matching a fresh full-suite run's
// own "Test Files 266 passed (266)" totals exactly (see this plan's own SUMMARY for the verbatim
// "Tests N passed | 3 skipped (3199)" line).
// Plan 235-05 (Wave 5, 2026-09-18) — no new test FILE: this plan retrofitted an empty-abort into
// four Group-C scanning gates (`check-import-targets.ts`, `context-area-map.ts`,
// `lint-facade-signatures.ts`, `lint-tenant-scoping-candidates.ts`, the latter also wiring a new
// error class through `lint-tenant-scoping.ts`), and adjusted two PRE-EXISTING pinning tests in
// `scripts/__tests__/lint-guard-vacuity-detect.test.ts` (their expected `inputProof` for
// `check-import-targets.ts` flips from "none" to "empty-abort", reflecting the fix — no new
// `it()` block, an existing one's assertion value changed). MIN_FILES stays 266. The whole delta
// traces, as in every prior wave, to `lint-guard-vacuity.test.ts`'s own generated whole-set red
// proof (`describe.each(provedGuards())`), which reads the real tree and grows by one case per
// guard flipped vacuous -> proved: measured directly, `pnpm --filter @clokr/api exec vitest run
// scripts/__tests__/lint-guard-vacuity.test.ts` reports 31 tests at this plan's own starting HEAD
// `8c5c4adf`, 35 after Task 2 (four guards flip: check-import-targets.ts, context-area-map.ts,
// lint-facade-signatures.ts, lint-tenant-scoping-candidates.ts) — a clean **+4**, matching
// `235-BASELINE.md`'s Group C count of 8 vacuous exactly HALVED by this plan (the other 4 —
// lint-saldo-lock-derivation.ts, measure-context-boundary-imports.ts,
// measure-foreign-context-access.ts, release-notes.ts — are Plan 08's). MIN_TESTS rises from 3199
// to 3203. 3199 + 4 = 3203, matching a fresh full-suite run's own "Test Files 266 passed (266)" /
// "Tests 3200 passed | 3 skipped (3203)" totals exactly.
// Plan 235-08 (Wave 6, 2026-09-18) — closes Group C's second half (the two standing boundary
// gates + A2/A3): no new test FILE (`measure-context-boundary-imports.test.ts`,
// `measure-foreign-context-access.test.ts` and `lint-guard-vacuity.test.ts` all already existed).
// MIN_FILES stays 266. MIN_TESTS rises from 3203 to 3217, derived per-file, each measured
// directly with `pnpm --filter @clokr/api exec vitest run <file>`:
//   - measure-foreign-context-access.test.ts: 30 -> 34 tests (+4) — 3 new cases pinning
//     discoverScannedFiles()/emptyScanAbortMessage() plus 1 new case pinning summaryLine's
//     scanned-count prefix (a 4th case from Task 1's first draft was folded into the
//     emptyScanAbortMessage naming-assertion case during Task 2's signature simplification).
//   - measure-context-boundary-imports.test.ts: 60 -> 64 tests (+4) — same shape: 3 cases for
//     discoverProductionFiles()/emptyScanAbortMessage(), 1 for summaryLine's scanned-count prefix.
//   - lint-guard-vacuity.test.ts: +6 total, two sources. (1) Its OWN generated whole-set red proof
//     (`describe.each(provedGuards())`, plan 235-02) reads the REAL tree and grows by one case per
//     guard whose `inputProof` flips from "none" to a proved shape: 35 tests at this plan's own
//     post-Task-1 HEAD `6aae86e7` (measured before Task 2's classifier-visibility fixes), 38 after
//     Task 2 — +3, matching the three files whose OWN input-proof flipped
//     (lint-saldo-lock-derivation.ts, measure-context-boundary-imports.ts,
//     measure-foreign-context-access.ts; release-notes.ts/A3 does NOT add a case here — its
//     verdict moves vacuous -> excepted via the exceptions register, but its own `inputProof`
//     classification stays "none", so the generated proof never sees it). (2) A Rule-1/3 bug fix
//     to `lint-guard-vacuity.ts` itself, found while verifying Task 3's own `--scope
//     apps/api/scripts --check <n>` acceptance criterion: `validateExceptionsDocument` validated
//     EVERY exception entry against the CURRENT --scope's own (necessarily narrower) `allFiles`,
//     so A3's release-notes.ts entry (apps/api/src/utils) made `--scope apps/api/scripts` fail
//     outright the moment the register stopped being empty — a scope that structurally can never
//     contain a file from a different root. Fixed by threading an optional `scope` parameter
//     through and skipping (not erroring on) an out-of-scope entry entirely; the file itself was
//     outside this plan's `files_modified`, but the fix is required for Task 3's own acceptance
//     criteria to pass at all, and is a blocking-bug fix per this project's deviation rules, not
//     an architectural change. 3 new hand-written cases pin it directly against
//     `validateExceptionsDocument`: 38 -> 41 tests (+3, on top of the +3 above).
// 4 + 4 + 6 = 14. 3203 + 14 = 3217, matching a fresh full-suite run's own "Test Files 266 passed
// (266)" / "Tests 3214 passed | 3 skipped (3217)" totals exactly (measured at this plan's own
// first finishing point, `pnpm --filter @clokr/api exec vitest run`).
//
// Plan 235-08, continued (coordinator-flagged: the owner-approved classifier blind-spot fix from
// the plan's own `<additional_scope_owner_approved>` block had not yet been applied) — no new
// test FILE (`lint-guard-vacuity-detect.test.ts` already existed; the new fixture
// `execsync-find-template-literal-walk.mjs` is a FIXTURE, not a test file, and is not itself
// collected by vitest). MIN_FILES stays 266. MIN_TESTS rises from 3217 to 3220 (+3), derived
// per-file, each measured directly:
//   - `lint-guard-vacuity-detect.ts`'s `isCpCommandWalk` taught to recognise a
//     `ts.TemplateExpression` (a template literal WITH substitutions) whose HEAD text matches
//     `CP_COMMAND_RE` — `235-BEFUND-E.md` "Finding 0": `ts.isStringLiteralLike` accepts a
//     `NoSubstitutionTemplateLiteral` but not a `TemplateExpression`, so
//     `` execSync(`find '${scope}' ...`) `` (both `apps/web/scripts/lint-ui.mjs` and
//     `lint-ui-classes.mjs`'s real shape) was architecturally invisible. Closing only that gap was
//     NOT enough on its own: both real files' `.length === 0` empty-abort still stayed classifier-
//     invisible, because the `.toString()` link in
//     `execSync(...).toString().split(...).filter(...).map(...)` broke `isWalkDerivedExpr`'s
//     chain-derivation one step before reaching the now-recognised walk call — `CHAIN_METHODS`
//     gained `"toString"` to close that second, immediately-adjacent gap.
//   - `lint-guard-vacuity-detect.test.ts`: +1 new fixture-matrix row
//     (`execsync-find-template-literal-walk.mjs`, modelled on the EXACT shape of the two real
//     files, per this phase's own precedent of pinning against a real form, never a hypothetical
//     example — same discipline Plan 02 used for its own two detection-gap fixtures): 22 -> 23
//     tests.
//   - `lint-guard-vacuity.test.ts`: no file edit — its own generated whole-set red proof
//     (`describe.each(provedGuards())`) grows by one case per NEWLY-detected real guard: both
//     `lint-ui.mjs` and `lint-ui-classes.mjs` flip `walks:false` -> `walks:true,
//     inputProof:"empty-abort"` the instant the classifier can see them (both already carried a
//     correct, plan-235-07-hardened empty-abort — this was purely a classifier-visibility gap, not
//     a source defect): 41 -> 43 tests (+2).
// 1 + 2 = 3. 3217 + 3 = 3220, matching a fresh full-suite run's own "Test Files 266 passed (266)"
// / "Tests 3217 passed | 3 skipped (3220)" totals exactly. Repo-wide `lint-guard-vacuity.ts`
// (no --scope): guard count rises 27 -> 29 (both newly-visible guards), vacuous stays at 0.
//
// WR-01 (235-REVIEW.md, review dated 2026-09-18): `lint-guard-vacuity-detect.ts`'s
// `registerNamedImport` closed a default-import blind spot (`import fs from "node:fs"`, no
// `namedBindings` at all, so the old early-return never even registered the binding). No LIVE
// guard in the tree uses this shape (confirmed: repo-wide `lint-guard-vacuity.ts` unchanged at
// `577 file(s) scanned, 29 guard(s), 0 vacuous, 1 excepted`) — a latent, future-facing gap, not a
// live vacuous guard.
//   - `lint-guard-vacuity-detect.test.ts`: +1 new fixture-matrix row (`default-import-walk.ts`,
//     modelled on the review's own owner-approved reproduction transcript verbatim): 23 -> 24
//     tests.
// 3220 + 1 = 3221, matching a fresh full-suite run's own totals exactly. MIN_FILES unchanged at
// 266 (no new test FILE — the new file is fixture data, parsed, never collected as a test file).
//
// WR-02 (235-REVIEW.md, review dated 2026-09-18): `lint-guard-vacuity-detect.ts`'s
// `isCpCommandWalk` now also recognises `spawnSync`'s two-argument, shell-injection-safe calling
// form (`spawnSync("find", [scope, "-type", "f"])`, command and args passed SEPARATELY, unlike
// `execSync`'s single-string form) — plus an adjacent gap found while pinning it: `spawnSync`'s
// return value is a RESULT OBJECT, not the output directly, so its `.stdout`/`.stderr` property
// access needed its own case in `isWalkDerivedExpr` too, or the call-site fix alone would leave
// every idiomatic `spawnSync` guard permanently unable to prove its own non-emptiness. No LIVE
// guard in the tree uses `spawnSync` at all (confirmed: repo-wide `lint-guard-vacuity.ts`
// unchanged at `577 file(s) scanned, 29 guard(s), 0 vacuous, 1 excepted`) — a latent,
// future-facing gap, not a live vacuous guard.
//   - `lint-guard-vacuity-detect.test.ts`: +1 new fixture-matrix row
//     (`spawnsync-find-args-array-walk.mjs`, modelled on the review's own owner-approved
//     reproduction transcript verbatim, including its `.stdout` access): 24 -> 25 tests.
// 3221 + 1 = 3222, matching a fresh full-suite run's own totals exactly. MIN_FILES unchanged at
// 266 (no new test FILE — the new file is fixture data, parsed, never collected as a test file).
//
// Phase 275 Plan 04 (Issue #275, D-07): new test FILE
// `scripts/__tests__/lint-e2e-spec-registry-validate.test.ts` (table-driven, DB-free coverage of
// the new `lint-e2e-spec-registry` gate's pure module) adds 22 tests: MIN_FILES 266 -> 267 would
// be this plan's own delta alone, but a fresh full-suite run measured immediately before this edit
// (`pnpm --filter @clokr/api test`) reports `Test Files 271 passed (271)` / `Tests 3289 passed | 3
// skipped (3292)` — 4 more files and 48 more tests than 266/3222 already accounted for by other,
// already-merged work between the WR-02 entry above and this one that never bumped this floor
// (pre-existing drift, out of this plan's scope per CLAUDE.md's scope-boundary rule — nothing
// investigated or attributed here beyond this plan's own +1 file/+22 tests). Raising straight to
// the MEASURED current reality (271/3292), not merely 266+1/3222+22, because a floor left looser
// than reality is exactly the silent-headroom risk D-09 exists to close: a future run could lose
// several files before this check would even notice.
// Phase 259 Plan 01 (Issue #259, T-100-09): no new test FILE — sec-08-avatars-post-tenant.test.ts
// already existed and was rewritten in place — MIN_FILES stays 271. MIN_TESTS rises from 3292 to
// 3294: the rewrite replaced 3 cases with 5 (two byte-identical-404 cases plus one audit case,
// replacing the single stale 403 assertion; two pre-existing no-regression cases kept as-is),
// verified with `pnpm --filter @clokr/api exec vitest run src/__tests__/sec-08-avatars-post-tenant.test.ts`
// ("5 tests" in its own output, up from 3) — 3292 + 2 = 3294. No other test file changed in this
// plan. A fresh full-suite run measured immediately before this edit (`pnpm --filter @clokr/api
// test`) reports `Test Files 275 passed (275)` / `Tests 3349 passed | 3 skipped (3352)` — 4 more
// files and 58 more tests than 271/3294 already accounted for by other, already-merged work
// between the Phase 275 Plan 04 entry above and this one that never bumped this floor
// (pre-existing drift, out of this plan's scope per CLAUDE.md's scope-boundary rule and Issue
// #259's own D-06 — nothing investigated or attributed here beyond this plan's own +2 tests).
// Deliberately NOT raised straight to the measured 275/3352 here, unlike the Phase 275 Plan 04
// entry above: that plan's own scope was this exact floor (D-09), so absorbing drift into it was
// in-scope work; this plan's scope is a tenant-isolation fix in `avatars.ts`, and moving this
// floor beyond its own measured contribution would be fixing an unrelated finding on sight.
// Phase 259 Plan 03 (Issue #259, T-100-09, D-03c/D-07) — raised to the MEASURED full-suite
// reality this time, not this plan's own delta alone (explicit instruction for this plan,
// departing from the Phase 259 Plan 01 entry above's "own contribution only" default — see that
// entry's own reasoning for when absorbing drift is in scope vs. not).
//
// Two new test FILES landed since the 271/3294 floor above: Plan 259-02's
// `scripts/__tests__/lint-t100-09-routes-validate.test.ts` (43 tests, verified with `pnpm exec
// vitest run scripts/__tests__/lint-t100-09-routes-validate.test.ts`, "43 tests" in its own
// output) and this plan's own `src/__tests__/t100-09-oracle-probe.test.ts` (5 tests, same
// verification). Those two plans' own direct contribution is therefore 271 + 2 = 273 files,
// 3294 + 43 + 5 = 3342 tests — but a fresh full-suite run measured immediately before this edit
// (`pnpm --filter @clokr/api test`) reports `Test Files 277 passed (277)` / `Tests 3399 passed |
// 3 skipped (3402)`, cross-checked against `apps/api/vitest-report.json`'s own
// `testResults.length` (277) / `numTotalTests` (3402) directly. The remaining 4 files / 60 tests
// beyond 273/3342 are pre-existing drift from other already-merged work between the Phase 259
// Plan 01 entry above and this one, the same kind of gap that entry's own comment named and
// deliberately left unabsorbed — absorbed HERE instead, on explicit instruction, so the floor
// reflects what the suite actually collects rather than continuing to understate it.
// Phase 307 Plan 02 (Issue #307, D-09 successor) — three new test FILES landed across the
// phase's two plans: Plan 01's `services/clock/__tests__/interactive-debounce.integration.test.ts`
// (8 tests) and `services/clock/__tests__/thresholds.test.ts` (3 tests), plus this plan's own
// `contexts/time-tracking/__tests__/clock-out-debounce-message.test.ts` (3 tests) — 277 + 3 = 280
// files, 3402 + 8 + 3 + 3 = 3416 tests. A fresh full-suite run measured immediately before this
// edit (`pnpm --filter @clokr/api test`) reports `Test Files 280 passed (280)` / `Tests 3413
// passed | 3 skipped (3416)`, cross-checked against `apps/api/vitest-report.json`'s own
// `testResults.length` (280) / `numTotalTests` (3416) directly — an exact match with this plan's
// own accounting, so no unrelated drift needed absorbing this time.
// Issue #206 (`LeaveType.code` set to `NOT NULL`) — floor LOWERED, on a green run, not stretched
// to keep a red one passing (this is a removal of test cases whose constructed state the
// database now refuses, per Task 1's own SQLSTATE 23502 proof, not a relaxation to dodge a
// failure). One test FILE removed entirely:
// `apps/api/scripts/__tests__/backfill-leave-type-code.test.ts` (12 cases) — its subject,
// `scripts/backfill-leave-type-code.ts`, was removed with it: the script's only selection,
// `code IS NULL`, can never again match a row after migration
// `20260923090815_leave_type_code_not_null`, so none of its 12 cases (each first constructing a
// codeless row) could be repaired, only deleted. Net test-case changes within still-existing
// files (no FILE count change): `leave.test.ts` lost 3 cases whose subject was the same
// now-impossible state and had no reverse to rewrite toward (two `ensureLeaveType()` self-heal
// cases, one multi-row-ordering case — `@@unique([tenantId, code])` already forbade two rows
// sharing one real code, so no candidate-set could ever be rebuilt with real codes either);
// `leave-correct.test.ts` lost 1 case for the same reason (its guard, `leave.ts`'s
// `!oldTypeCode` check, was removed as unreachable in the same commit); `leave-entitlement-self-heal.test.ts`
// lost 1 case (Phase 97 D-12's "Test 4") plus its now-orphaned fixture. Every OTHER case this
// issue touched was rewritten in place with a real, deliberately wrong-scope code (mostly
// `"OTHER"`) instead of deleted — no further count change from those. A fresh, fully GREEN
// full-suite run (`pnpm --filter @clokr/api test`, zero failed suites — the prior run with the
// still-present backfill script failed one suite and is NOT the basis for this floor, per this
// issue's own instruction to measure only from green) reports `Test Files 279 passed (279)` /
// `Tests 3398 passed | 3 skipped (3401)`, cross-checked against `vitest-report.json`'s own
// `testResults.length` (279) / `numTotalTests` (3401) directly. 280 - 1 = 279 files matches
// exactly. The test-count arithmetic above (-17, verified by counting `it(` additions/removals
// per file with `git diff c5f4fd26..3a6cdcc2`, not estimated) does NOT reconcile against the
// inherited 3416 floor by itself: 3416 - 17 = 3399, two short of the measured 3401. Traced, not
// shrugged off: `c5f4fd26` — this issue's own starting base commit, already on `main` before this
// issue began, from an unrelated ticket (#309/#310) — added 2 new `it()` cases to
// `src/__tests__/t100-09-oracle-probe.test.ts` without bumping this floor (`git diff
// f418c7a2..c5f4fd26 -- apps/api/src/__tests__/t100-09-oracle-probe.test.ts` shows exactly two
// added `it(` lines, zero removed; `f418c7a2` is the commit that set 3416, and
// `f418c7a2..c5f4fd26` contains no other commit). The floor this issue inherited was therefore
// already stale by +2 before this issue touched anything: the TRUE baseline at `c5f4fd26` was
// 3418, not 3416. 3418 - 17 = 3401 — matches the measured green run exactly, with nothing left
// unexplained. This is a pre-existing floor-drift gap from `c5f4fd26`/#309/#310, out of THIS
// issue's scope to correct retroactively (CLAUDE.md's scope-boundary rule — only fix what the
// current task's own changes caused), named here rather than silently absorbed or waved off as
// rounding.
//
// Orchestrator correction, same run: 3401 was still 10 BELOW reality, and the reason is the
// generalisable one. That number came from a green run taken BEFORE this branch merged
// `origin/main`; the merge brought in #263 (19a24505), whose diff adds only TWO `it()`
// declarations — but one of them sits inside `describe.each(BOUNDARY_MATRIX)` over a nine-row
// table, so it expands to nine runtime cases, ten with the completeness case beside it.
//
// That is the systematic reason floor accounting keeps falling behind, and it is worth stating
// plainly: COUNTING `it(` IN A DIFF UNDERCOUNTS TABLE-DRIVEN TESTS. A floor is a statement about
// RUNTIME cases, so it may only ever be set from the reporter's own `numTotalTests` on a fully
// green run of the tree that is actually being merged — never from a hand-summed diff, and never
// from a run predating a later merge into the same branch.
//
// Independently re-measured in the main checkout after merging this branch onto `origin/main`
// (`pnpm --filter @clokr/api test`): `Test Files 279 passed (279)`, `Tests 3408 passed |
// 3 skipped (3411)`, zero failures — `vitest-report.json` agrees (`testResults.length` 279,
// `numTotalTests` 3411). Both stale steps above (c5f4fd26's +2 and #263's +10) are absorbed by
// taking that measurement as the floor, so the floor no longer trails the suite.
//
// Phase 69b Plan 01 (Issue #69): the full suite on `bea6b5c7` (this branch's base, before any
// change) reported `testResults.length` 280 and `numTotalTests` 3414 — main had already grown
// by one file and three tests past the floor above (#324). This plan adds one file
// (`day-lookup-characterization.test.ts`, 23 tests in its own output) and seven cases to
// `resolver-reopen.integration.test.ts` (13 tests in its own output, was 6): 280 + 1 = 281,
// 3414 + 23 + 7 = 3444.
//
// Phase 69b Plan 02: adds `time-entry-day-lookup-guard.test.ts` (6 tests in its own output):
// 281 + 1 = 282, 3444 + 6 = 3450.
//
// Phase 72b (#72): re-measured from a fully green run of the branch tree at eb76f631
// (`pnpm --filter @clokr/api test`): `Test Files 282 passed (282)`, `Tests 3426 passed |
// 3 skipped (3429)` — `vitest-report.json` agrees (`testResults.length` 282, `numTotalTests`
// 3429). The phase adds permission-catalog.test.ts and permission-site-mapping.test.ts; the floor
// is taken from the reporter, not from a hand count of the diff (see above).
// Accounting: previous floor 279 / 3411. The two new files carry 6 and 8 cases (each read from
// its own `assertionResults.length` in that report), so the phase's own contribution is
// 281 / 3425. The remaining +1 file / +4 tests are drift from already-merged work absorbed by
// measurement, per the "Orchestrator correction" rule above: the branch base `bea6b5c7` (#324)
// added `src/__tests__/leave-overtime-comp-atomicity.test.ts` (3 cases) without raising the
// floor; the fourth runtime case is not visible to `it(` counting over `7ca61ee1..bea6b5c7` (the
// other two test files that commit touched keep 8 and 7 cases) and is taken from the reporter,
// not guessed. A later merge of `origin/main` into this branch requires re-measuring on the
// merged tree before merge — never adding two hand numbers.
//
// Phase 72b, after merging `origin/main` @ a03b4e3a (#326, phase 69b) into the branch: both sides
// had set 282 independently from different bases, so the floor was re-measured on the MERGED tree
// (`pnpm --filter @clokr/api test`): `Test Files 284 passed (284)`, `Tests 3463 passed |
// 3 skipped (3466)`, zero failures. That is 69b's hand-summed 3450 + this phase's 14 = 3464,
// plus 2 runtime cases the 69b sum did not see — taken from the reporter, not added by hand.
//
// Phase 77b (Issue #77): the branch base 28009b3f measured 282 / 3451 (fully green run before any
// change). The phase adds four test files — `src/__tests__/access-context-missing.test.ts` (5),
// `src/contexts/platform/__tests__/access-context.test.ts` (21),
// `src/contexts/platform/__tests__/employee-scope.test.ts` (15) and
// `src/__tests__/route-employee-scope-literals.test.ts` (4) — plus ONE runtime case the diff does
// not show: the new walker guard becomes a row of `lint-guard-vacuity.test.ts`'s
// `describe.each(provedGuards())` whole-set red proof (the table-driven undercount named above).
// Re-measured after merging `origin/main` @ b82e2179 (#328, phase 72b, floor 284 / 3466) into the
// branch, on the MERGED tree (`pnpm --filter @clokr/api test:coverage`): `Test Files 288 passed
// (288)`, `Tests 3509 passed | 3 skipped (3512)`, zero failures — `vitest-report.json` agrees
// (`testResults.length` 288, `numTotalTests` 3512). 284 + 4 = 288 and 3466 + 45 + 1 = 3512
// reconcile exactly, but the numbers below are read from the reporter, not summed from a diff.
//
// Phase 73b (Issue #73): re-measured on the branch tree AFTER merging `origin/main` @ 966921fe
// (#329 phase 77b, #331, #334) into `feat/73-rollen` (`pnpm --filter @clokr/api test`):
// `Test Files 291 passed (291)`, `Tests 3563 passed | 3 skipped (3566)`, zero failures —
// `vitest-report.json` agrees (`testResults.length` 291, `numTotalTests` 3566). Previous floor
// 288 / 3512. The phase adds `src/contexts/platform/__tests__/roles.test.ts` (28 cases) and
// `src/contexts/platform/__tests__/access-role.test.ts` (18 cases), each read from its own
// `assertionResults.length`, plus one integrity case in `t100-09-oracle-probe.test.ts`
// (288 + 2 = 290 files, 3512 + 47 = 3559 tests). The remaining +1 file / +7 tests are drift from
// the merged `origin/main` commits (#331, #334), absorbed by measurement, not added by hand. A
// later merge of phase 64b requires re-measuring on the merged tree again.
//
// Phase 64b (Issue #64), 2026-09-24: re-measured on the MERGED tree after merging `origin/main` @
// 6e36ac57 (#335, phase 73b) into `feat/64-salon` (`pnpm --filter @clokr/api test`): `Test Files
// 295 passed (295)`, `Tests 3608 passed | 3 skipped (3611)`, zero failures — `vitest-report.json`
// agrees. Phase 64b's own contribution is four new files (`salons.test.ts`,
// `salon-migration.test.ts`, `settings-store-hours-salon-mirror.test.ts`,
// `store-hours-readers.test.ts`) plus cases in `t100-09-oracle-probe.test.ts`,
// `test-bootstrap.test.ts` and `lint-facade-signatures.test.ts`; 291 + 4 = 295. Numbers read from
// the reporter, not summed from a diff.
//
// Phase 74b (Issue #74), 2026-09-24: re-measured on the branch tree `feat/74-rollenzuweisung`
// (branched from `main` @ c3777eb0, phase 64b merged) BEFORE merging the parallel phases 67b and
// 325 (`pnpm --filter @clokr/api test`): `Test Files 299 passed (299)`, `Tests 3705 passed | 3
// skipped (3708)`, zero failures — `vitest-report.json` agrees (`testResults.length` 299,
// `numTotalTests` 3708). Phase 74b's own contribution is four new files (`role-assignment.test.ts`,
// `role-assignments.test.ts`, `role-assignment-lockout.test.ts`,
// `role-assignment-employee-lockout.test.ts`) plus cases in existing files; 295 + 4 = 299. Numbers
// read from the reporter, not summed from a diff. Merging `origin/main` with 67b / 325 requires
// re-measuring on the merged tree.
//
// Phase 74b code review fixes (plan 74b-05), 2026-09-24: re-measured on the same branch tree, still
// before merging 67b / 325 (`pnpm --filter @clokr/api run test:setup && pnpm --filter @clokr/api
// test`): `Test Files 301 passed (301)`, `Tests 3722 passed | 3 skipped (3725)`, zero failures —
// `vitest-report.json` agrees (`testResults.length` 301, `numTotalTests` 3725). Two new files:
// `src/contexts/platform/__tests__/role-assignment-review-fixes.test.ts` (15 cases, WR-01..WR-06,
// IN-02) and `scripts/__tests__/anonymize-dump.test.ts` (2 cases, WR-05); 299 + 2 = 301 and
// 3708 + 17 = 3725, which the reporter confirms. The merge with 67b / 325 still requires
// re-measuring on the merged tree.
//
// Phase 67b (Issue #67) Plan 05, 2026-09-24: re-measured on `feat/67-salonzuordnung` after Task 2's
// attempted `git merge origin/main` (a genuine no-op — `origin/main` @ c3777eb0 had not moved past
// this branch's own base since dispatch, confirmed via `git merge-base --is-ancestor origin/main
// HEAD`) — this is therefore the phase's OWN accumulated total across plans 01-05, not a merge
// delta: `pnpm --filter @clokr/api test` → `Test Files 301 passed (301)`, `Tests 3709 passed | 3
// skipped (3712)`, zero failures — `vitest-report.json` agrees (`testResults.length` 301,
// `numTotalTests` 3712). Numbers read from the reporter, not summed from a diff.
//
// Merge of `origin/main` @ 2f6765cd (#337 phase 74b, #338) into `feat/67-salonzuordnung` (phase
// 67b), 2026-09-24: re-measured on the MERGED tree (`pnpm --filter @clokr/api run test:setup &&
// pnpm --filter @clokr/api test`): `Test Files 307 passed (307)`, `Tests 3823 passed | 3 skipped
// (3826)`, zero failures — `vitest-report.json` agrees (`testResults.length` 307, `numTotalTests`
// 3826). Both phases branched from c3777eb0 (295 / 3611): 295 + 6 (67b) + 6 (74b) = 307 and
// 3611 + 101 (67b) + 114 (74b) = 3826, which the reporter confirms. Numbers read from the
// reporter, not summed from a diff.
//
// Phase 67b code review fixes (plan 67b-06), 2026-09-24: re-measured on the same merged tree after
// the five review fixes (`pnpm --filter @clokr/api run test:setup && pnpm --filter @clokr/api
// test`): `Test Files 307 passed (307)`, `Tests 3828 passed | 3 skipped (3831)`, zero failures —
// `vitest-report.json` agrees. No new file; five new cases in existing files (CR-01, WR-01, WR-02
// in `salon-deactivation-assignments.test.ts`, IN-02 in `salon-for-day.test.ts`, IN-05 in
// `employee-home-salon.test.ts`); 3826 + 5 = 3831, which the reporter confirms.
//
// Phase 325 (Issue #325), 2026-09-24: re-measured on the MERGED tree after confirming
// `origin/main` @ c3777eb0 (#336, phase 64b) had not moved since the branch was cut
// (`git merge-base --is-ancestor origin/main HEAD` was already true — no merge commit was
// needed; `git fetch origin main` produced no new commits) — `pnpm --filter @clokr/api test`:
// `Test Files 298 passed (298)`, `Tests 3642 passed | 3 skipped (3645)`, zero failures —
// `vitest-report.json` agrees (`testResults.length` 298, `numTotalTests` 3645). Previous floor
// 295 / 3611. Phase 325's own new files: `shift-salon.test.ts`, `shift-store-hours-salon.test.ts`,
// `shift-salon-migration.test.ts` (295 + 3 = 298), plus cases added across the phase in
// `sync-shifts.test.ts`, `sync-appointments.test.ts`, `store-hours-readers.test.ts`,
// `lint-facade-signatures.test.ts` and `lint-tenant-scoping-model-graph.test.ts`. Numbers read
// from the reporter, not summed from a diff.
// Phase 325 merged with Phase 74b (origin/main @ 2f6765cd, #337), 2026-09-24: re-measured on the
// MERGED tree (`pnpm --filter @clokr/api run test:setup && pnpm --filter @clokr/api test`):
// `Test Files 304 passed (304)`, `Tests 3756 passed | 3 skipped (3759)`, zero failures —
// `vitest-report.json` agrees (`testResults.length` 304, `numTotalTests` 3759). 74b's 301 files
// plus Phase 325's three new files = 304. Numbers read from the reporter, not summed from a diff.
//
// Merge of `origin/main` @ 5f77e921 (#339, phase 325) into `feat/67-salonzuordnung` (phase 67b,
// 74b already merged), 2026-09-24: re-measured on the MERGED tree (`pnpm --filter @clokr/api run
// test:setup && pnpm --filter @clokr/api test`): `Test Files 310 passed (310)`, `Tests 3862 passed
// | 3 skipped (3865)`, zero failures — `vitest-report.json` agrees (`testResults.length` 310,
// `numTotalTests` 3865). Common base 2f6765cd (301 / 3725): 307 / 3831 (67b side) plus 325's
// three new files and 34 new cases (304 / 3759 on its side) = 310 / 3865, which the reporter
// confirms. Numbers read from the reporter, not summed from a diff.
//
// Merge of `origin/main` @ 6ebcd133 (#340, phase 67b) into `feat/65-phorest-kopplung` (phase 65b),
// 2026-09-25: re-measured on the MERGED tree (`pnpm --filter @clokr/api run test:setup &&
// pnpm --filter @clokr/api test`): `Test Files 315 passed (315)`, `Tests 3929 passed | 3 skipped
// (3932)`, zero failures — `vitest-report.json` agrees (`testResults.length` 315, `numTotalTests`
// 3932). 65b's own branch (before this merge) measured 309 / 3826; merging in 67b's five new test
// files and its share of new cases brings it to 315 / 3932, which the reporter confirms. Numbers
// read from the reporter, not summed from a diff.
//
// Phase 68b (issue #68), 2026-09-25: re-measured on the FINAL, actually-merged tree
// (`origin/main` @ 7f4b88e8, #351, phase 344-01, on top of #348/#349 phase 65b, merged into
// `feat/68-zeiteintrag-salon` — merge commit `0d59687c`; `git merge-base --is-ancestor
// origin/main HEAD` true afterwards, re-checked once more right before this sweep with no further
// movement): `pnpm --filter @clokr/api run test:setup && pnpm --filter @clokr/api test`:
// `Test Files 321 passed (321)`, `Tests 3987 passed | 3 skipped (3990)`, zero failures —
// `vitest-report.json` agrees (`testResults.length` 321, `numTotalTests` 3990). Previous floor
// 315 / 3932 (65b's own measurement above, itself already merged with 67b). Phase 68b's own new
// files: `time-entry-salon.test.ts`, `time-entry-salon-import.test.ts`,
// `time-entry-salon-put.test.ts`, `time-entry-salon-clock.test.ts`,
// `time-entry-salon-migration.test.ts` (5 files); the rest of the delta (315 -> 321 net, after
// 68b's own 5 new files, is only 1 file — the merge brought in commits 5bab411f/1f623074/7f4b88e8,
// which together add several new test files and cases but the 315/3932 baseline above was itself
// measured AFTER those same 65b commits landed on `feat/65-phorest-kopplung`, so most of that
// content was already counted there) is not reconstructed file-by-file here; the authoritative
// numbers are the reporter's own count on the actually-merged tree, not a summed diff.
//
// Phase 75b (Issue #75) Plan 13, 2026-09-25: re-measured on `feat/75-permissions-umstellung` after
// merging `origin/main` @ 704b1ee5 (#353, phase 68b — the 321 / 3990 floor above) — `pnpm --filter
// @clokr/api test`: `Test Files 331 passed (331)`, `Tests 5880 passed | 3 skipped (5883)`, zero
// failures — `vitest-report.json` agrees (`testResults.length` 331, `numTotalTests` 5883). Phase
// 75b's own baseline before any change was 301 / 3725 (2f6765cd); its branch measured 325 / 5825
// before this merge. The ten test files 75b adds, with their case counts read from the same report:
// `permission-neutrality-matrix.test.ts` 1707 (one case per actor × route, 2250 recorded cells),
// `lint-role-checks.test.ts` 37, `compat-role.test.ts` 33, `request-permissions.test.ts` 26,
// `notification-recipients-neutrality.test.ts` 19, `activity-auth-neutrality.test.ts` 17,
// `employee-role-bridge.test.ts` 15, `system-roles-migration.test.ts` 12, `system-roles.test.ts` 10,
// `user-ids-holding-permission.test.ts` 10 — 321 + 10 = 331 files, 3990 + 1886 = 5876 tests; the
// remaining 7 are new cases in test files that already existed on `origin/main` (75b-12 names four
// of them: the lint-guard-vacuity whole-set row for `lint-role-checks.ts`, two in
// `permission-site-mapping.test.ts`, one in `script-import-safety.test.ts`; the rest of the split is
// not reconstructed here). Numbers read from the reporter, not summed from a diff.
//
// Re-measured 2026-09-25 on `feat/71-feiertage-pro-salon` @ 24b4198f (Phase 71b, issue #71, after
// merging `origin/main` @ 4ce0f1b8, #363) — `pnpm --filter @clokr/api test`: `Test Files 346 passed
// (346)`, `Tests 6016 passed | 3 skipped (6019)`, zero failures. MIN_FILES rises from 331 to 346 and
// MIN_TESTS from 5883 to 6019; the delta mixes Phase 71b's new test files (resolver matrix,
// migration replay, per-salon holiday API, work-location readers, D-05 boundary guard) with the
// test files #361/#362/#363 added on `origin/main`. Numbers read from the reporter, not summed.
//
// Phase 380 (issue #380), 2026-09-29: no new test FILE — MIN_FILES stays 346. MIN_TESTS rises from
// 6019 to 6023: +4 new cases in `src/contexts/time-tracking/api/__tests__/breaks.test.ts` (Cases
// A-D covering the new POST /:id/breaks 400 guard and the confirmed PUT /:id conversion path).
// Measured by counting `it(` occurrences in that file's git blob before and after this plan's Task
// 1 commit (5 -> 9); the two other files this plan touches, `src/__tests__/time-entries.test.ts`
// and `src/__tests__/audit-trail.test.ts`, only had their fixtures corrected (a bare `breakMinutes`
// column replaced with a real `Break` row) — no case added or removed in either (29 -> 29, 22 -> 22,
// same count before/after). Note: on the current merged tree the reporter's actual totals
// (`pnpm --filter @clokr/api test`, `apps/api/vitest-report.json`) are `testResults.length` 371 and
// `numTotalTests` 6389, well above this floor — the drift accrued from other phases landing since
// Phase 71b without re-tightening this floor to the exact total (the check is `<` MIN_*, a lower
// bound, not an equality); this plan's own action is the mechanical +4 documented above, not a
// re-measure-to-actual sweep, which is out of this phase's scope.
//
// Phase 81 (issue #81), 2026-10-12: 7 new test files — `src/__tests__/activity-kind-saldo-equality-81`,
// `activity-kind-saldo-isolation-81`, `time-entries-activity-81`, `time-entries-activity-summary-81`,
// `time-entry-activity-migration-81`, `time-entry-activity-writers-81` and
// `src/contexts/time-tracking/__tests__/activity-81` — MIN_FILES rises from 346 to 353. MIN_TESTS rises
// from 6023 to 6139: +116 cases, measured by counting `it(` / `it.each(` per file in the blob at
// a750044f vs HEAD — new files 5, 5, 31, 11, 8, 13, 42; edited files
// `scripts/__tests__/lint-tenant-scoping-model-graph` 19 -> 20 (+1), `measure-foreign-context-access`
// 34 -> 34, `time-entries-durations-79` 3 -> 3, `time-entries-summary-79` 11 -> 11,
// `facade-time-entries` 19 -> 19 (assertions added to existing cases only). Same lower-bound
// convention as above; not a re-measure-to-actual sweep.
//
// Phase 82 (issue #82), 2026-10-12: 3 new test files — `src/__tests__/me-context-82`,
// `salon-context-manipulation-82` and `src/contexts/platform/__tests__/context-salon-ids-82` —
// MIN_FILES rises from 353 to 356. MIN_TESTS rises from 6139 to 6171: +32 cases, measured by
// counting `it(` / `it.each(` per file — 13, 7, 12; no existing file changed its case count. Same
// lower-bound convention as above; not a re-measure-to-actual sweep.
//
// Phase 83 (issue #83), 2026-10-12: 3 new test files — `src/__tests__/roles-permission-catalog-83`,
// `role-assignments-people-83` and `src/contexts/platform/__tests__/permission-labels` — MIN_FILES
// rises from 356 to 359. MIN_TESTS rises from 6171 to 6185: +14 cases, measured by counting `it(` /
// `it.each(` per file — 4, 5, 5; no existing file changed its case count. Same lower-bound
// convention as above; not a re-measure-to-actual sweep.
//
// Phase 84 (issue #84), 2026-10-12: 7 new test files — `src/composition/__tests__/dashboard-team-week-frozen-84`,
// `reports-monthly-frozen-84`, `dashboard-team-trend-84`, `dashboard-team-salon-filter-84`,
// `src/contexts/absence/__tests__/sick-leave-days`, `src/contexts/platform/__tests__/home-salons-for-days-84`
// and `src/__tests__/dashboard-salon-manipulation-84` — MIN_FILES rises from 359 to 366. MIN_TESTS
// rises from 6185 to 6254: +69 cases, measured by counting `it(` / `it.each(` per file in the blob at
// a0258a8d vs HEAD — new files 1, 1, 16, 14, 16, 10, 9 (the probe file's cases loop over the three
// endpoints, so the reporter counts more than the source does); existing files
// `src/contexts/absence/__tests__/facade-leave-requests` 19 -> 21 (+2),
// `src/contexts/time-tracking/__tests__/facade-time-entries` 19 -> 19 and
// `scripts/__tests__/lint-facade-signatures` 21 -> 21 (assertions changed in existing cases only).
// Same lower-bound convention as above; not a re-measure-to-actual sweep.
// Phase 87b (issue #87), 2026-10-13: 3 new test files — `src/contexts/platform/__tests__/assignment-salon-ids-87`,
// `src/__tests__/clock-in-salon-87` and `src/__tests__/clock-salon-choice-87` — MIN_FILES rises by 3. MIN_TESTS rises by +40 cases, measured by counting `it(` / `it.each(`
// per file — 8, 14, 18; the edited files `time-entry-salon-clock` (12 -> 12, one case rewritten 1:1)
// and `time-entry-day-lookup-guard` (6 -> 6) kept their case count. Same lower-bound convention as
// above; not a re-measure-to-actual sweep.
// Merged after Phase 84 (2026-10-13): Phase 84's 366/6254 plus Phase 87b's +3 files / +40 cases.
//
// Phase 85b (issues #85 and #547), 2026-10-13, merged with origin/main @ c8c3154c (#550): 11 new
// test files - ten of Phase 85b (`src/__tests__/whole-tenant-frozen-85`, `employees-list-scope-85`,
// `time-entries-salon-view-85`, `write-warnings-scope-85`, `cross-salon-springer-85`,
// `src/composition/__tests__/team-entry-scope`, `dashboard-entry-scope-85`,
// `src/contexts/platform/__tests__/resolve-salon-in-reach-85` and
// `src/contexts/time-tracking/__tests__/withheld-finding-85`, `warning-visibility-85`) and one that
// arrived with main (#550, `src/__tests__/create-test-salon-created-at-543`) - MIN_FILES rises from
// 369 to 380. MIN_TESTS rises from 6294 to 6431: +137 cases, measured by counting `it(` /
// `it.each(` per file in the blob at the phase base 4e7b1311 vs HEAD - Phase 85b new files 5, 11,
// 16, 11, 31, 11, 16, 6, 3, 6 (= 116); #550 new file 12; edited files
// `src/contexts/time-tracking/__tests__/facade-time-entries` 19 -> 25 (+6, the by-id read),
// `cross-salon-break-notifications-80` 25 -> 26 (+1), `break-finding-notice` 11 -> 12 (+1) and
// `src/contexts/time-tracking/api/__tests__/day-break-checks` 31 -> 32 (+1); the edited files
// `lint-facade-signatures`, `dashboard-salon-manipulation-84`, `placement-warnings-511`,
// `time-entry-salon`, `holiday-resolution` and `salon-couplings` kept their source case count
// (assertions changed or cases rewritten 1:1). Same lower-bound convention as above (a case that
// loops over data counts once in the source and more in the reporter); not a re-measure-to-actual
// sweep. The full-suite actuals are measured in plan 85b-14.
// Issue #548 (2026-10-13): one new test FILE, `src/composition/__tests__/dashboard-shift-scope-548.test.ts`
// (8 cases) — MIN_FILES rises from 380 to 381 and MIN_TESTS from 6431 to 6439. The edited file
// `dashboard-entry-scope-85.test.ts` changed only in its header docblock (case count unchanged).
// Same lower-bound convention as above; not a re-measure-to-actual sweep.
// Phase 88 (issue #88), 2026-10-13, on `feat/88-superadmin` (contains origin/main @ 761d8c41): 15 new
// test files - `scripts/__tests__/lint-tenant-scoping-nullish-tenant`, `scripts/__tests__/operator-account`,
// `src/__tests__/cron-deactivated-tenants-88`, `device-keys-deactivated-88`, `operator-audit-append-only-88`,
// `operator-auth-88`, `operator-config-88`, `operator-surface-off-88`, `operator-tenant-boundary-sweep-88`,
// `operator-tenants-88`, `tenant-deactivation-88`, `tenant-principal-guard-88` and
// `src/contexts/platform/__tests__/employee-creation-parity-88`, `operator-credentials-88`,
// `tenant-provisioning-88` - MIN_FILES rises from 381 to 396. MIN_TESTS rises from 6439 to 6638:
// +199 cases. The new files contribute 191, measured with the vitest JSON reporter on exactly those
// files (24, 10, 21, 4, 15, 16, 8, 2, 8, 21, 19, 11, 4, 13, 15); the edited files add their source
// case delta against the merge base - `scripts/__tests__/lint-tenant-scoping` 30 -> 36 (+6) and
// `src/contexts/platform/__tests__/access-context` 14 -> 16 (+2); `lint-tenant-scoping-model-graph`,
// `measure-foreign-context-access`, `lint-facade-signatures` and the rate-limit guard fix in
// `operator-auth-88` kept their case count. Lower-bound convention as above (the reporter counts a
// looping case more than once, the source once - the edited-file deltas use the source count).
// Full-suite run on this tree before the floor was raised: 559 files, 8866 tests.
// Issue #551 (2026-10-13), quick 261013-bhk on `fix/551-leerer-mandant-sperre` (based on 0f248682):
// 2 new test files - `src/__tests__/tenant-required-551` and
// `scripts/__tests__/audit-551-users-without-employee` - MIN_FILES rises from 396 to 398. MIN_TESTS rises
// from 6638 to 6674: +36 cases, measured by counting `it(` / `it.each(` per file in the blob at 0f248682
// vs HEAD - new files 19 and 7; edited files `src/contexts/platform/__tests__/request-permissions` 28 -> 29
// (+1), `src/__tests__/access-context-missing` 3 -> 5 (+2), `activity-auth-neutrality` 6 -> 10 (+4, the
// amendments register), `src/contexts/scheduling/api/__tests__/shifts-my-week` 10 -> 11 (+1),
// `leave-days-work-location` 4 -> 5 (+1) and `operator-tenant-boundary-sweep-88` 7 -> 8 (+1); the edited
// files `tenant-deactivation-88` (19 -> 19, one title), `src/contexts/platform/__tests__/compat-role`
// (38 -> 38, one case rewritten 1:1) and `karenz-overrun` (one case rewritten 1:1, found by the full suite)
// kept their case count. Same lower-bound convention as above (a
// looping case counts once in the source and more in the reporter); not a re-measure-to-actual sweep.
// Issue #557 (2026-10-13), on `fix/557-mfa-reset-tokens` (based on origin/main @ 0f248682): one new
// test FILE, `src/__tests__/operator-token-version-557.test.ts` (11 cases, measured with the vitest JSON
// reporter) - MIN_FILES rises from 396 to 397 and MIN_TESTS from 6638 to 6649. The edited files
// `operator-auth-88`, `tenant-principal-guard-88`, `operator-tenants-88` and
// `operator-tenant-boundary-sweep-88` kept their case count (delta 0). Merged after PR #559 (Issue #551): both
// deltas add up (398 + 1 files, 6674 + 11 cases; +2 for the reset-race cases of the review, WR-02). Same lower-bound convention as above.
// Phase 89 plan 01 (Issue #89, 2026-10-13), on `feat/89-betreiber-ui` (based on origin/main @ adac8e59): one
// new test FILE, `src/__tests__/operator-salons-89.test.ts` (7 cases, as reported by its single-file
// run) - MIN_FILES rises from 399 to 400 and MIN_TESTS from 6687 to 6694. Same lower-bound convention as above.
// Phase 89 plan 06 task 1 (Issue #89, 2026-10-13): one new test FILE, `src/__tests__/operator-tenant-audit-89.test.ts`
// (8 cases, single-file run), plus 1 new case in `operator-audit-append-only-88.test.ts` (15 -> 16) - MIN_FILES rises
// from 400 to 401 and MIN_TESTS from 6694 to 6703. Same lower-bound convention as above.
// Phase 89 plan 06 task 2 (2026-10-13): one new test FILE, `src/__tests__/audit-log-operator-visibility-89.test.ts`
// (9 cases, single-file run) - MIN_FILES rises from 401 to 402 and MIN_TESTS from 6703 to 6712. The same task
// teaches lint:tenant-scoping the OR / Json-path form: 9 new fixture cases in `lint-tenant-scoping-verdict.test.ts`
// (19 -> 28 tests, no new test file), MIN_TESTS 6712 -> 6721. Same convention.
// Phase 89 plan 07 task 1 (2026-10-13): one new test FILE, `src/contexts/scheduling/__tests__/facade-couplings.test.ts`
// (15 cases, single-file run) - MIN_FILES rises from 402 to 403 and MIN_TESTS from 6721 to 6736. Same convention.
// Phase 89 plan 08 task 1 (2026-10-13): no new test file; `operator-salons-89.test.ts` grows from 7 to 15 cases (single-file
// run: the POST describe adds 8) - MIN_FILES stays 403, MIN_TESTS rises from 6736 to 6744. Same convention.
// Phase 89 plan 08 task 2 (2026-10-13): `operator-salons-89.test.ts` grows from 15 to 19 cases (single-file run: the
// atomicity describe adds 4) - MIN_FILES stays 403, MIN_TESTS rises from 6744 to 6748. Same convention.
// Phase 89 plan 09 task 1 (2026-10-13): `operator-salons-89.test.ts` grows from 19 to 30 cases (single-file run: the
// PATCH describe adds 11) - MIN_FILES stays 403, MIN_TESTS rises from 6748 to 6759. Same convention.
// Phase 89 plan 09 task 2 (2026-10-13): `operator-salons-89.test.ts` grows from 30 to 34 cases (single-file run: the
// PATCH atomicity describe adds 4) - MIN_FILES stays 403, MIN_TESTS rises from 6759 to 6763. Same convention.
// Phase 89 plan 10 refactor (2026-10-13): `operator-salons-89.test.ts` grows from 34 to 35 cases (SALON_UPDATED carries no
// coupling value) - MIN_FILES stays 403, MIN_TESTS rises from 6763 to 6764. Same convention.
// Phase 89 plan 10 task 1 (2026-10-13): `operator-salons-89.test.ts` grows from 35 to 43 cases (single-file run: the
// deactivate / activate describe adds 8) - MIN_FILES stays 403, MIN_TESTS rises from 6764 to 6772. Same convention.
// Phase 89 plan 10 task 2 (2026-10-13): one new test FILE (`operator-salons-boundary-89.test.ts`, 8 cases in a single-file
// run) - MIN_FILES rises from 403 to 404, MIN_TESTS rises from 6772 to 6780. Same convention.
// Phase 89 plan 15 (2026-10-13): measured on `feat/89-betreiber-ui` after 89-15, full run - the whole
// API suite run alone reports 567 test files and 9030 tests (9027 passed, 3 skipped). Both floors are set to
// exactly these numbers (earlier floors followed the lower-bound convention above and had fallen far
// behind the real totals); no floor is lowered.
// Issue #569 (2026-10-13): one new test file `bulk-apply-active-workforce-569` (1 case) —
// MIN_FILES 567 -> 568, MIN_TESTS 9030 -> 9031. Same lower-bound convention as above.
// Issue #568 (2026-10-13): measured on `fix/568-bulk-apply-preview`, full run (`test:coverage`) - 571 test files,
// 9093 tests (9090 passed, 3 skipped). New files: bulk-apply-defaults.test.ts, bulk-apply-preview-568.test.ts,
// audit-568-bulk-apply-history.test.ts, plus the cases added to the six migrated bulk-apply files. Both floors are
// set to exactly these numbers; MIN_FILES 568 -> 571, MIN_TESTS 9031 -> 9093, never lowered. After the review
// fixes (tenant-local day compare, workDays, row locks) re-measured: 571 files, 9110 tests (9107 passed, 3 skipped)
// -> MIN_TESTS 9093 -> 9110.
// Issue #566 (2026-10-15): measured on `feat/566-pakete-je-mandant` after 566-11, full run (`test:coverage`) - 579 test
// files, 9246 tests (9243 passed, 3 skipped). New files of the phase: tenant-packages-566, operator-packages-566,
// tenant-packages-addons-566, tenant-packages-never-retroactive-566, packages-legal-core-isolation-566,
// tenant-packages-migration-566, scripts/__tests__/audit-566-package-backfill, plus the cases added to existing files.
// Both floors are set to exactly these numbers; MIN_FILES 571 -> 579, MIN_TESTS 9110 -> 9246, never lowered.
// Issue #90 (2026-10-15): measured on `feat/90-operator-dashboard` after 261015-f9i-03, full run (`test:coverage`) - 580
// test files, 9263 tests (9260 passed, 3 skipped). New file: operator-dashboard-90.test.ts (15 cases), plus the cases
// added to operator-surface-off-88 and the existing files the dashboard touched. Both floors are set to exactly these
// numbers; MIN_FILES 579 -> 580, MIN_TESTS 9246 -> 9263, never lowered.
// Issue #93 (2026-10-15): measured on `feat/93-support-zugriff` after 93b-11, full run (`test:coverage`) - 589 test
// files, 9496 tests (9493 passed, 3 skipped); new files: support-access-{decider,grant,reads,facades,immutability,
// tenant,boundary}-93, support-audit-redaction-93, plus the cases added to existing files (operator-surface-off-88,
// t100-09-oracle-probe, the facade-signature and measure-foreign-context-access tests) and what merged from origin/main
// since the #90 measurement. Both floors are set to exactly
// these numbers; MIN_FILES 580 -> 589, MIN_TESTS 9263 -> 9496. Never lowered.
// Issue #563 (2026-10-15): measured on `feat/563-salonverwaltung` after 563-07, full run (`test:coverage`) - 592 test
// files, 9530 tests (9527 passed, 3 skipped); new files: salon-admin-563, settings-store-hours-retired-563 and the
// rewritten store-hours-readers guard, the mirror test removed. MIN_FILES 589 -> 592, MIN_TESTS 9496 -> 9530.
// Issue #539 (2026-10-15): measured on `feat/539-rueckfall-entfernen` after 539-13, full run (`test:coverage`) - 602
// test files, 9649 tests (9646 passed, 3 skipped). Ten new files: fixture-role-assignments-539, seed-role-assignments-539,
// restorable-admin-539, backfill-539-role-assignments, neutrality-amendment-chain-539, neutrality-amendments-from-run,
// no-role-assigned-539, token-claims-539, employee-form-role-539 and the AST guard legacy-role-reads-539. Replaced
// cases: the fallback, materialization and role-claim cases (compat-role, request-permissions, resolve-access-reach,
// context-salon-ids-82, user-ids-holding-permission, employee-role-bridge, the `compatRoleForUser` describe removed with the
// function) now assert the fail-closed reality, plus the independent empty-role oracle in the permission matrix; nothing was
// skipped or weakened. MIN_FILES 592 -> 602, MIN_TESTS 9530 -> 9649. Never lowered.
// Issue #644 (2026-10-16): new file `section9-reach-644.test.ts` with 3 cases, counted from the source:
// MIN_FILES 602 -> 603, MIN_TESTS 9650 -> 9653.
// Issue #558 (2026-10-16): measured on `feat/558-salonauswahl` after 558-07, full run (`pnpm --filter @clokr/api test`) - 607
// test files, 9716 tests (9713 passed, 3 skipped). New files: employees-list-salon-filter-558, leave-salon-filter-558,
// shifts-week-salon-filter-558 and contexts/absence/__tests__/salon-leave-attribution-558; amended: access-context
// (salonOnlyReach), salon-context-manipulation-82 and shifts-planning-overview (planning-overview now answers 404 for an
// unreachable salon, stricter than before). Both floors are set to exactly these numbers; MIN_FILES 603 -> 607, MIN_TESTS 9653 -> 9716. Never lowered.
// Issue #86 + #650 (2026-10-16): measured with a full run (`pnpm --filter @clokr/api test`) on `feat/86-personalabteilung`
// merged with origin/main @ 4ff81ff0 - 612 test files, 9794 tests (the three files that hit "too many clients" under
// load pass in isolation). Composition: the 86b measurement (611 files / 9788 tests; new files hr-template-migration-86,
// reports-hr-86, hr-no-day-level-data-86, hr-view-86; amended system-roles and system-role-template-personalabteilung)
// plus #650's `cancel-orphan-shifts-permission-650.test.ts` (+1 file, +6 tests). Both floors equal the measured numbers.
// Issue #654 (2026-10-16): +1 file (import-reach-654.test.ts), counted from the source, no full run: MIN_FILES 612 -> 613.
// Phase 70b / Issue #70 (2026-10-16): measured on `feat/70-mehrere-eintraege` after 70b-08, full run
// (`pnpm --filter @clokr/api test`, merged with origin/main @ 5afdbac9) - 629 test files, 9918 tests (9915 passed,
// 3 skipped). New files: scripts/__tests__/audit-70-entry-overlaps, time-entry-multi-entry-70, time-entry-overlap-message-70,
// time-entry-locked-day-70, clock-second-salon-70, day-entries-selectors-70, retro-approve-overlap-70, imports-multi-entry-70,
// find-unconfirmed-break-days-70, jarbschg-day-sum-70, time-entry-multi-entry-migration-70, time-entry-overlap-constraint-70,
// multi-entry-saldo-equality-70, multi-entry-month-close-70, clock-salon-choice-70, time-entry-list-salon-name-70 (16 files,
// the shared helper entry-lock-race-helpers.ts has no cases) on top of the baseline of 607 files plus the 6 files that came
// in from origin/main meanwhile (#86, #650, #654); amended files kept or raised their case counts, none was
// removed, skipped or loosened. MIN_FILES 613 -> 629, never lowered.
// Issue #658 (2026-10-16, merged from origin/main @ 7e9a2f8f): +1 file (time-entry-create-reach-658.test.ts), source-counted.
// Phase 92b-05 (2026-10-16): measured with a full run (`pnpm --filter @clokr/api test`) after the merge of origin/main
// @ 7e9a2f8f - 642 test files, 10087 tests (10084 passed, 3 skipped); this includes the Phase 92b test files (travel entries).
// MIN_FILES 630 -> 642, never lowered.
// Issue #614 (2026-10-17): measured with a full run (`pnpm --filter @clokr/api test`) on `feat/614-anonymisierung-austritt`
// (origin/main @ b83fb1bf, no later commit) - 650 test files, 10142 tests (10138 passed, 3 skipped, 1 red on an unmapped
// file that the same commit's context-area-map entries fix). New files: anonymization-ends-employment-614,
// anonymization-absence-kinds-614, anonymization-spanning-exit-614, anonymization-closed-months-614,
// anonymization-employee-number-614, dashboard-upcoming-leave-anonymized-614, contexts/absence/__tests__/leave-correction-core-614
// and scripts/__tests__/audit-614-anonymized-employment (+8 files); amended: anonymize-helper, day-break-compliance-80,
// section9-model. MIN_FILES 642 -> 650, never lowered.
// Phase 595-06 (2026-10-17): measured with a full run (`pnpm --filter @clokr/api test`) on `feat/595-monatsbericht` -
// 651 test files, 10152 tests (10149 passed, 3 skipped). Nine new test files: report-page-pdf-parity-595,
// closed-month-never-recalculated-595, snapshot-period-595, snapshot-month-labels-595, snapshot-month-naming-guard-595,
// leave-sick-days-595, scripts/__tests__/audit-595-legacy-period-start, scripts/__tests__/demo-close-previous-month-595,
// scripts/__tests__/demo-month-bounds-595. Two facade tests were removed together with the dead W4 reader in 595-01
// (a deliberate removal of a function without a caller, not a loosened assertion). MIN_FILES 642 -> 651, never lowered.
// Merged on top of #595 (2026-10-17): #595's measured 651 files / 10152 tests plus #614's additions
// (+8 files, +55 tests) = 659 / 10207, never lowered.
// Phase 613 (2026-10-17): measured with a full run (`pnpm --filter @clokr/api test`) on `feat/613-personenkreis`
// (origin/main @ 47e8fcb7 merged in: #595, #614, #661) - 669 test files, 10289 tests (10286 passed, 3 skipped).
// New files (+10): employed-in-period-613, contexts/platform/__tests__/employed-in-period, reports-vacation-population-613,
// pdf-vacation-overview-placeholder-613, month-close-status-population-613, final-saldo-613, overtime-overview-exited-613,
// dashboard-population-613, report-population-guard-613 and scripts/__tests__/audit-613-month-close-population;
// nothing removed. MIN_FILES 659 -> 669, never lowered.
// Phase 587 (2026-10-17): measured with a full run (`pnpm --filter @clokr/api test`) on `fix/587-tagesstatus`
// (origin/main @ 83114c35, #613 merged in) - 672 test files, 10346 tests (10343 passed, 3 skipped). New files (+3):
// contexts/time-tracking/__tests__/day-status, composition/__tests__/day-status-parity-587 and
// __tests__/day-status-one-function-587; nothing removed, skipped or loosened (two assertions of the old status chain
// were converted with a written reason, see the 587-01 summary). MIN_FILES 669 -> 672, never lowered.
// Issue #664 (2026-10-17): full run measured 673 files, 10350 tests; the one new file (closed-month-legacy-lock-664, +4 tests) is the only addition, nothing removed. MIN_FILES 672 -> 673, never lowered.
// Issue #662 (2026-10-17): measured with a full run (`pnpm --filter @clokr/api test`) on `fix/662-section9-storno`
// (origin/main @ c6f29716) - 674 test files, 10359 tests (10356 passed, 3 skipped). New files (+2):
// leave-cancellation-section9-662 and scripts/__tests__/audit-662-cancelled-leave-section9; anonymization-absence-kinds-614
// swaps the SECTION9_CREDIT_ACTIVE skip case for two cases of the new behaviour. MIN_FILES 672 -> 674, never lowered.
// Merge #662 onto #664 (2026-10-17): both additions summed (672 + 1 + 2 = 675), no file removed.
// Issue #663 (2026-10-17): measured with a full run (`pnpm --filter @clokr/api test`) on `fix/663-backfill-leave-fields`
// (origin/main @ c6f29716) - 674 test files, 10354 tests (10351 passed, 3 skipped). New files (+2):
// scripts/__tests__/backfill-month-snapshots-leave-fields-663 and scripts/__tests__/audit-663-backfilled-snapshots;
// nothing removed, skipped or loosened. MIN_FILES 672 -> 674, never lowered.
// Merge #663 onto main (2026-10-17): main 675 + 2 = 677. Never lowered.
// Phase 617 (2026-10-17): measured with a full run (`pnpm --filter @clokr/api test`) on `fix/617-monatsexport`
// (origin/main @ c6f29716, phase 587 merged in, after 617-03) - 677 test files, 10400 tests (10397 passed, 3 skipped).
// New files since 672: pdf-format-617, monthly-export-render-617, monthly-export-617, vacation-balance-split-617 and
// leave-overview-vacation-617; nothing removed, skipped or loosened (the removed company-PDF cases were migrated onto
// the Monatsexport or deleted with their subject, see the 617-03 summary). MIN_FILES 672 -> 677, never lowered.
// Plan 617-06 (2026-10-17): measured with a full run (`pnpm --filter @clokr/api test`) on `fix/617-monatsexport` after
// merging origin/main @ 8411b33c (#664/#672) - 681 test files, 10399 tests (10396 passed, 3 skipped). New files since the
// 677 above: closed-month-legacy-lock-664 (#664, +1) and, from plan 617-05, stundennachweis-render-617,
// stundennachweis-day-rows-617 and pdf-output-guard-617 (+3); nothing removed, skipped or loosened in this step.
// MIN_FILES 677 -> 681, never lowered.
// Merge #617 onto main (2026-10-17): main 675 + 8 = 683. Never lowered.
// Merge #617 onto main (2026-10-17): main 677 + 8 = 685. Never lowered.
// Issue #666 (2026-10-17): measured with a full run (`pnpm --filter @clokr/api test`) on `feat/666-anonymized-backfill`
// (origin/main @ 5b73e04e) - 686 test files, 10437 tests (10434 passed, 3 skipped). New file:
// backfill-666-anonymized-employment (+17 cases); nothing removed, skipped or loosened. MIN_FILES 685 -> 686, never lowered.
// Phase 542, plan 05 (2026-10-17): measured with a full run (`pnpm --filter @clokr/api test`) on
// `feat/542-salonfilter-berichte` after merging origin/main @ 8835ef5e (#666/#678) - 692 test files, 10513 tests
// (10510 passed, 3 skipped). Six new files, all from this phase: salon-view (542-01), reports-salon-filter-542 (542-01),
// report-salon-filter-source-542 (542-01), dashboard-salon-filter-542 (542-02), monthly-export-salon-filter-542 and
// monthly-export-salon-label-542 (542-03); nothing removed, skipped or loosened. MIN_FILES 686 -> 692, never lowered.
// Issue #681 (2026-10-17): measured with a full run (`pnpm --filter @clokr/api test`) on
// `fix/681-gesamtsaldo-offene-monate` (origin/main @ 59ef142e) - 693 test files, 10541 tests (10538 passed, 3 skipped).
// New file: open-month-chain-681 (+26 cases); saldo-boundary-neutrality-493 gains its amendment-register cases (+2);
// nothing removed, skipped or loosened. MIN_FILES 692 -> 693, never lowered.
const MIN_FILES = 693;
// Issue #619 (2026-10-16): `operator-auth-88` gains one case (the explicit TOTP step-boundary case), counted from
// the source (+1, lower-bound convention as above, no full run): MIN_TESTS 9649 -> 9650, MIN_FILES unchanged.
// Issue #654: +2 cases in import-reach-654.test.ts (source-counted): MIN_TESTS 9794 -> 9796.
// Phase 70b / Issue #70 (2026-10-16): MIN_TESTS 9796 -> 9918, the measured total of the run above (see MIN_FILES). Never lowered.
// Issue #658: +5 cases in time-entry-create-reach-658.test.ts (source-counted); extension: +6 cases (clock-in on behalf,
// retro create on behalf): 9918 + 11 = 9929 (source-counted).
// Phase 92b-05 (2026-10-16): MIN_TESTS 9929 -> 10087, the measured total of the full run named at MIN_FILES. Never lowered.
// Issue #614 (2026-10-17): MIN_TESTS 10087 -> 10142 (+55), the measured total of the full run named at MIN_FILES. Never lowered.
// Phase 595-06 (2026-10-17): MIN_TESTS 10087 -> 10152, the measured total of the full run named at MIN_FILES
// (net +65: the nine new files minus the two W4 facade tests). Never lowered.
// Phase 613 (2026-10-17): MIN_TESTS 10207 -> 10289, the measured total of the full run named at MIN_FILES. Never lowered.
// Phase 587 (2026-10-17): MIN_TESTS 10289 -> 10346 (+57), the measured total of the full run named at MIN_FILES. Never lowered.
// Issue #664 (2026-10-17): MIN_TESTS 10346 -> 10350 (+4), the measured total of the full run named at MIN_FILES. Never lowered.
// Issue #662 (2026-10-17): MIN_TESTS 10346 -> 10359 (+13), the measured total of the full run named at MIN_FILES. Never lowered.
// Merge #662 onto #664 (2026-10-17): both additions summed (10346 + 4 + 13 = 10363). Never lowered.
// Issue #663 (2026-10-17): MIN_TESTS 10346 -> 10354 (+8), the measured total of the full run named at MIN_FILES. Never lowered.
// Merge #663 onto main (2026-10-17): main 10363 + 8 = 10371. Never lowered.
// Phase 617 (2026-10-17): MIN_TESTS 10346 -> 10400 (+54), the measured total of the full run named at MIN_FILES. Never lowered.
// Plan 617-04 (2026-10-17): MIN_TESTS 10400 -> 10364 (-36), the ONE deliberate lowering of this phase: the three vacation
// PDFs were removed, which takes their per-route cases with them (permission-neutrality-matrix -24 = 3 routes x 8 actors,
// reports-hr-86 -3 = one status case per classified route) and nets -9 in the files whose vacation-PDF cases moved onto the
// Monatsexport or were deleted with their subject (reports-vacation-population-613 -2, reports-priced-leave-days-451 -1,
// reports-bs-leave-448 -1, reports-salon-scope -2, reports.test -3; each case listed in 617-04-SUMMARY.md). Measured with a
// full API run: 677 files, 10364 tests (10361 passed, 3 skipped); MIN_FILES stays 677 (no file removed).
// Plan 617-06 (2026-10-17): MIN_TESTS 10364 -> 10399 (+35), the measured total of the full run named at MIN_FILES:
// #664 +4 (closed-month-legacy-lock-664), plan 617-05 +30 (the three new files and the migrated cases) and 617-06 +1
// (a holiday outside the employment span is no row of the Stundennachweis). Never lowered below the measured total;
// the one deliberate lowering of this phase is the 617-04 entry above.
// Merge #617 onto main (2026-10-17): main 10363 + 49 = 10412. Never lowered.
// Merge #617 onto main (2026-10-17): main 10371 + 49 = 10420. Never lowered.
// Issue #666 (2026-10-17): MIN_TESTS 10420 -> 10437 (+17), the measured total of the full run named at MIN_FILES. Never lowered.
// Phase 542, plan 05 (2026-10-17): MIN_TESTS 10437 -> 10513 (+76), the measured total of the full run named at
// MIN_FILES. The six new files add 75 cases (dashboard-salon-filter-542 23, reports-salon-filter-542 15,
// report-salon-filter-source-542 15, monthly-export-salon-filter-542 9, salon-view 8, monthly-export-salon-label-542 5);
// the 76th is one further case in a data-driven existing file that was not attributed to a single file (no existing
// API test file was edited by this phase; main alone measures 10437, so the phase delta is the measured 76). Never lowered.
// Issue #681 (2026-10-17): MIN_TESTS 10513 -> 10541 (+28: open-month-chain-681 26, saldo-boundary-neutrality-493 2),
// the measured total of the full run named at MIN_FILES. Never lowered.
const MIN_TESTS = 10541;
const REPORT = process.argv[2] ?? "apps/api/vitest-report.json";

let raw;
try {
  raw = readFileSync(REPORT, "utf8");
} catch (err) {
  console.error(
    `check-test-completeness: could not read ${REPORT} (${err.code ?? err.message}).\n` +
      `The run must have produced this file — confirm \`reporters: ["default", "json"]\` and ` +
      `\`outputFile: { json: "./vitest-report.json" }\` are set in apps/api/vitest.config.ts, and ` +
      `that the test run completed (a crashed run never writes the report).`,
  );
  process.exit(1);
}

let report;
try {
  report = JSON.parse(raw);
} catch (err) {
  console.error(`check-test-completeness: ${REPORT} is not valid JSON (${err.message}).`);
  process.exit(1);
}

const files = report.testResults?.length;
const tests = report.numTotalTests;

if (typeof files !== "number" || typeof tests !== "number") {
  console.error(
    `check-test-completeness: ${REPORT} is missing testResults[] or numTotalTests — is this a ` +
      `genuine vitest JSON reporter output?`,
  );
  process.exit(1);
}

if (files < MIN_FILES || tests < MIN_TESTS) {
  console.error(
    `check-test-completeness: FAILED — collected ${files}/${MIN_FILES} files, ${tests}/${MIN_TESTS} tests.\n` +
      `If you deliberately removed tests, lower the floor in apps/api/scripts/check-test-completeness.mjs ` +
      `in the SAME commit and say why in the commit body. If you did not, the parallel run silently ` +
      `collected fewer files — investigate before doing anything else.`,
  );
  process.exit(1);
}

console.log(
  `check-test-completeness: ${files}/${MIN_FILES} files, ${tests}/${MIN_TESTS} tests — OK`,
);
process.exit(0);
