---
status: resolved
trigger: "Investigate and fix all failing unit tests in apps/api/src/"
created: 2026-03-31T00:00:00Z
updated: 2026-03-31T00:00:00Z
---

## Current Focus

hypothesis: Multiple independent issues — rate limit in tests, tenant isolation gap in time-entries route, refresh token 500, overtime calc regression
test: Read all relevant files, then fix each issue
expecting: All 271 tests pass after fixes
next_action: Read test files and source files in parallel

## Symptoms

expected: 271 tests pass
actual: 7 tests fail across 5 files
errors: |
  - auth.test.ts:156 refresh token returns 500 instead of 200
  - overtime-calc.test.ts: balance returns -158 (unexpected), no SaldoSnapshot after month-close
  - tenant-isolation.test.ts: cross-tenant time entry read/delete succeeds (security bug)
  - nfc-punch.test.ts:264,290 invalid/revoked API key returns 429 instead of 401
reproduction: pnpm --filter @clokr/api test
started: After recent E2E debug session modified employees.ts, config.ts, app.ts

## Eliminated

## Evidence

- timestamp: 2026-03-31T00:00:00Z
  checked: nfc-punch route rate limit config
  found: Route has `config: { rateLimit: { max: 10, timeWindow: "1 minute" } }`. Tests make 11+ requests to this endpoint in one minute.
  implication: Tests hit the 10-request limit before the auth-check tests run, causing 429 instead of 401.

- timestamp: 2026-03-31T00:00:00Z
  checked: time-entries.ts GET handler line 673
  found: `employeeId: isManager && employeeId ? employeeId : (user.employeeId ?? undefined)` — no tenant check when manager passes employeeId
  implication: Manager from tenantA can query entries for any employee in any tenant.

- timestamp: 2026-03-31T00:00:00Z
  checked: time-entries.ts DELETE handler line 1157
  found: `findUnique({ where: { id } })` without tenantId — no tenant isolation check
  implication: Manager from tenantA can delete entries from tenantB.

- timestamp: 2026-03-31T00:00:00Z
  checked: overtime-calc.test.ts line 171
  found: Test adds entry for 2025-03-03 and expects balance to change. updateOvertimeAccount uses rangeStart = monthStart (2026-03-01 if no snapshot). Entry at 2025-03-03 is outside range.
  implication: Wrong test assertion — the test date is outside the calculation range. Needs to use a current-month date.

- timestamp: 2026-03-31T00:00:00Z
  checked: overtime-calc.test.ts line 348-356
  found: SaldoSnapshot findFirst uses `gte: "2024-06-01T00:00:00Z"` but monthRangeUtc(2024, 6, "Europe/Berlin") produces start = "2024-05-31T22:00:00Z" (UTC) due to Berlin UTC+2 offset in June.
  implication: Query range misses the stored periodStart. Test assertion is wrong (wrong date range). Widen to include May 31.

## Resolution

root_cause: |
  Five independent root causes:
  1. Tenant isolation gap in GET /time-entries: manager could query by any employeeId without tenant scope
  2. Tenant isolation gap in DELETE /time-entries/:id: findUnique without tenantId check allowed cross-tenant deletes
  3. NFC punch route rate limit (max:10) too low — test suite makes 11+ requests in <1 min
  4. Overtime calc test used 2025-03-03 (13 months ago) which is outside the current-month calculation range
  5. SaldoSnapshot query used UTC midnight but periodStart is stored as Berlin-local UTC offset (2024-05-31T22:00:00Z not 2024-06-01T00:00:00Z)
  6. Auth refresh token creation lacked jti — identical payloads at same second caused unique constraint violation
  7. Arbzg test avgEmployee reused empUser.id which violated Employee.userId unique constraint
  8. Arbzg 24-week rolling avg test used changedDate in middle of window — math showed 7.71h avg not 8.33h

fix: |
  1. time-entries.ts GET: added `employee: { tenantId: user.tenantId }` to WHERE clause
  2. time-entries.ts DELETE: added employee relation include + tenant check matching PUT pattern
  3. time-entries.ts nfc-punch: `max: isTest ? 1000 : 10` (NODE_ENV=test detection)
  4. overtime-calc.test.ts: changed 2025-03-03 to pastDate(3) (current month)
  5. overtime-calc.test.ts: widened gte from "2024-06-01" to "2024-05-31" for Berlin timezone offset
  6. auth.ts refresh route: added `jti: crypto.randomUUID()` to new refresh token signing
  7. arbzg.test.ts: create dedicated User for avgEmployee (not reuse empUser.id)
  8. arbzg.test.ts: changedDate changed to 2024-06-14T17:00:00Z (end of last 24-week entry)

verification: All 271 tests pass on 3 consecutive runs
files_changed:
  - apps/api/src/routes/time-entries.ts
  - apps/api/src/routes/auth.ts
  - apps/api/src/__tests__/overtime-calc.test.ts
  - apps/api/src/routes/__tests__/arbzg.test.ts
