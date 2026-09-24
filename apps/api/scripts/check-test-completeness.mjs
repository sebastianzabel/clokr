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
const MIN_FILES = 299;
const MIN_TESTS = 3708;
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
