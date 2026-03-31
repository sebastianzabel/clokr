# Project Retrospective

*A living document updated after each milestone. Lessons feed forward into future planning.*

## Milestone: v1.0 — Production Readiness

**Shipped:** 2026-03-31
**Phases:** 3 | **Plans:** 15 | **Commits:** ~95

### What Was Built

- Test infrastructure: isolated PostgreSQL test schema, Playwright storageState, Vitest coverage thresholds, no-floating-promises ESLint gate
- ArbZG §3 24-week rolling average compliance check — implemented the missing legal rule and validated with 26 boundary/DST tests
- Full API compliance test suite: tenant isolation, audit trail completeness, time entry CRUD, leave lifecycle (BUrlG cross-year), Monatsabschluss, auth/JWT, DSGVO anonymization, NFC punch
- DSGVO Art. 44: 8 WOFF2 font files self-hosted, Google Fonts CDN removed from CSP
- Playwright E2E coverage for 5 critical user flows: clock-in/out, time entries, leave approval, admin management, Monatsabschluss
- Mobile responsiveness fixed: iPhone 14 device preset (390px, isMobile, hasTouch), 44px WCAG touch targets enforced as hard CI failures

### What Worked

- Phase sequencing: test infrastructure first meant compliance tests and E2E could be written confidently in later phases
- gsd-tools vitest globalSetup pattern for DATABASE_URL override — ran before module import, ensuring test DB was active before buildApp()
- Using SICK leave for cancellation lifecycle tests — avoided VACATION entitlement conflicts without extra setup
- page.route() mocking for the locked-month E2E test — decoupled test from real DB state
- Hard CI-failing assertions in audit specs replaced silent console logging — made quality issues visible immediately

### What Was Inefficient

- Phase 2 progress tracker showed "In Progress" (1/6) instead of "Complete" (6/6) — progress table not updated during execution, required manual fix at milestone close
- "core-flows.spec.ts" extracted as an accomplishment from 03-01-SUMMARY.md — one_liner field was empty, extracting a filename instead of a description; required manual correction in MILESTONES.md
- No milestone audit (no `/gsd:audit-milestone`) run before completion — skipped in yolo mode; consider establishing a habit even in yolo mode for first-time milestones

### Patterns Established

- `vitest globalSetup` (not `setupFiles`) for DATABASE_URL override — ensures test DB URL is active before module resolution
- `try/catch` in `afterAll` handlers — prevents orphaned test data when specs fail mid-run
- `SICK` leave type for lifecycle tests — deterministic, no vacation entitlement conflicts
- `page.route()` mock for locked-state testing — no real DB lock required in E2E tests
- `(e as any)?.status` duck-type for ApiError — ApiError not exported, duck typing avoids import coupling
- iPhone 14 device preset over raw viewport — `isMobile: true, hasTouch: true` changes how the SPA behaves
- All audit collectors must use hard-fail assertions (`expect(criticalFindings).toHaveLength(0)`) — silent collectors are invisible in CI

### Key Lessons

1. **Set up quality gates before writing tests** — isolating the test DB first meant no accidental dev data pollution during 2 days of test writing
2. **Legal rules need implementation, not just tests** — ArbZG §3 24-week average wasn't implemented at all; discovered during test writing and fixed in the same plan
3. **One-liner fields in SUMMARY.md matter** — gsd-tools uses them for MILESTONES.md extraction; empty one_liners produce filename-as-accomplishment artifacts
4. **phase_count in ROADMAP.md progress table drifts** — not auto-updated by executor; always verify at milestone close
5. **Mobile E2E needs real device presets** — raw viewport (375x812) misses `isMobile`/`hasTouch` flags that change SPA behavior; use `devices['iPhone 14']`

### Cost Observations

- Sessions: Multiple across 2 days (2026-03-30 → 2026-03-31)
- Notable: Phase 2 and Phase 3 ran with some debug cycles (unit test failures required a debug session, E2E failures required 135 test fixes)
- Effective pattern: wave execution within phases reduced context overhead

---

## Cross-Milestone Trends

### Process Evolution

| Milestone | Commits | Phases | Key Change         |
| --------- | ------- | ------ | ------------------ |
| v1.0      | ~95     | 3      | First milestone — baseline established |

### Cumulative Quality

| Milestone | Unit Tests | E2E Flows | Coverage Baseline |
| --------- | ---------- | --------- | ----------------- |
| v1.0      | ~150+      | 5 flows   | lines=40%, fn=41%, branches=28% |
