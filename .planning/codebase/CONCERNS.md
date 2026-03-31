# Codebase Concerns

**Analysis Date:** 2026-03-30

## Tech Debt

### Saldo Calculation Performance (Critical — Issue #6)

**Issue:** Saldo is recalculated from hire date on every GET request to `/api/v1/overtime/:employeeId`. This does not scale for employees with multi-year histories or high-traffic systems.

**Files:**

- `apps/api/src/routes/overtime.ts` (lines 28-76)
- `apps/api/src/routes/time-entries.ts` (updateOvertimeAccount function)

**Impact:**

- Database queries scale linearly with employee tenure (multiple queries per request)
- Blocks UI on every overtime saldo read
- Will cause performance degradation as data accumulates
- Cannot reliably handle > 500 employees without caching layer

**Fix approach:**
Implement snapshot-based calculation (see CLAUDE.md architecture):

1. Create monthly `SaldoSnapshot` records that freeze worked/expected/balance/carryOver
2. Current saldo = last snapshot carryOver + entries since snapshot date
3. Implement `recalculateSnapshots` function (partially complete at `apps/api/src/utils/recalculate-snapshots.ts`)
4. Trigger snapshots on month close or programmatically via cron
5. Replace recalculation loop with snapshot lookup

### Shared Test Database (Medium Priority)

**Issue:** All tests use the same development database (`TODO: separate test DB for CI`).

**Files:** `apps/api/src/__tests__/setup.ts` (line 4)

**Impact:**

- Test isolation failures if cleanup is incomplete
- CI/CD pipeline blocked if tests leave orphaned data
- Difficult to debug test failures caused by previous test runs
- No parallel test execution possible

**Fix approach:**

1. Add `PG_TEST_URL` environment variable pointing to isolated test database
2. Implement database cloning or per-test schema isolation
3. Enable test parallelization with vitest workers
4. Ensure cleanup runs even on test failure (use finally blocks)

### Fire-and-Forget Operations Without Monitoring

**Issue:** Multiple async operations fail silently with `.catch(() => {})` and no logging.

**Files:**

- `apps/api/src/middleware/auth.ts` (line 42) — API key lastUsedAt update
- `apps/api/src/routes/time-entries.ts` (line 200) — NFC card lastUsedAt update
- `apps/api/src/routes/overtime.ts` (line 36) — Overtime account recalculation
- `apps/api/src/routes/terminals.ts` (line 110) — Terminal API key lastUsedAt update

**Impact:**

- Silent failures make troubleshooting difficult
- Metrics and audit trails become unreliable
- Missing operations (like lastUsedAt) won't be detected
- Could hide database connection issues

**Fix approach:**
Replace `.catch(() => {})` with proper error handling:

```typescript
// Bad
.catch(() => {});

// Good
.catch((err) => app.log.error({ err }, "Operation failed: lastUsedAt update"));
```

## Known Bugs

### Timezone Handling Edge Cases (Medium Priority)

**Issue:** Date conversions between UTC and tenant timezone may have off-by-one errors at midnight boundaries.

**Files:**

- `apps/api/src/utils/timezone.ts` (dateStrInTz, monthRangeUtc functions)
- `apps/api/src/utils/arbzg.ts` (line 35, date range queries)

**Symptoms:**

- Work entries on last day of month sometimes not included in snapshot calculations
- ArbZG checks may miss entries on month boundaries
- Daylight saving time transitions could cause off-by-one shifts

**Trigger:**

- Tests at exactly 00:00 UTC in different timezones
- Month-end time entry reports
- Countries with non-standard DST rules

**Workaround:** Always add 1 day buffer when querying month ranges; use `lte: monthEnd + 1 day` pattern

## Security Considerations

### SMTP Password Storage and Decryption (Medium Risk)

**Issue:** SMTP passwords stored in TenantConfig are encrypted but the decryption function (`decryptSafe`) silently returns null on errors.

**Files:**

- `apps/api/src/plugins/mailer.ts` (line 60)
- `apps/api/src/utils/crypto.ts` (decryptSafe implementation)

**Risk:**

- If encryption key is rotated or corrupted, password recovery fails silently
- Emails fail without alerting admins
- No audit trail of why decryption failed
- Sensitive migration from plaintext to encrypted may go unnoticed if failures occur

**Current mitigation:**

- Fallback to environment variables if DB config missing
- Email send failures are caught and logged per send attempt

**Recommendations:**

1. Log decryption failures with context (tenantId, timestamp)
2. Add health check for SMTP config validity
3. Implement password rotation mechanism with audit trail
4. Test encryption key availability on app startup

### API Key Hash Verification (Low Risk - Good Implementation)

**Status:** Properly implemented in `apps/api/src/middleware/auth.ts` (lines 23-62).

- Keys stored as SHA256 hashes
- Raw key never logged or stored
- Revocation support via `revokedAt` timestamp
- Expiration support with validation
- Scopes attached for granular access control

### Password Policy Configuration Missing in UI (Medium Risk)

**Issue:** TenantConfig has password policy fields (minLength, requireUpper/Lower/Digit/Special) but no UI to edit them.

**Files:**

- `packages/db/prisma/schema.prisma` (lines 67-72)
- `apps/web/src/routes/(app)/settings/+page.svelte` — policy editing not found

**Impact:**

- Admins cannot enforce password complexity requirements
- Default policy (12 chars, upper+lower+digit+special) always applies
- Cannot adjust for regulatory requirements per tenant

**Fix approach:**
Add password policy form to admin settings page with real-time validation feedback

## Performance Bottlenecks

### Snapshot Recalculation Loop (Medium Impact)

**Issue:** `recalculateSnapshots` function issues one query per snapshot month when calculating expected minutes.

**Files:** `apps/api/src/utils/recalculate-snapshots.ts` (lines 64-144)

**Problem:**

- Line 77: `getEffectiveSchedule(app, employeeId, midMonth)` — called per snapshot
- Lines 104-109: Holiday query per snapshot
- Lines 116-123: Leave request query per snapshot
- Total: 3-4 queries × number of affected months

**Current capacity:**

- Manageable for single month corrections (1-5 snapshots)
- Becomes slow for retroactive year-long recalculations (12-36 queries)

**Improvement path:**

1. Batch-load all holidays and leave for the affected date range
2. Cache effective schedule per employee (rarely changes)
3. Single query for all snapshots, transform in memory

### Leave Request List Query Overhead (Low-Medium)

**Issue:** Leave routes call `leaveRequest.findMany()` multiple times per request for filtering and calculations.

**Files:** `apps/api/src/routes/leave.ts` (1516 lines — very large file)

**Observed pattern:** Multiple separate queries for:

- PENDING leave requests
- APPROVED leave requests by date range
- Cancellation requests

**Impact:**

- Visible as "query time" in slow endpoint logs
- Affects tenants with 500+ leave requests per month

**Safe optimization:** Add select clause to include only needed fields, reduce cursor fetches

## Fragile Areas

### Large Monolithic Endpoint Files (Design Concern)

**Files:**

- `apps/api/src/routes/leave.ts` (1516 lines)
- `apps/api/src/routes/time-entries.ts` (1369 lines)
- `apps/api/src/routes/overtime.ts` (988 lines)

**Why fragile:**

- Difficult to test individual business logic without full HTTP setup
- Changes to one endpoint risk breaking others in same file
- Circular dependencies between functions (updateOvertimeAccount imported by overtime route)
- Hard to reuse logic across routes

**Safe modification:**

- Extract business logic to `services/` directory
- Create unit-testable functions separate from Fastify route handlers
- Use dependency injection for Prisma and logging

### Date Range Calculations in Multiple Places (Consistency Risk)

**Files:**

- `apps/api/src/utils/timezone.ts` (dateStrInTz, monthRangeUtc)
- `apps/api/src/utils/arbzg.ts` (date queries)
- `apps/api/src/utils/recalculate-snapshots.ts` (month boundaries)
- `apps/api/src/routes/leave.ts` (leave period logic)

**Why fragile:**

- No single source of truth for "month in tenant timezone"
- Easy to miss edge case when adding new date logic
- Tests don't cover all timezone/DST combinations

**Test coverage gaps:**

- December 31 → January 1 transitions (timezone-aware)
- Daylight saving time transitions (spring/fall)
- Leap year February boundaries
- Employees hired/fired on month boundaries

**Safe modification:**

1. Create `DateRange` value object with encapsulated logic
2. Write property-based tests for all date boundary conditions
3. Add timezone assertion tests for Berlin, UTC, and other zones

## Scaling Limits

### Saldo Snapshot Recalculation at Month Close (High Impact)

**Current implementation:** Auto-close-month plugin runs on every day at midnight.

**Files:** `apps/api/src/plugins/auto-close-month.ts` (469 lines)

**Capacity:**

- Current: Handles 100 employees with 12 months = 1200 snapshot updates per month
- Bottleneck: 4+ database queries per snapshot × 1200 = 4800+ queries

**Scaling path:**

1. Implement batch snapshot calculation (insert/update many)
2. Use Prisma transaction for atomicity
3. Add progress logging and recovery checkpoints
4. Consider async job queue if > 1000 employees

### Concurrent Time Entry Writes (Medium Priority)

**Issue:** No optimistic locking on time entries. Multiple concurrent edits could overwrite data.

**Files:** `apps/api/src/routes/time-entries.ts` (POST/PUT handlers)

**Potential race:**

1. Employee opens time entry edit at 10:00
2. Manager approves corrections at 10:05
3. Employee saves edit at 10:10 — overwrites manager's correction

**Current safeguard:** `isLocked` flag prevents edits after month close, but not concurrent edits in same month

**Safe fix:**

- Add `version` field to TimeEntry
- Implement optimistic locking in update handler
- Return 409 Conflict if version mismatch

## Dependencies at Risk

### Node.js CVE-2025-69262 / CVE-2025-69263 (Documented)

**Status:** Already documented in `.trivyignore`

**Risk:** pnpm package manager (build-time only, not runtime)

**Mitigation:** CVEs are in corepack pnpm declaration; runtime pnpm v10.33.0 is not affected

**Revisit:** When pnpm publishes final patch or Trivy updates detection

## Missing Critical Features

### Separate Test Database for CI/CD

**Blocking:** Reliable test execution in CI pipelines

**Workaround:** Sequential test execution only; cannot parallelize

**Implementation burden:** Medium (Docker Compose update, env var configuration)

### Password Policy UI

**Blocking:** Admins cannot enforce corporate password requirements

**Current state:** Configuration exists in database but no UI to manage it

**Implementation burden:** Low (single form component)

## Test Coverage Gaps

### Timezone-Aware Date Boundary Tests (High Risk)

**What's not tested:**

- Month close at UTC vs. tenant timezone boundary mismatches
- DST transitions (last Sunday of March/October)
- Holiday calculation across timezone boundaries
- Leave spanning timezone day boundaries

**Files:**

- `apps/api/src/utils/__tests__/timezone.test.ts` — minimal coverage
- `apps/api/src/__tests__/saldo-snapshot.test.ts` — no timezone variant tests

**Risk:** Silent saldo calculation errors discovered only in production

**Priority:** High — affects audit-proof data integrity

### ArbZG Compliance Edge Cases (High Risk)

**What's not tested:**

- Weekly maximum with employee on different shift schedules
- Rest period minimum when crossing timezone midnight
- Break calculation with irregular shift lengths
- Multiple time entries on same day with various gap patterns

**Files:** `apps/api/src/utils/__tests__/arbzg.test.ts` — does not exist

**Risk:** Violations slip through undetected

**Priority:** High — legal compliance

### Leave Carry-Over Cross-Year Booking (Medium Risk)

**What's not tested:**

- Advance booking into next year with calculated carry-over
- Partial year booking with pro-rata vacation
- Carry-over expiry deadline enforcement
- Multiple leave type cross-year scenarios

**Files:** `apps/api/src/__tests__/leave.test.ts` (425 lines) — covers basic flow, not edge cases

**Risk:** Employees lose vacation entitlements undetected

**Priority:** Medium — regulatory and morale impact

---

_Concerns audit: 2026-03-30_
