# Phase 3: E2E and UI Quality - Context

**Gathered:** 2026-03-31 (assumptions mode)
**Status:** Ready for planning

<domain>
## Phase Boundary

Critical user flows have E2E test coverage and the UI is usable on mobile with consistent design and German error messages.

Scope: E2E tests for 5 flows (E2E-01–E2E-05), mobile responsiveness at 390px/44px (UI-01), German locked-month error message (UI-02), design audit hardening (UI-03), UX flow improvements (UI-04), password policy E2E test (UI-05).

Out of scope: New features, API changes (except the locked-month frontend message if needed).

</domain>

<decisions>
## Implementation Decisions

### E2E Test Coverage (E2E-01 through E2E-05)

- **D-01:** All 5 required flows need substantive new test bodies. Existing files (core-flows.spec.ts, time-entries-flow.spec.ts, leave-flow.spec.ts, admin-settings-flow.spec.ts) have scaffold/smoke structure but do NOT assert action completion (state changes, persistence, approval results). Write flows in existing files or replace their bodies — do not create new files.
- **D-02:** Use the existing storageState admin auth from `apps/e2e/tests/auth.setup.ts`. The clock-in/out flow (E2E-01) must click the clock button and assert the resulting state change (timer running or entry created).
- **D-03:** Leave approval flow (E2E-03) must exercise the employee-creates → manager-approves path. Since only admin storageState exists, use a second Playwright worker with admin acting as approver, or create a manager storageState if needed.
- **D-04:** Monatsabschluss flow (E2E-05) must click the close-month action and assert `isLocked: true` via API or UI state, not just navigate to the page.

### Mobile Responsiveness (UI-01)

- **D-05:** Target viewport is 390px (iPhone 14/15 — matches Playwright's built-in `iPhone 14` device preset). Update `mobile-flow.spec.ts` from its current 375px to 390px using the named device preset.
- **D-06:** Touch target assertion threshold must be ≥ 44px (CSS logical pixels via `boundingBox().height`). Update `ux-design-audit.spec.ts` from its current 32px threshold to 44px.
- **D-07:** If component-level CSS causes horizontal scroll at 390px, add targeted `max-width: 100%; overflow-x: hidden` fixes per component — no global breakpoints needed (app.css has none by design).

### German Error Messages (UI-02)

- **D-08:** The "Monat ist gesperrt" (or equivalent: "Monat wurde abgeschlossen") message must appear in the frontend when a user attempts to edit/delete a time entry in a locked month. Grep confirms this message does NOT currently exist in apps/web/src. Add it to the time entry edit/delete error handler.
- **D-09:** Add an E2E assertion in time-entries-flow.spec.ts that verifies this message appears when attempting a locked-month mutation.
- **D-10:** All other German error messages (auth, validation) are confirmed present via existing tests — no changes needed for those.

### Password Policy Admin UI (UI-05)

- **D-11:** Password policy UI is already fully built in `apps/web/src/routes/(app)/admin/system/+page.svelte` (Passwort-Richtlinie section with min-length, uppercase/special-char toggles, savePasswordPolicy()). Only an E2E test is needed — verify the save action calls the API and settings persist.
- **D-12:** Before writing the E2E test, verify `savePasswordPolicy()` calls a valid API endpoint. If the endpoint is missing or broken, fix it as part of this plan.

### Design Consistency (UI-03)

- **D-13:** Convert existing audit tests from collector/log pattern to hard assertions. `ui-quality.spec.ts`, `ux-design-audit.spec.ts`, `visual-audit.spec.ts`, and `dynamic-audit.spec.ts` use `findings.push()` + `afterAll` logging — CI never fails on audit violations. Wire these to `expect(findings).toHaveLength(0)` or equivalent.
- **D-14:** Keep audit test scope to what's already measured (heading scale, button border-radius, color system, touch targets, overflow). Do not add new audit categories.

### UX Flow Improvements (UI-04)

- **D-15:** UI-04 is the most open-ended requirement. Scope it to: (a) verifying that critical action buttons (clock-in, save entry, submit leave) are reachable in ≤ 2 taps/clicks from the page they live on, and (b) ensuring loading states are shown during async operations. No broad UX redesign.

### Claude's Discretion

- Exact Playwright device preset string for iPhone 14 (check Playwright devices list)
- Whether to create a second storageState for manager role or reuse admin for leave approval
- Specific CSS properties to fix per-component for mobile overflow issues

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### E2E Infrastructure
- `apps/e2e/playwright.config.ts` — device presets, storageState wiring, project structure
- `apps/e2e/tests/auth.setup.ts` — auth setup that all tests depend on
- `apps/e2e/tests/helpers.ts` — shared test helpers

### Existing E2E Tests (need substantive updates)
- `apps/e2e/tests/core-flows.spec.ts` — currently page-load only
- `apps/e2e/tests/time-entries-flow.spec.ts` — partial E2E-02
- `apps/e2e/tests/leave-flow.spec.ts` — partial E2E-03
- `apps/e2e/tests/admin-settings-flow.spec.ts` — partial E2E-04, E2E-05
- `apps/e2e/tests/mobile-flow.spec.ts` — mobile E2E (wrong viewport: 375px → fix to 390px)

### Existing Audit Tests (need hardening)
- `apps/e2e/tests/ui-quality.spec.ts` — design audit with collector pattern
- `apps/e2e/tests/ux-design-audit.spec.ts` — UX audit (32px threshold → fix to 44px)
- `apps/e2e/tests/visual-audit.spec.ts` — visual consistency audit
- `apps/e2e/tests/dynamic-audit.spec.ts` — dynamic UI audit

### Password Policy
- `apps/web/src/routes/(app)/admin/system/+page.svelte` — existing UI (Passwort-Richtlinie section ~line 283)
- `apps/api/src/routes/` — check for password policy endpoint (grep for `password.*policy\|passwortRichtlinie`)

### Frontend Error Handling
- `apps/web/src/lib/api/client.ts` — ApiError class, how errors surface to UI
- `apps/web/src/routes/(app)/time-entries/+page.svelte` — where locked-month message must appear

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `apps/e2e/tests/helpers.ts` — shared login, navigation helpers for E2E tests
- `apps/e2e/tests/auth.setup.ts` — admin storageState, can extend for manager role
- Playwright config already wires `dependencies: ["setup"]` for all browser projects

### Established Patterns
- All E2E tests use `storageState: ".auth/admin.json"` — admin-only auth, no employee/manager states yet
- Audit tests use a `UIFinding[]` collector + `afterAll` log — needs migration to hard `expect`
- Error messages follow `toasts.error("German message")` pattern from `$stores/toast.ts`
- Locked-month API returns 403 — frontend must catch this and show "Monat ist gesperrt"

### Integration Points
- E2E tests hit the app via `http://localhost:5173` (or equivalent configured baseURL)
- `apps/e2e/playwright.config.ts` configures `webServer` — ensure it starts the app for tests
- Mobile tests use `page.setViewportSize()` or Playwright device presets

</code_context>

<specifics>
## Specific Ideas

- Use Playwright's built-in `iPhone 14` device descriptor (390×844) for UI-01 — avoids custom viewport objects
- Convert audit tests to fail CI: `expect(criticalFindings, criticalFindings.map(f => f.message).join('\n')).toHaveLength(0)`
- "Monat ist gesperrt" message should appear inline (near the save button) not just as a toast, so it's assertable via locator

</specifics>

<deferred>
## Deferred Ideas

- Visual regression testing (screenshot diffs) — separate phase or tool setup
- Employee and manager storageState for multi-role E2E — can be added if leave approval requires it, otherwise defer
- Accessibility audit hardening (accessibility.spec.ts exists but is out of scope for this phase's requirements)
- Performance/Lighthouse CI — future phase

None — analysis stayed within phase scope.

</deferred>

---

*Phase: 03-e2e-and-ui-quality*
*Context gathered: 2026-03-31*
