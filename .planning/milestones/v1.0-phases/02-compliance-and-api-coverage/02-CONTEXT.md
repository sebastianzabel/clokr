# Phase 2: Compliance and API Coverage - Context

**Gathered:** 2026-03-30
**Status:** Ready for planning

<domain>
## Phase Boundary

Write compliance tests for all legally-critical business rules (ArbZG, tenant isolation, audit trail, soft deletes, timezone/DST), comprehensive API test coverage for every domain (time entries, leave, overtime, auth, DSGVO anonymization, NFC), fix confirmed code defects (self-host Google Fonts for DSGVO Art. 44), and address the decryptSafe plaintext migration. When tests discover bugs, fix them inline.

</domain>

<decisions>
## Implementation Decisions

### Bug Handling
- **D-01:** Fix bugs inline — write the test, fix the bug, commit together. Tests verify the fix exists.
- **D-02:** Open a GitHub issue for every production bug found during testing, reference it in the commit message.
- **D-03:** Fix the ArbZG rolling average if it's wrong — this is a legal compliance bug, not deferrable.
- **D-04:** Address the decryptSafe migration state in Phase 2 — query DB, write test asserting all SMTP passwords are encrypted, migrate any plaintext found.

### Test Organization
- **D-05:** Extend existing test files (auth.test.ts, leave.test.ts, time-entries.test.ts, etc.) with compliance-specific describe blocks. Do not create separate compliance files. **Exception (user-approved 2026-03-30):** `tenant-isolation.test.ts` and `audit-trail.test.ts` MAY be created as standalone files — these cross-cutting concerns test 6 resource types × 2 tenants and 15 route files respectively, making embedding in a single existing file architecturally unsound.
- **D-06:** Test tenant isolation (SEC-02) for every resource type: TimeEntry, LeaveRequest, Employee, Absence, OvertimeAccount, AuditLog. Cross-tenant reads AND writes must return 403/404.

### Font Self-Hosting (AUDIT-02)
- **D-07:** Download WOFF2 font files for Jost (300-700), DM Sans (300-700), and Fraunces (300, 400, 600) to `apps/web/static/fonts/`.
- **D-08:** Write local `@font-face` declarations replacing the Google Fonts `@import` in `app.css`.
- **D-09:** Remove `https://fonts.googleapis.com` from CSP `style-src` in `hooks.server.ts`. Eliminate all external Google domain requests.
- **D-10:** Keep all declared weight variants — do not trim.

### ArbZG Edge Cases
- **D-11:** Comprehensive boundary testing at exact thresholds: 10h00 vs 10h01 (§3 daily), 6h00 vs 6h01 (§4 break threshold), exactly 11h rest (§5), 48h weekly cap.
- **D-12:** Test 24-week rolling average with realistic synthetic data — generate 24+ weeks of time entries simulating a real employee. Verify that a 4-day/39h week is legal, exceeding the average triggers a warning.
- **D-13:** All 4 DST/timezone scenarios must be tested: spring forward (March CET→CEST), fall back (October CEST→CET), cross-midnight shifts (22:00–06:00), year boundary (Dec 31→Jan 1 for Monatsabschluss/carry-over/saldo).

### Claude's Discretion
- Test grouping/tagging strategy — Claude decides if compliance tests get a naming convention for filtering
- Exact test data seeding approach for multi-week ArbZG scenarios
- decryptSafe migration implementation details
- Additional edge cases beyond the specified boundaries

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### ArbZG Implementation
- `apps/api/src/utils/arbzg.ts` — ArbZG compliance check implementation (verify rolling average logic)
- `apps/api/src/routes/__tests__/arbzg.test.ts` — Existing ArbZG tests to extend
- `CLAUDE.md` §ArbZG — Defines the legal rules and the critical note that 8h is an AVERAGE, not a daily limit

### Audit Trail
- `apps/api/src/plugins/audit.ts` — Audit plugin (app.audit() decorator)
- `apps/api/src/routes/audit-logs.ts` — Audit log query routes

### Soft Delete & Tenant Isolation
- `apps/api/src/routes/time-entries.ts` — Time entry CRUD with deletedAt handling
- `apps/api/src/routes/leave.ts` — Leave request lifecycle with soft delete
- `apps/api/src/middleware/auth.ts` — Auth middleware with tenantId extraction

### Existing Tests to Extend
- `apps/api/src/__tests__/auth.test.ts` — Auth flow tests
- `apps/api/src/__tests__/leave.test.ts` — Leave lifecycle tests
- `apps/api/src/__tests__/time-entries.test.ts` — Time entry CRUD tests
- `apps/api/src/__tests__/overtime-calc.test.ts` — Overtime/saldo tests
- `apps/api/src/__tests__/employees.test.ts` — Employee management tests

### Font Hosting
- `apps/web/src/app.css` — Current Google Fonts @import (line 1)
- `apps/web/src/hooks.server.ts` — CSP headers with Google Fonts domain (line 70)

### Known Issues
- `.planning/codebase/CONCERNS.md` — Tech debt details including decryptSafe state
- `.planning/STATE.md` — Blockers: ArbZG rolling average confirmation, decryptSafe migration state

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `apps/api/src/__tests__/setup.ts` — Test lifecycle (app instance, seeding, cleanup) with ?schema=test isolation
- `apps/api/vitest.setup.ts` — Global setup overriding DATABASE_URL for test schema
- Existing test patterns: `app.inject()` for route-level integration, `seedTestData()` for fixtures
- `apps/api/src/utils/arbzg.ts` — ArbZG compliance functions to test and potentially fix

### Established Patterns
- Tests use `app.inject()` with JWT tokens for authenticated requests
- `seedTestData()` creates admin/manager/employee users with schedules
- `cleanupTestData()` in afterAll with try/catch (from Phase 1)
- Prisma client accessed via `app.prisma` in test context
- Vitest with `fileParallelism: false`, coverage thresholds enforced

### Integration Points
- All mutating routes must produce AuditLog entries — test via `app.prisma.auditLog.findMany()`
- Tenant isolation enforced via `req.user.tenantId` in every route query
- Soft deletes use `deletedAt: null` filter in WHERE clauses
- Month locking via `isLocked` flag prevents edits — test immutability

</code_context>

<specifics>
## Specific Ideas

- ArbZG 24-week average test: simulate a 4-day workweek with 39h (9.75h/day) — this must be LEGAL per §3
- Tenant isolation: create two tenants, attempt cross-access on every resource type
- Audit trail: assert every POST/PUT/DELETE endpoint produces an AuditLog row with userId, timestamp, old/new values
- Font migration: WOFF2 only (modern browsers), no WOFF1 fallback needed

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 02-compliance-and-api-coverage*
*Context gathered: 2026-03-30*
