---
phase: 03-e2e-and-ui-quality
verified: 2026-03-31T09:45:00Z
status: human_needed
score: 10/10 must-haves verified
re_verification:
  previous_status: gaps_found
  previous_score: 6/10
  gaps_closed:
    - "Leave request creation submits successfully and the request appears in the Meine Antraege list"
    - "Leave request approval by admin changes the request status to APPROVED in the UI"
    - "Admin can create a new employee via the UI form and the employee appears in the employee table"
    - "Monatsabschluss close-month action clicks the close button after seeding a closeable month, and the UI reflects the closed status"
    - "Password policy settings can be changed and saved, and the changes persist after page reload"
  gaps_remaining: []
  regressions: []
human_verification:
  - test: "Mobile overflow test — run 'pnpm --filter e2e exec playwright test tests/mobile-flow.spec.ts --grep \"no horizontal scrollbar\" --project=desktop-chrome' against a running Docker dev environment"
    expected: "All 4 routes (/dashboard, /time-entries, /leave, /settings) pass — no horizontal scrollbar at 390px iPhone 14 viewport"
    why_human: "E2E tests require a running browser with app stack. The test structure and assertions are correct but were never executed to confirm passing."
---

# Phase 3: E2E and UI Quality Verification Report

**Phase Goal:** Critical user flows have E2E test coverage and the UI is usable on mobile with consistent design and German error messages
**Verified:** 2026-03-31T09:45:00Z
**Status:** human_needed
**Re-verification:** Yes — after gap closure (commits 0476a0e and 467db84)

## Summary

All 5 gaps from the initial verification are closed. The substantive E2E tests for leave approval (E2E-03), admin employee creation (E2E-04), Monatsabschluss close (E2E-05), and password policy persistence (UI-05) are now committed on the working branch (`fix/01-plan-checker-revisions`) via commits `0476a0e` and `467db84`. All 10 must-haves pass automated checks. One item (mobile overflow test) requires a human to confirm by running the test against a live stack.

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Login -> Dashboard -> Clock-in flow asserts state change (Eingestempelt seit visible, clock-out button appears) | VERIFIED | core-flows.spec.ts: 2 "Eingestempelt seit", 4 "clock-btn--in", 4 "clock-btn--out", 8 `await expect` — no regressions |
| 2 | Time entry CRUD flow (create, edit, delete) with hard assertions | VERIFIED | time-entries-flow.spec.ts: 11 `await expect`, 1 page.route, 1 "Monat ist gesperrt" — no regressions |
| 3 | Locked-month edit shows "Monat ist gesperrt" German error in frontend | VERIFIED | +page.svelte: 2x "Monat ist gesperrt", 2x `status === 403` — no regressions |
| 4 | Leave request creation and approval flow (employee-creates, admin-approves) | VERIFIED | leave-flow.spec.ts (commit 0476a0e): 15 `await expect`, 5 page.request calls, explicit `Authorization: Bearer ${employeeToken}`, `expect(statusData.status).toBe("APPROVED")` — 0 `if (await` patterns |
| 5 | Admin employee creation fills form, asserts table presence | VERIFIED | admin-settings-flow.spec.ts (commit 467db84): `#c-firstname`, `#c-lastname`, `#c-email`, `#c-empno` filled with unique `Date.now()` suffix, hard `expect(page.getByText("E2E Testmitarbeiter")).toBeVisible` — 0 `if (await` patterns |
| 6 | Monatsabschluss: pre-seed, click close button, assert locked status | VERIFIED | admin-settings-flow.spec.ts: API pre-seed via `page.request.post("/api/v1/time-entries", ...)`, `expect(closeBtn).toBeVisible()`, `closeBtn.click()`, `expect(page.getByText(/abgeschlossen/i)).toBeVisible()`, API verify `expect(closedMonth?.status).toBe("closed")` |
| 7 | Password policy save + reload persistence (UI-05) | VERIFIED | admin-settings-flow.spec.ts: reads `#pw-min-length`, changes value, clicks save, `page.reload()`, asserts persisted value — 1 `page.reload` confirmed |
| 8 | Mobile viewport uses iPhone 14 (390px) with isMobile:true, hasTouch:true | VERIFIED | mobile-flow.spec.ts: `test.use({ ...devices["iPhone 14"] })`, 0 occurrences of "375", 2 occurrences of "390" — no regressions |
| 9 | CI fails on critical audit findings (hard assertions in afterAll blocks) | VERIFIED | ui-quality.spec.ts: 6x `criticalFindings`, `expect(criticalFindings).toHaveLength(0)` in afterAll — no regressions |
| 10 | Touch target threshold 44px (WCAG 2.5.5), critical severity, UX reachability test | VERIFIED | ux-design-audit.spec.ts: `< 44`, "critical actions reachable within 2 clicks" test, `.clock-btn`, `Eintrag hinzufuegen`, `Neuer Antrag` assertions — no regressions |

**Score: 10/10 truths verified**

### Required Artifacts

| Artifact | Expected | Exists | Substantive | Wired | Status |
|----------|----------|--------|-------------|-------|--------|
| `apps/web/src/routes/(app)/time-entries/+page.svelte` | 403 -> "Monat ist gesperrt" mapping | Yes | Yes (2x message, 2x status check) | Yes (rendered in DOM) | VERIFIED |
| `apps/e2e/tests/core-flows.spec.ts` | E2E-01 clock-in/out with state assertions | Yes | Yes (8 expects, "Eingestempelt seit") | Yes (loginAsAdmin in beforeEach) | VERIFIED |
| `apps/e2e/tests/time-entries-flow.spec.ts` | E2E-02 CRUD + locked-month error | Yes | Yes (11 expects, page.route, "Monat ist gesperrt") | Yes (loginAsAdmin in beforeEach) | VERIFIED |
| `apps/e2e/tests/leave-flow.spec.ts` | E2E-03 leave creation + APPROVED assertion | Yes | Yes (15 expects, 5 page.request, explicit Bearer token, APPROVED status assert) | Yes (loginAsAdmin in beforeEach) | VERIFIED |
| `apps/e2e/tests/admin-settings-flow.spec.ts` | E2E-04 employee creation, E2E-05 Monatsabschluss, UI-05 password persistence | Yes | Yes (25 expects, API pre-seed, close click, reload persistence) | Yes (loginAsAdmin in beforeEach) | VERIFIED |
| `apps/e2e/tests/mobile-flow.spec.ts` | iPhone 14 device preset, 390px, isMobile:true | Yes | Yes (`devices["iPhone 14"]`, 0 "375", hard assertions) | Yes (loginAsAdmin in beforeEach) | VERIFIED |
| `apps/e2e/tests/ui-quality.spec.ts` | Hard CI-failing assertion on critical findings | Yes | Yes (6x criticalFindings, `toHaveLength(0)`) | Yes (afterAll executes correctly) | VERIFIED |
| `apps/e2e/tests/ux-design-audit.spec.ts` | 44px threshold, critical severity, UX reachability | Yes | Yes (`< 44`, "critical actions reachable", clock-btn assertion) | Yes (afterAll executes correctly) | VERIFIED |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `time-entries/+page.svelte` | `/api/v1/time-entries` (PUT/DELETE) | `(e as any)?.status === 403` catch blocks | WIRED | saveEntry() and deleteEntry() both map 403 to "Monat ist gesperrt" |
| `time-entries-flow.spec.ts` | `time-entries/+page.svelte` | Playwright `page.getByText("Monat ist gesperrt")` | WIRED | page.route() intercepts PUT -> 403, visible assertion present |
| `core-flows.spec.ts` | Dashboard page | `.clock-btn--in` / `.clock-btn--out` + "Eingestempelt seit" | WIRED | 4 clock-btn selectors, 2 Eingestempelt assertions |
| `leave-flow.spec.ts` | `/api/v1/leave` | `page.request.post` with explicit `Authorization: Bearer ${employeeToken}` | WIRED | Employee login -> employee token -> leave creation -> admin approval -> APPROVED status assert |
| `leave-flow.spec.ts` | `/api/v1/leave/:id/review` | `page.request.put` using admin browser context auth | WIRED | Admin approves max@clokr.de leave; self-approval block bypassed by different owner |
| `admin-settings-flow.spec.ts` | `/api/v1/overtime/close-month` | Pre-seed via `page.request.post("/api/v1/time-entries")`, then UI close button click | WIRED | API pre-seed, `closeBtn.click()`, UI text assertion, API close-month status verification |
| `admin-settings-flow.spec.ts` | `/api/v1/settings/security` (implicit) | `page.reload()` persistence verification after save | WIRED | Change min-length, click save, reload, assert persisted value |
| `mobile-flow.spec.ts` | playwright-core devices | `import { devices }` + `test.use({ ...devices["iPhone 14"] })` | WIRED | Spread applied at describe block level |
| `ui-quality.spec.ts` | CI pipeline | `expect(criticalFindings).toHaveLength(0)` in afterAll | WIRED | Correctly structured; 6 references to criticalFindings |
| `ux-design-audit.spec.ts` | CI pipeline | `expect(criticalFindings).toHaveLength(0)` in afterAll | WIRED | Touch target 44px with critical severity; reachability test present |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| `time-entries/+page.svelte` | `saveError` / `error` | 403 catch block in `saveEntry()` / `deleteEntry()` | Yes — set from real API error response status | FLOWING |
| `time-entries-flow.spec.ts` | mocked 403 response | `page.route("**/api/v1/time-entries/**")` | Yes — deterministic 403 via route intercept | FLOWING |
| `leave-flow.spec.ts` | `employeeToken`, `maxEmployee.id`, `leaveId`, `statusData.status` | Real API calls: `/api/v1/auth/login`, `/api/v1/employees`, `/api/v1/leave`, `/api/v1/leave/:id` | Yes — real API responses with real DB state | FLOWING |
| `admin-settings-flow.spec.ts` | Monatsabschluss `closedMonth.status` | `page.request.get("/api/v1/overtime/close-month/year-status?year=...")` | Yes — real API close-month state verification | FLOWING |
| `admin-settings-flow.spec.ts` | `persistedValue` (password policy) | `page.reload()` + `#pw-min-length` input value | Yes — real page reload forces fresh API fetch | FLOWING |

### Behavioral Spot-Checks

Step 7b SKIPPED — E2E tests require a running browser and app stack (Docker). Test structure and all acceptance-criteria assertions verified statically.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| E2E-01 | 03-01-PLAN.md | Login -> Dashboard -> Clock in/out flow | SATISFIED | core-flows.spec.ts: 2 substantive clock tests, "Eingestempelt seit" assertion, clock-btn--in/out selectors |
| E2E-02 | 03-01-PLAN.md | Time entry create/edit/delete flow | SATISFIED | time-entries-flow.spec.ts: 4 tests (page load, create, edit, delete), all with hard expects |
| E2E-03 | 03-02-PLAN.md | Leave request -> approval -> calendar display | SATISFIED | leave-flow.spec.ts: 15 expects, max@clokr.de employee token, explicit Bearer header, `expect(statusData.status).toBe("APPROVED")` |
| E2E-04 | 03-02-PLAN.md | Admin employee management flow | SATISFIED | admin-settings-flow.spec.ts: `#c-firstname/lastname/email/empno` filled with unique test data, `expect(page.getByText("E2E Testmitarbeiter")).toBeVisible()` |
| E2E-05 | 03-02-PLAN.md | Monatsabschluss lock/unlock flow | SATISFIED | admin-settings-flow.spec.ts: API pre-seed, year navigation, `closeBtn.click()`, `expect(/abgeschlossen/).toBeVisible()`, API status verification |
| UI-01 | 03-03-PLAN.md | Mobile-responsive (390px, 44px touch targets) | SATISFIED (pending human) | mobile-flow.spec.ts: iPhone 14 preset; ux-design-audit.spec.ts: 44px threshold; horizontal scrollbar test exists with hard assertion — needs runtime confirmation |
| UI-02 | 03-01-PLAN.md | Consistent German error messages, locked-month messages | SATISFIED | time-entries/+page.svelte: 2x "Monat ist gesperrt" in 403 catch blocks; error rendered in DOM |
| UI-03 | 03-03-PLAN.md | Design consistency audit (CI-failing assertions) | SATISFIED | ui-quality.spec.ts and ux-design-audit.spec.ts: `expect(criticalFindings).toHaveLength(0)` in afterAll |
| UI-04 | 03-03-PLAN.md | UX flow improvements (reachability, fewer clicks) | SATISFIED | ux-design-audit.spec.ts: "critical actions reachable within 2 clicks" test — clock-btn, add entry, new leave button assertions |
| UI-05 | 03-02-PLAN.md | Password policy admin UI | SATISFIED | admin-settings-flow.spec.ts: reads `#pw-min-length`, changes value, saves, `page.reload()`, asserts persistence, restores original |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `apps/e2e/tests/leave-flow.spec.ts` | 22, 41, 46, 128, 133, 153, 159, 166, 174, 182, 187 | `page.waitForTimeout(...)` — 11 occurrences | Warning | Fragile timing in non-critical helper tests (calendar navigation, tab switches, modal settle). Core E2E-03 approval test uses `waitForLoadState("networkidle")`. Not a goal blocker. |
| `apps/e2e/tests/admin-settings-flow.spec.ts` | 29, 44, 68, 72, 81, 104, 132, 150, 273, 286, 308, 318 | `page.waitForTimeout(...)` — 12 occurrences | Warning | Same pattern — used in non-critical navigation tests and UI settle delays. Core E2E-04/05/UI-05 tests use `waitForLoadState("networkidle")`. Not a goal blocker. |

No blocker anti-patterns remain. All `if (await el.isVisible())` optional assertion patterns have been eliminated from all modified files.

### Human Verification Required

#### 1. Mobile Overflow Test

**Test:** Start the full Docker stack (`docker compose up --build -d`), then run:
`pnpm --filter e2e exec playwright test tests/mobile-flow.spec.ts --grep "no horizontal scrollbar" --project=desktop-chrome`
**Expected:** Test passes with 0 overflowing routes — all 4 routes (/dashboard, /time-entries, /leave, /settings) display without horizontal scrollbar at 390px iPhone 14 viewport
**Why human:** E2E tests require a running browser with app server. The test exists with correct structure (`expect(overflow).toHaveLength(0)`) and uses the correct iPhone 14 (390px) preset, but was not executed against a live stack to confirm it passes. The 03-03-SUMMARY documented "Docker-based E2E tests not runnable in current environment" and Task 3 was noted as skipped.

### Gaps Summary

No gaps remain from the previous verification. All 5 previously failed truths are now verified:

**Gap 1 and 2 (E2E-03 leave approval):** Closed by commit `0476a0e`. leave-flow.spec.ts now contains substantive employee-creates -> admin-approves flow using `page.request.post` with explicit `Authorization: Bearer ${employeeToken}`, 5 API calls total, and a hard `expect(statusData.status).toBe("APPROVED")` assertion. The employee credentials `max@clokr.de` / `mitarbeiter5678` are used, the self-approval block is bypassed by having the admin approve max's request.

**Gap 3 (E2E-04 employee creation):** Closed by commit `467db84`. admin-settings-flow.spec.ts fills `#c-firstname`, `#c-lastname`, `#c-email`, `#c-empno` with unique test data (`Date.now()` suffix), handles password checkbox for direct creation, and asserts `page.getByText("E2E Testmitarbeiter").first()` is visible in the table.

**Gap 4 (E2E-05 Monatsabschluss):** Closed by commit `467db84`. The test finds an open month via API year-status, seeds a time entry, navigates to the correct year, clicks `Abschliessen`, asserts `abgeschlossen` text in UI, and verifies API status is `"closed"`.

**Gap 5 (UI-05 password policy persistence):** Closed by commit `467db84`. The test reads `#pw-min-length`, changes value (toggle between 12 and 14), saves, calls `page.reload()`, and asserts the persisted value equals the saved value.

The previous root cause (code existing only on orphaned branch `worktree-agent-a4815e88`) is resolved — both files are now committed directly on `fix/01-plan-checker-revisions`.

---

_Verified: 2026-03-31T09:45:00Z_
_Verifier: Claude (gsd-verifier)_
_Re-verification: Yes — previous gaps_found (6/10), now human_needed (10/10)_
