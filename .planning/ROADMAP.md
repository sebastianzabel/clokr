# Roadmap: Clokr — Production Readiness

## Overview

The app is feature-complete. This milestone pays the quality debt required before real customers can use it. Three phases drive the work: first establish a trustworthy test foundation (isolated DB, storageState, linting gates), then write legally-required compliance and API tests while fixing confirmed code defects, then audit and repair the UI for mobile usability and consistency. Nothing in any phase adds features — every phase makes what exists more reliable, more legally defensible, and more demonstrably correct.

## Phases

**Phase Numbering:**

- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Test Infrastructure** - Isolate test DB, wire storageState, enforce coverage thresholds and linting gates (completed 2026-03-30)
- [ ] **Phase 2: Compliance and API Coverage** - Write compliance tests for all legal-critical paths, fix confirmed code defects, self-host fonts
- [x] **Phase 3: E2E and UI Quality** - Cover critical user flows with E2E tests, fix mobile responsiveness, audit design consistency (completed 2026-03-31)

## Phase Details

### Phase 1: Test Infrastructure

**Goal**: Tests run against an isolated database with enforced coverage thresholds and blocking lint rules
**Depends on**: Nothing (first phase)
**Requirements**: TEST-01, TEST-02, TEST-03, TEST-04, AUDIT-01, AUDIT-03
**Success Criteria** (what must be TRUE):

1. Running the test suite writes zero rows to the dev database (TEST_DATABASE_URL in use)
2. `pnpm test` fails if coverage drops below enforced thresholds
3. Any floating promise in the codebase causes `pnpm lint` to fail with an error (not a warning)
4. Docker seed script completes without suppressed errors on pnpm@10 + Prisma 7
5. All `.catch(() => {})` patterns replaced with logged errors

**Plans**: 6 plans

Plans:

- [x] 01-01-PLAN.md — Replace silent .catch(() => {}) with app.log.error (AUDIT-01)
- [x] 01-02-PLAN.md — Fix Docker seed compilation for pnpm@10 + Prisma 7 (AUDIT-03)
- [x] 01-03-PLAN.md — Add Playwright storageState setup project (TEST-02)
- [x] 01-04-PLAN.md — Enable no-floating-promises as blocking ESLint error (TEST-04)
- [x] 01-05-PLAN.md — Isolate test DB via TEST_DATABASE_URL with ?schema=test (TEST-01)
- [x] 01-06-PLAN.md — Measure baseline coverage and enforce thresholds (TEST-03)

### Phase 2: Compliance and API Coverage

**Goal**: Every legally-critical business rule has automated test coverage and confirmed code defects are fixed
**Depends on**: Phase 1
**Requirements**: API-01, API-02, API-03, API-04, API-05, API-06, SEC-01, SEC-02, SEC-03, SEC-04, SEC-05, AUDIT-02
**Success Criteria** (what must be TRUE):

1. ArbZG rules (§3 daily max, §3 24-week average, §4 breaks, §5 rest period, cross-midnight, DST) each have a passing unit test
2. Cross-tenant read and write attempts return 403/404 (no data leakage between tenants)
3. Every mutating API endpoint (POST/PUT/DELETE) produces an AuditLog row — verified by test assertions
4. Soft-delete enforcement verified: DELETE sets deletedAt, queries filter it, locked-month entries are undeletable
5. Google Fonts CDN requests eliminated — fonts load from local static files, no external Google domains in CSP

**Plans**: 6 plans

Plans:
- [x] 02-01-PLAN.md — ArbZG 24-week rolling average fix + boundary and DST tests (SEC-01, SEC-05)
- [x] 02-02-PLAN.md — Tenant isolation and audit trail completeness tests (SEC-02, SEC-03)
- [x] 02-03-PLAN.md — Time entry CRUD, soft-delete, and locked-month tests (API-01, SEC-04)
- [x] 02-04-PLAN.md — Leave lifecycle and overtime/Monatsabschluss tests (API-02, API-03)
- [x] 02-05-PLAN.md — Auth flow, DSGVO anonymization, NFC punch, and decryptSafe tests (API-04, API-05, API-06)
- [x] 02-06-PLAN.md — Self-host Google Fonts for DSGVO Art. 44 compliance (AUDIT-02)

### Phase 3: E2E and UI Quality

**Goal**: Critical user flows have E2E test coverage and the UI is usable on mobile with consistent design and German error messages
**Depends on**: Phase 1
**Requirements**: E2E-01, E2E-02, E2E-03, E2E-04, E2E-05, UI-01, UI-02, UI-03, UI-04, UI-05
**Success Criteria** (what must be TRUE):

1. Login -> clock-in/out, time entry CRUD, leave approval, admin management, and Monatsabschluss flows each pass in Playwright
2. Every main view renders without horizontal scroll at 390px viewport width and all interactive elements meet 44px touch target size
3. Every form validation error and API failure shows a German-language message; locked-month edit attempts show a "Monat ist gesperrt" message
4. Password policy can be configured by an admin through the settings UI

**Plans**: 3 plans

Plans:
- [x] 03-01-PLAN.md — Clock-in/out E2E, time entry CRUD E2E, locked-month German error message (E2E-01, E2E-02, UI-02)
- [x] 03-02-PLAN.md — Leave approval E2E, admin employee E2E, Monatsabschluss E2E, password policy E2E (E2E-03, E2E-04, E2E-05, UI-05)
- [x] 03-03-PLAN.md — Mobile viewport iPhone 14 fix, touch target 44px, audit test hardening, UX reachability (UI-01, UI-03, UI-04)

## Progress

**Execution Order:**
Phases execute in numeric order: 1 -> 2 -> 3

| Phase                          | Plans Complete | Status      | Completed |
| ------------------------------ | -------------- | ----------- | --------- |
| 1. Test Infrastructure         | 6/6 | Complete   | 2026-03-30 |
| 2. Compliance and API Coverage | 1/6 | In Progress|  |
| 3. E2E and UI Quality          | 3/3 | Complete   | 2026-03-31 |
