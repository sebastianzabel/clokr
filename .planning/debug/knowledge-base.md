# GSD Debug Knowledge Base

Resolved debug sessions. Used by `gsd-debugger` to surface known-pattern hypotheses at the start of new investigations.

---

## unit-test-fixes — 7 unit test failures across 5 files after E2E debug session changes
- **Date:** 2026-03-31
- **Error patterns:** tenant isolation, cross-tenant, 429 rate limit, 401, overtime balance -158, SaldoSnapshot null, unique constraint, jti, refresh token, arbzg, rolling average
- **Root cause:** Five independent root causes: (1) GET /time-entries lacked employee.tenantId filter allowing cross-tenant reads; (2) DELETE /time-entries/:id had no tenant check; (3) NFC punch route max:10 rate limit hit by 11+ test requests; (4) Auth refresh token missing jti caused unique constraint collisions; (5) Test assertions used dates outside calculation range (2025-03-03 for overtime in 2026, UTC midnight for Berlin UTC+2 SaldoSnapshot); also arbzg test reused empUser.id violating Employee.userId unique constraint, and used mid-window changedDate yielding 7.71h avg instead of 8.33h.
- **Fix:** time-entries.ts GET: add employee.tenantId filter; DELETE: include employee relation + tenant check; nfc-punch: isTest ? 1000 : 10 rate limit; auth.ts refresh: add jti to new refresh token; overtime-calc.test: use pastDate(3) and widen SaldoSnapshot query to gte:"2024-05-31"; arbzg.test: create dedicated user for avgEmployee and set changedDate to 2024-06-14T17:00:00Z.
- **Files changed:** apps/api/src/routes/time-entries.ts, apps/api/src/routes/auth.ts, apps/api/src/__tests__/overtime-calc.test.ts, apps/api/src/routes/__tests__/arbzg.test.ts
---

## e2e-test-fixes — E2E Playwright 135 desktop-chrome tests failing (0 failures after fix)
- **Date:** 2026-03-31
- **Error patterns:** SecurityError, about:blank, storageState, rate limit, 429, networkidle, PUT intercept, POST intercept, nested label, aria-label, min-height, touch target, mobile overflow, table-wrap, notification poller, monatsabschluss, modal timeout, waitForLoadState hung
- **Root cause:** Ten distinct issues: (1) SecurityError from localStorage access before navigation in unauthenticated tests — fixed with nested describe + test.use storageState; (2) clock-in test missing networkidle wait; (3) missing a11y labels on vacation/time-entries inputs causing axe-core failures; (4) mobile overflow from missing .table-wrap CSS; (5) buttons under 44px WCAG 2.5.5 touch target; (6) time-entries locked-month test intercepted PUT but openAdd() always issues POST for new entries; (7) rate limit 500/min exhausted in full suite by 100+ rapid API calls in admin-settings-flow before core-flows clock-in test; (8) dynamic-audit "no console errors" filter did not cover JS-level "Rate limit exceeded" strings from notification poller; (9) create-employee modal 10s timeout too short when running after many prior tests; (10) monatsabschluss test used waitForLoadState("networkidle") which hung indefinitely because layout notification poller fires on mount
- **Fix:** Add RATE_LIMIT_MAX env var (default 500, set to 10000 in docker-compose); re-fetch employee after create in employees.ts; fix a11y labels in vacation and time-entries pages; raise all button min-heights to 44px in app.css; fix mobile overflow; extend dynamic-audit console error filter; increase admin-settings timeouts; redesign monatsabschluss test with domcontentloaded + content-based waits; fix auth.spec.ts unauthenticated context; fix time-entries intercept to cover POST and PUT
- **Files changed:** apps/e2e/tests/auth.spec.ts, apps/e2e/tests/core-flows.spec.ts, apps/e2e/tests/time-entries-flow.spec.ts, apps/e2e/tests/admin-settings-flow.spec.ts, apps/e2e/tests/leave-flow.spec.ts, apps/e2e/tests/dynamic-audit.spec.ts, apps/e2e/tests/error-handling-flow.spec.ts, apps/e2e/tests/helpers.ts, apps/e2e/tests/ux-quality.spec.ts, apps/e2e/tests/ui-audit.spec.ts, apps/web/src/routes/(app)/admin/vacation/+page.svelte, apps/web/src/routes/(app)/time-entries/+page.svelte, apps/web/src/routes/(app)/dashboard/+page.svelte, apps/web/src/routes/(app)/leave/+page.svelte, apps/web/src/app.css, apps/web/src/lib/api/client.ts, apps/web/src/routes/(app)/+layout.svelte, apps/web/src/routes/(app)/admin/system/+page.svelte, apps/api/src/routes/employees.ts, apps/api/src/config.ts, apps/api/src/app.ts, docker-compose.yml
---

