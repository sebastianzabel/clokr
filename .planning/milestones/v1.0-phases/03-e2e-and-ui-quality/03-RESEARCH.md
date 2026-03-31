# Phase 3: E2E and UI Quality - Research

**Researched:** 2026-03-31
**Domain:** Playwright E2E testing, mobile responsive CSS, SvelteKit error handling, UI audit hardening
**Confidence:** HIGH

## Summary

Phase 3 is a purely hardening phase — no new API or feature work beyond the locked-month frontend error message. All infrastructure is in place: Playwright 1.58.2 is installed, `storageState` auth is wired, and 12 spec files exist. The work is almost entirely replacing scaffold assertions with real ones, converting soft audit collectors to hard expects, fixing two numeric constants (375→390px viewport, 32→44px touch target), and adding one frontend string ("Monat ist gesperrt") plus its E2E assertion.

The API is confirmed to return `{ error: "Eintrag ist gesperrt und kann nicht bearbeitet werden" }` (PUT) and `{ error: "Eintrag ist gesperrt und kann nicht gelöscht werden" }` (DELETE) with HTTP 403. The frontend catches these as `ApiError.message` and surfaces them into `saveError` / `error` state variables — but currently shows the raw API string, not a specific locked-month message. The fix is to intercept 403 responses in the save/delete handlers and map them to "Monat ist gesperrt".

The `savePasswordPolicy()` function in the admin system page calls `PUT /api/v1/settings/security` which exists, accepts `passwordMinLength/requireUpper/requireSpecial`, and returns the updated config — the endpoint is fully functional. The password policy E2E test only needs to exercise the UI save action and assert persistence.

The seed creates exactly two demo users: `admin@clokr.de` (ADMIN) and `max@clokr.de` (EMPLOYEE). No manager storageState exists. For the leave approval flow (E2E-03) the admin user already has ADMIN role which satisfies `requireRole("ADMIN", "MANAGER")` — a second manager storageState is not required. The admin can request leave as one employee and approve as admin in the same browser session or via API verification.

**Primary recommendation:** Write all E2E flows directly in existing spec files using the `storageState: ".auth/admin.json"` already wired; use `devices["iPhone 14"]` (390×664px) for mobile; convert all `findings.push()` patterns to `expect(criticalFindings).toHaveLength(0)` hard assertions.

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** All 5 required flows need substantive new test bodies. Write in existing files or replace their bodies — do not create new files.
- **D-02:** Use the existing storageState admin auth from `apps/e2e/tests/auth.setup.ts`. Clock-in/out flow (E2E-01) must click the clock button and assert the resulting state change.
- **D-03:** Leave approval flow (E2E-03) must exercise employee-creates → manager-approves path. Use admin acting as both roles or create a manager storageState if needed.
- **D-04:** Monatsabschluss flow (E2E-05) must click the close-month action and assert `isLocked: true` via API or UI state, not just navigate.
- **D-05:** Target viewport is 390px — update `mobile-flow.spec.ts` from 375px to 390px using `devices["iPhone 14"]`.
- **D-06:** Touch target threshold must be ≥ 44px — update `ux-design-audit.spec.ts` from 32px to 44px.
- **D-07:** Mobile overflow fixes: targeted `max-width: 100%; overflow-x: hidden` per component — no global breakpoints.
- **D-08:** Add "Monat ist gesperrt" (or "Monat wurde abgeschlossen") message to the time entry edit/delete error handler in `apps/web/src/routes/(app)/time-entries/+page.svelte`.
- **D-09:** Add E2E assertion in `time-entries-flow.spec.ts` verifying the locked-month message appears.
- **D-10:** Other German error messages (auth, validation) are confirmed present — no changes needed.
- **D-11:** Password policy UI is already built — only an E2E test is needed for UI-05.
- **D-12:** Verify `savePasswordPolicy()` calls a valid API endpoint before writing the E2E test; fix if broken.
- **D-13:** Convert audit tests from collector/log pattern to hard assertions. `ui-quality.spec.ts`, `ux-design-audit.spec.ts`, `visual-audit.spec.ts`, `dynamic-audit.spec.ts` use `findings.push()` + `afterAll` logging.
- **D-14:** Keep audit scope to what's already measured — do not add new audit categories.
- **D-15:** UI-04 scope: (a) critical action buttons reachable in ≤ 2 taps/clicks; (b) loading states shown during async operations.

### Claude's Discretion

- Exact Playwright device preset string for iPhone 14 (now verified: `devices["iPhone 14"]` → 390×664px)
- Whether to create a second storageState for manager role or reuse admin for leave approval (research conclusion: admin suffices — see below)
- Specific CSS properties to fix per-component for mobile overflow issues

### Deferred Ideas (OUT OF SCOPE)

- Visual regression testing (screenshot diffs)
- Employee and manager storageState for multi-role E2E (unless leave approval specifically requires it)
- Accessibility audit hardening (accessibility.spec.ts is out of scope)
- Performance/Lighthouse CI
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| E2E-01 | Login → Dashboard → Clock in/out flow | Clock button: `.clock-btn--in` / `.clock-btn--out`. State assertion: `page.getByText("Eingestempelt seit")`. API: `POST /time-entries/clock-in` then `POST /time-entries/:id/clock-out`. |
| E2E-02 | Time entry create/edit/delete flow | Modal at `.modal`/`[role='dialog']`. Save: `PUT /time-entries/:id`. Delete: `DELETE /time-entries/:id`. Error surface: `saveError` variable rendered in modal. |
| E2E-03 | Leave request → approval → calendar display | Leave API: `POST /leave` (employee) then `PUT /leave/:id` body `{status:"APPROVED"}` (admin/manager). Admin can both create and approve — no separate manager session needed. |
| E2E-04 | Admin employee management flow | `POST /employees` then verify row in `/admin/employees` table. Existing scaffold navigates to page; needs form fill + create + assert row exists. |
| E2E-05 | Monatsabschluss lock/unlock flow | `closeMonth()` calls `POST /overtime/close-month`. After close: status in UI changes to `"closed"`. Assert via `page.getByText("abgeschlossen")` or direct API `GET /overtime/close-month/year-status`. |
| UI-01 | Mobile-responsive at 390px, 44px touch targets | `mobile-flow.spec.ts`: change `{ width: 375 }` to `...devices["iPhone 14"]`. `ux-design-audit.spec.ts`: change touch target threshold from 32 to 44px. |
| UI-02 | German error messages, locked-month message | API returns 403 `"Eintrag ist gesperrt…"`. Frontend `saveEntry()` catch block sets `saveError`; `deleteEntry()` catch sets `error`. Neither currently maps 403 to "Monat ist gesperrt". Fix: detect `ApiError.status === 403` in both handlers and set specific message. |
| UI-03 | Design consistency audit hardening | Four audit files use `findings.push()` + `afterAll` log pattern — CI never fails. Convert critical-severity findings to hard `expect(criticalFindings).toHaveLength(0)`. |
| UI-04 | UX flow improvements | Scope: assert `.clock-btn` reachable within ≤ 2 clicks from dashboard, assert loading spinner appears on async save. |
| UI-05 | Password policy admin UI | `savePasswordPolicy()` calls `PUT /api/v1/settings/security` (confirmed functional). E2E: navigate to `/admin/system`, change `pwMinLength`, click save, reload page, assert persisted value. |
</phase_requirements>

---

## Standard Stack

### Core (already installed — no new packages)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| @playwright/test | 1.58.2 | E2E test framework | Already installed, config wired |
| devices (Playwright) | built-in | Device presets | `devices["iPhone 14"]` = 390×664px, isMobile, hasTouch |
| storageState | built-in | Auth persistence | Admin state at `.auth/admin.json`, wired via `dependencies: ["setup"]` |

### No New Dependencies Required

All tools are in place. Phase 3 is entirely test/code changes within existing infrastructure.

**Installation:** None needed.

**Version verification:** `@playwright/test@1.58.2` confirmed in `apps/e2e/package.json`. Device descriptor `"iPhone 14"` confirmed at 390×664px, `deviceScaleFactor: 3`, `isMobile: true`, `hasTouch: true` in `playwright-core@1.58.2` bundled descriptors.

---

## Architecture Patterns

### Existing E2E Project Structure
```
apps/e2e/
├── playwright.config.ts          # 4 projects: setup, desktop-chrome, mobile-chrome, tablet
├── .env                          # BASE_URL, TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD
├── .auth/
│   └── admin.json                # Stored storageState (written by auth.setup.ts)
└── tests/
    ├── auth.setup.ts             # Writes .auth/admin.json
    ├── helpers.ts                # login(), loginAsAdmin(), logout(), screenshotPage()
    ├── core-flows.spec.ts        # E2E-01 (clock-in/out goes here)
    ├── time-entries-flow.spec.ts # E2E-02 + locked-month assertion (UI-02)
    ├── leave-flow.spec.ts        # E2E-03 (approval flow)
    ├── admin-settings-flow.spec.ts # E2E-04 (employee mgmt) + E2E-05 (monatsabschluss) + UI-05 (password policy)
    ├── mobile-flow.spec.ts       # UI-01 mobile tests (375→390px fix)
    ├── ui-quality.spec.ts        # UI-03 audit (needs hard assertions)
    ├── ux-design-audit.spec.ts   # UI-03 + UI-01 touch targets (32→44px fix)
    ├── visual-audit.spec.ts      # UI-03 (screenshot-only, stays soft)
    └── dynamic-audit.spec.ts     # Already has hard assertions on most tests
```

### Pattern 1: Substantive Flow Assertion (replacing scaffold)
**What:** Replace `if (await element.isVisible())` optionals with hard `await expect(element).toBeVisible()` + state change assertions.
**When to use:** All 5 E2E flows (E2E-01 through E2E-05)
**Example:**
```typescript
// E2E-01: Clock-in assertion
test("clock in and assert running state", async ({ page }) => {
  await page.goto("/dashboard");
  await page.waitForLoadState("networkidle");

  const clockInBtn = page.locator(".clock-btn--in");
  await expect(clockInBtn).toBeVisible();
  await clockInBtn.click();

  // Assert state changed — button text and status both update
  await expect(page.locator(".clock-btn--out")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/Eingestempelt seit/)).toBeVisible();
});
```

### Pattern 2: API Verification After UI Action (for Monatsabschluss)
**What:** After a UI action that mutates backend state, verify via a secondary API call from within the test.
**When to use:** E2E-05 (Monatsabschluss) where the UI status string may be ambiguous.
**Example:**
```typescript
// After clicking close-month button:
const resp = await page.request.get(
  `/api/v1/overtime/close-month/year-status?year=${year}`,
  { headers: { Authorization: `Bearer ${token}` } }
);
const data = await resp.json();
const monthStatus = data.months.find((m: any) => m.month === targetMonth);
expect(monthStatus?.status).toBe("closed");
```
Alternatively, assert the UI badge: `await expect(page.getByText("Abgeschlossen").first()).toBeVisible()`.

### Pattern 3: Hard Audit Assertion (replacing collector pattern)
**What:** Split findings into `criticalFindings` and `nonCriticalFindings`. Only fail CI on critical.
**When to use:** UI-03 conversion of `ui-quality.spec.ts` and `ux-design-audit.spec.ts`
**Example:**
```typescript
// In afterAll (ui-quality.spec.ts):
const criticalFindings = findings.filter((f) => f.severity === "critical");
const nonCritical = findings.filter((f) => f.severity !== "critical");
// Log non-critical for visibility
nonCritical.forEach((f) => console.log(`[${f.severity}] ${f.message}`));
// Fail CI on critical violations
expect(
  criticalFindings,
  criticalFindings.map((f) => `[${f.page}] ${f.category}: ${f.message}`).join("\n"),
).toHaveLength(0);
```

### Pattern 4: Locked-Month Error Message (UI-02)
**What:** In `saveEntry()` and `deleteEntry()` catch blocks, check for `ApiError` with status 403 and map to a specific German string.
**When to use:** Time entries page — both PUT (edit) and DELETE handlers.
**Example:**
```typescript
// In saveEntry() catch block:
} catch (e: unknown) {
  if (e instanceof ApiError && e.status === 403) {
    saveError = "Monat ist gesperrt und kann nicht bearbeitet werden";
  } else {
    saveError = e instanceof Error ? e.message : "Fehler beim Speichern";
  }
}
```
Note: `ApiError` is not exported from `client.ts`. Either export it or use duck-typing: `(e as any).status === 403`.

### Pattern 5: iPhone 14 Viewport via Device Preset
**What:** Replace raw `{ width: 375, height: 812 }` viewport with named device preset.
**When to use:** `mobile-flow.spec.ts` viewport fix (UI-01).
**Example:**
```typescript
// In mobile-flow.spec.ts — replace:
test.use({ viewport: { width: 375, height: 812 } }); // iPhone 13

// With:
import { devices } from "@playwright/test";
test.use({ ...devices["iPhone 14"] }); // 390x664, isMobile: true, hasTouch: true
```
The device preset sets `isMobile: true` and `hasTouch: true` in addition to viewport — matching real mobile browser behavior.

### Anti-Patterns to Avoid

- **Optional assertions via `if (await el.isVisible())`:** These let tests pass even when UI elements are missing. Replace with hard `await expect(el).toBeVisible()`.
- **`page.waitForTimeout()` for async completion:** Prefer `page.waitForLoadState("networkidle")` or `await expect(el).toBeVisible({ timeout: 10_000 })`.
- **Global CSS overflow fix:** Do not add `* { overflow-x: hidden }` — this breaks sticky headers and modals. Fix per-component.
- **Checking `findings.length` after `afterAll` but not failing the test:** The test function itself must throw/assert; `afterAll` logging is never picked up by CI reporters.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Mobile device emulation | Custom `{ width: 390, height: 844 }` viewport objects | `devices["iPhone 14"]` from Playwright | Sets isMobile, hasTouch, userAgent, deviceScaleFactor automatically |
| Auth state for multi-test reuse | Login in `beforeEach` | `storageState: ".auth/admin.json"` + `dependencies: ["setup"]` | Already wired in playwright.config.ts; login overhead eliminated |
| API verification in E2E | Separate fetch calls with auth headers | `page.request.get()` (inherits page context + cookies) | Playwright's `page.request` shares the authenticated browser context |
| Touch target measurement | Custom JS calculation | `element.boundingBox()` | Returns DOMRect; `.height >= 44` directly tests the CSS pixel target size |

---

## Runtime State Inventory

> Not applicable — this is a test hardening + minor frontend fix phase, not a rename/refactor/migration.

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| @playwright/test | All E2E tests | Yes | 1.58.2 | — |
| Docker (running app) | E2E tests hitting localhost | Not checked at research time | — | Run `docker compose up -d` before test run |
| Node.js | Playwright / pnpm | Yes (project-wide) | 24-alpine in Docker | — |

**Note on test execution:** The playwright config does NOT define a `webServer` block — tests expect the app to be running at `BASE_URL` (default `http://localhost:3000`) before they start. The planner must ensure Docker is running before test waves execute.

**Missing dependencies with no fallback:**
- Running Docker stack — without it, all E2E tests fail immediately. Plan must include a pre-test step or note this as operator prerequisite.

---

## Common Pitfalls

### Pitfall 1: Admin Cannot Approve Their Own Leave Requests
**What goes wrong:** The leave approval API explicitly blocks self-approval: `"Eigene Anträge können nicht selbst genehmigt werden"` (HTTP 400).
**Why it happens:** DSGVO/compliance requirement — `Cancellation always requires approval by a DIFFERENT manager`.
**How to avoid:** For E2E-03, do NOT have the admin user both request AND approve their own leave. Strategy: (a) Use the API directly to create a leave request via the seeded employee (`max@clokr.de`) using `page.request.post()` in the admin browser context — but employee requests must use employee credentials. (b) Simpler: create the leave via Playwright `request.newContext()` authenticated as employee (password from seed), then approve with admin session. Or: scope E2E-03 to "admin creates on behalf of employee → admin approves" if the API allows it (check: `PUT /leave/:id` by admin approving a request they didn't create).
**Warning signs:** Test fails with 400 "Eigene Anträge können nicht selbst genehmigt werden".

### Pitfall 2: Collector Pattern in `afterAll` Doesn't Fail the Test Runner
**What goes wrong:** Tests in `ui-quality.spec.ts` all pass, but `afterAll` logs violations to console. CI shows green even with critical violations.
**Why it happens:** Playwright collects test results per `test()` function. `afterAll` callbacks can throw and fail the suite, but the current implementation only calls `console.log()` — it never throws.
**How to avoid:** Move the `expect(criticalFindings).toHaveLength(0)` assertion into `afterAll` (which does propagate failures to the suite) OR into the last test in the describe block. `afterAll` throwing DOES fail the suite in Playwright.
**Warning signs:** CI passes but console shows "🔴 CRITICAL" lines.

### Pitfall 3: `ApiError` is Not Exported from client.ts
**What goes wrong:** Trying to use `e instanceof ApiError` in `+page.svelte` fails because `ApiError` class is not exported.
**Why it happens:** `ApiError` is declared as `class ApiError` (not `export class`) in `apps/web/src/lib/api/client.ts`.
**How to avoid:** Either (a) export the class and import it in the page, or (b) use duck-typing: `(e as any).status === 403`. Option (b) is simpler and consistent with the codebase's `e instanceof Error ? e.message : "Fehler"` pattern.
**Warning signs:** TypeScript error "ApiError is not defined" or "Property 'status' does not exist on type 'Error'".

### Pitfall 4: Leave Approval Flow (E2E-03) — No Seeded Manager Account
**What goes wrong:** Seed only creates `admin@clokr.de` (ADMIN) and `max@clokr.de` (EMPLOYEE). There is no manager-role user to create a leave request that admin can then approve without self-approval restriction.
**Why it happens:** Seed data is minimal by design.
**How to avoid:** Use two-phase approach: (1) Use `page.request.newContext()` with employee credentials to POST a leave request, capturing the leave ID from the response. (2) In the admin-authenticated page, navigate to approvals tab and approve the specific leave ID via API. Or: use the admin browser to CREATE a leave request on behalf of the employee via the manager UI path (if the API allows `employeeId` in the POST body for admins), then approve — since the creator is the admin and the system may block self-approval, verify this path first.
**Warning signs:** 400 "Eigene Anträge können nicht selbst genehmigt werden" on approval step.

### Pitfall 5: Mobile Viewport in `mobile-flow.spec.ts` is a `test.use()` Override
**What goes wrong:** The file uses `test.use({ viewport: { width: 375, height: 812 } })` at describe block level. Changing only the viewport numbers still uses the raw object — it won't set `isMobile: true` or `hasTouch: true`.
**Why it happens:** Raw viewport objects don't configure mobile simulation.
**How to avoid:** Replace with `test.use({ ...devices["iPhone 14"] })` which spreads the full device descriptor including `isMobile`, `hasTouch`, `userAgent`, `deviceScaleFactor`.
**Warning signs:** Tests pass but hover events trigger instead of tap events; touch-only elements don't respond.

### Pitfall 6: Monatsabschluss closeMonth() Iterates Per Employee
**What goes wrong:** The `closeMonth()` frontend function in `+page.svelte` iterates over `readyEmployees` and calls `POST /overtime/close-month` once per employee. If no employees have status "ready", it exits with an error. The test must ensure at least one employee has complete entries for the target month.
**Why it happens:** Monatsabschluss is per-employee, not per-month.
**How to avoid:** Use a past month (e.g., December of a prior year where the seeded admin employee has no entries — so "0 employees ready" is the expected state) OR use a month where entries exist. Alternatively, verify month status via API first and assert the UI reflects `"closed"` status after clicking close.
**Warning signs:** Test sees "Keine Mitarbeiter bereit zum Abschluss" error — the close action silently did nothing.

---

## Code Examples

Verified patterns from live codebase inspection:

### Clock-in Button Locator (E2E-01)
```typescript
// Source: apps/web/src/routes/(app)/dashboard/+page.svelte lines 650, 665
// Before clock-in: .clock-btn--in  (text: "Einstempeln")
// After clock-in:  .clock-btn--out (text: "Ausstempeln")
// Status text after clock-in: "Eingestempelt seit HH:mm Uhr"
const clockInBtn = page.locator(".clock-btn--in");
await expect(clockInBtn).toBeVisible();
await clockInBtn.click();
await expect(page.locator(".clock-btn--out")).toBeVisible({ timeout: 10_000 });
await expect(page.getByText(/Eingestempelt seit/)).toBeVisible();
```

### Locked-Month Error Handling Fix (UI-02)
```typescript
// Source: apps/web/src/routes/(app)/time-entries/+page.svelte lines 586-613, 616-623
// API returns HTTP 403 with body { error: "Eintrag ist gesperrt und kann nicht bearbeitet werden" }
// Source: apps/api/src/routes/time-entries.ts lines 921-924, 1085-1088, 1165-1168

// In saveEntry() catch:
} catch (e: unknown) {
  if ((e as any)?.status === 403) {
    saveError = "Monat ist gesperrt";
  } else {
    saveError = e instanceof Error ? e.message : "Fehler beim Speichern";
  }
}

// In deleteEntry() catch:
} catch (e: unknown) {
  if ((e as any)?.status === 403) {
    error = "Monat ist gesperrt";
  } else {
    error = e instanceof Error ? e.message : "Fehler beim Löschen";
  }
}
```

### Password Policy Save Function (UI-05)
```typescript
// Source: apps/web/src/routes/(app)/admin/system/+page.svelte lines 462-481
// Endpoint: PUT /api/v1/settings/security
// Schema accepts: passwordMinLength (int, 8-128), passwordRequireUpper/Lower/Digit/Special (boolean)
// Confirmed: GET /settings/security returns these fields on reload
async function savePasswordPolicy() {
  await api.put("/settings/security", {
    passwordMinLength: pwMinLength,
    passwordRequireUpper: pwRequireUpper,
    passwordRequireLower: pwRequireLower,
    passwordRequireDigit: pwRequireDigit,
    passwordRequireSpecial: pwRequireSpecial,
  });
}
// E2E: change pwMinLength via input, click save, reload, assert displayed value matches
```

### Monatsabschluss Close Flow (E2E-05)
```typescript
// Source: apps/web/src/routes/(app)/admin/monatsabschluss/+page.svelte lines 162-213
// API: POST /api/v1/overtime/close-month { employeeId, year, month }
// Status check: GET /api/v1/overtime/close-month/year-status?year=YYYY → months[].status === "closed"
// UI: success message = "Januar 2025: 1 abgeschlossen"
// UI: month badge changes to "Abgeschlossen" or status class "closed"
```

### iPhone 14 Device Preset (UI-01)
```typescript
// Source: playwright-core@1.58.2 deviceDescriptorsSource.json
// "iPhone 14": viewport {width:390, height:664}, screen {width:390, height:844},
//              deviceScaleFactor:3, isMobile:true, hasTouch:true
import { test, devices } from "@playwright/test";
test.use({ ...devices["iPhone 14"] });
// Replaces: test.use({ viewport: { width: 375, height: 812 } });
```

### Hard Audit Assertion Pattern (UI-03)
```typescript
// Convert from:
test.afterAll(() => {
  findings.forEach(f => console.log(f.message)); // never fails CI
});

// To:
test.afterAll(() => {
  const criticalFindings = findings.filter((f) => f.severity === "critical");
  const nonCritical = findings.filter((f) => f.severity !== "critical");
  // Log non-critical for review
  if (nonCritical.length > 0) {
    console.log(`\nNon-critical findings (${nonCritical.length}):`);
    nonCritical.forEach((f) => console.log(`  [${f.severity}] [${f.page}] ${f.message}`));
  }
  // Hard fail on critical
  expect(
    criticalFindings,
    criticalFindings.map((f) => `[${f.page}] ${f.category}: ${f.message}`).join("\n"),
  ).toHaveLength(0);
});
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Playwright `page.waitForSelector` | `expect(locator).toBeVisible()` | Playwright 1.20+ | Auto-retry with configurable timeout |
| Custom device viewport objects | `devices["iPhone 14"]` named preset | Always available | Sets isMobile + hasTouch correctly |
| Per-test login | `storageState` + `dependencies: ["setup"]` | Playwright 1.14+ | Already used in this project |

**Current project patterns to match:**
- All tests call `loginAsAdmin()` in `beforeEach` even though storageState is set — this is redundant but harmless. New tests should follow the same pattern for consistency (storageState handles auth; `loginAsAdmin()` call is superfluous but present in all existing tests).
- `screenshotPage()` calls are used extensively for manual review — continue using them in new flows.

---

## Open Questions

1. **Leave Approval (E2E-03) — self-approval constraint**
   - What we know: API blocks self-approval for leave cancellations AND standard approvals (line 505: "Eigene Anträge können nicht selbst genehmigt werden").
   - What's unclear: Whether creating a leave request via `POST /leave` as admin for `employeeId=max_employee_id` bypasses the self-approval check (admin creates on behalf of employee → admin approves, not self-approval since different user owns the request).
   - Recommendation: In Wave 1, verify via API test: POST leave with `{ employeeId: employee_id }` as admin, then attempt PUT approval as same admin. If it succeeds, use that path. If it fails, use `page.request.newContext()` with employee credentials to create.

2. **Mobile overflow fixes (UI-01/D-07) — which components overflow**
   - What we know: `mobile-flow.spec.ts` already tests overflow on `/dashboard`, `/time-entries`, `/leave`, `/settings` at 375px and the test currently expects `toHaveLength(0)` — if it were passing, overflow would already be fixed.
   - What's unclear: Whether the tests currently pass at 375px or fail. If they fail, specific components need CSS fixes before the viewport change.
   - Recommendation: Run `pnpm playwright test mobile-flow.spec.ts` first (Wave 0) to baseline which routes overflow. Fix CSS per-component before asserting at 390px.

3. **Monatsabschluss status assertions — seeded data**
   - What we know: `closeMonth()` requires at least one employee with status "ready" for the target month. Demo seed has admin and one employee but no time entries guaranteed.
   - What's unclear: Whether any seeded month has enough data to close.
   - Recommendation: E2E-05 test should pick a clearly past month (e.g., January of last year), assert the month shows "no employees ready" if no data, OR pre-seed a completed time entry via API before running the close action. Alternatively, test the Monatsabschluss UI navigation and status display without actually triggering close (read-only assertion of already-closed months).

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Playwright 1.58.2 |
| Config file | `apps/e2e/playwright.config.ts` |
| Quick run command | `pnpm --filter e2e test --project=desktop-chrome tests/core-flows.spec.ts` |
| Full suite command | `pnpm --filter e2e test` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| E2E-01 | Login → clock-in → assert running state | E2E | `pnpm --filter e2e test tests/core-flows.spec.ts` | Yes (scaffold) |
| E2E-02 | Time entry CRUD + locked-month rejection | E2E | `pnpm --filter e2e test tests/time-entries-flow.spec.ts` | Yes (scaffold) |
| E2E-03 | Leave request → approval → calendar | E2E | `pnpm --filter e2e test tests/leave-flow.spec.ts` | Yes (scaffold) |
| E2E-04 | Admin employee management | E2E | `pnpm --filter e2e test tests/admin-settings-flow.spec.ts` | Yes (scaffold) |
| E2E-05 | Monatsabschluss lock/unlock | E2E | `pnpm --filter e2e test tests/admin-settings-flow.spec.ts` | Yes (scaffold) |
| UI-01 | 390px viewport, 44px touch targets | E2E | `pnpm --filter e2e test tests/mobile-flow.spec.ts tests/ux-design-audit.spec.ts` | Yes (wrong values) |
| UI-02 | German locked-month message in frontend | E2E | `pnpm --filter e2e test tests/time-entries-flow.spec.ts` | Partial (no locked-month test) |
| UI-03 | Audit tests fail CI on critical violations | E2E | `pnpm --filter e2e test tests/ui-quality.spec.ts tests/ux-design-audit.spec.ts` | Yes (soft only) |
| UI-04 | Buttons reachable ≤ 2 clicks, loading states | E2E | `pnpm --filter e2e test tests/error-handling-flow.spec.ts` | Yes (partial) |
| UI-05 | Password policy save persists | E2E | `pnpm --filter e2e test tests/admin-settings-flow.spec.ts` | Partial (no save assertion) |

### Sampling Rate
- **Per task commit:** `pnpm --filter e2e test --project=desktop-chrome tests/{modified}.spec.ts`
- **Per wave merge:** `pnpm --filter e2e test --project=desktop-chrome`
- **Phase gate:** Full suite green (`pnpm --filter e2e test`) before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] Baseline mobile overflow check: run `mobile-flow.spec.ts` at current 375px to identify failing routes before changing to 390px
- [ ] Confirm self-approval behavior: verify via API whether admin can approve leave they created on behalf of another employee
- [ ] Confirm E2E-05 data state: query which months have closeable employees in the seeded dataset

*(No new test files needed — all existing files require modification, not creation)*

---

## Project Constraints (from CLAUDE.md)

- **No hard deletes:** Time entries, leave requests, absences use soft delete. E2E delete tests must assert `deletedAt` is set (via API) or that the entry disappears from UI (soft delete, still in DB).
- **Audit trail:** Every mutating operation must write AuditLog. E2E delete/create tests may observe this as a side effect but are not required to assert it (that is covered in Phase 2 SEC-03 tests).
- **isLocked enforcement:** Locked months are immutable. API returns HTTP 403 for edits/deletes. Frontend MUST surface a specific German message — this is the UI-02 requirement.
- **German UI strings:** All user-facing text in German. The locked-month message "Monat ist gesperrt" follows this convention.
- **Docker for dev:** E2E tests must run against a Docker-started app (`docker compose up -d`), not `pnpm dev`.
- **Svelte 5 runes:** Any frontend code changes must use `$state`, `$derived`, `$effect` — no Svelte 4 `$:` reactive statements.
- **ApiError duck-typing:** `ApiError` is not exported from `client.ts`. Use `(e as any)?.status` for status code checks.
- **SvelteKit path aliases:** Use `$api`, `$stores` for imports — not relative paths.
- **Soft delete convention:** All `deletedAt: null` guards are in the API. Frontend E2E tests can assert item disappears from list after soft-delete without worrying about DB state.
- **Multi-tenancy:** Admin storageState is scoped to the seeded tenant. All API calls are tenant-scoped automatically via JWT. No cross-tenant concern in E2E tests.

---

## Sources

### Primary (HIGH confidence)
- Live code inspection — `apps/e2e/playwright.config.ts`, `auth.setup.ts`, `helpers.ts`, all 12 spec files
- Live code inspection — `apps/web/src/routes/(app)/time-entries/+page.svelte` (saveEntry, deleteEntry, error handling)
- Live code inspection — `apps/web/src/routes/(app)/dashboard/+page.svelte` (handleClock, clockedIn state, .clock-btn--in/out)
- Live code inspection — `apps/web/src/routes/(app)/admin/system/+page.svelte` (savePasswordPolicy function, PUT /settings/security call)
- Live code inspection — `apps/web/src/routes/(app)/admin/monatsabschluss/+page.svelte` (closeMonth function, status types)
- Live code inspection — `apps/api/src/routes/time-entries.ts` (isLocked → 403 responses on PUT/DELETE)
- Live code inspection — `apps/api/src/routes/settings.ts` (GET/PUT /settings/security endpoint, Zod schema)
- Live code inspection — `apps/api/src/routes/leave.ts` (self-approval block at line 505)
- Live code inspection — `packages/db/src/seed.ts` (admin@clokr.de + max@clokr.de only, no manager)
- `playwright-core@1.58.2` device descriptors — `"iPhone 14"`: 390×664px, isMobile:true, hasTouch:true, deviceScaleFactor:3

### Secondary (MEDIUM confidence)
- `apps/web/src/lib/api/client.ts` — ApiError class structure (status, message, data); confirmed not exported

### Tertiary (LOW confidence)
- None — all critical findings are from direct code inspection

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — Playwright 1.58.2 confirmed installed, device presets verified from installed package
- Architecture: HIGH — all spec files and frontend code read directly
- Pitfalls: HIGH — self-approval block confirmed in API source; ApiError export confirmed absent; seed data confirmed; mobile spec viewport confirmed at 375px

**Research date:** 2026-03-31
**Valid until:** 2026-04-30 (stable stack, no fast-moving dependencies in this phase)
