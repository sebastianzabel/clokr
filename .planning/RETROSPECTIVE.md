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

## Milestone: v1.1 — Reporting & DATEV

**Shipped:** 2026-04-12
**Phases:** 4 (04-07) | **Plans:** 12 | **Commits:** ~37

### What Was Built

- DATEV LODAS ASCII export: CP1252/CRLF, 3 INI sections, configurable Lohnartennummern (admin UI + TenantConfig schema)
- OvertimeAccount.balanceHours made O(1): eager recalc removed from GET; leave approval + CSV import now call updateOvertimeAccount post-write
- `resolvePresenceState()` pure utility with 13 unit tests; CANCELLATION_REQUESTED and isInvalid entries handled correctly
- Company-wide Monatsbericht PDF streaming + Urlaubsliste PDF (PDFKit, no Buffer.concat memory spike)
- Three manager-only sections on /reports: Heutige Anwesenheit (4-counter summary), Überstunden-Übersicht (sortable + Chart.js sparklines), Urlaubsübersicht (year selector, 7 columns, pendingDays)
- 39 new integration tests across all reporting endpoints

### What Worked

- **Pure utility extraction** (resolvePresenceState): pulling business logic out of route handlers into testable pure functions pays off immediately — 13 unit tests caught edge cases before integration
- **Bulk query pattern**: all reporting endpoints use 2-5 bulk findMany queries instead of per-employee loops — consistent, fast, no N+1
- **Yolo mode execution**: all 4 phases completed in a single day; minimal overhead; plan-check and verifier still ran per phase
- **Phase ordering**: DATEV (04) → saldo performance (05) → PDF (06) → dashboards (07) was the right dependency order; no rework between phases
- **Post-phase worktree fix commits**: WR-01..05 fixes applied cleanly as post-verification commits without reopening plans

### What Was Inefficient

- **Worktree merge regressions**: Phase 7-02 worktree merge overwrote the DATEV .csv→.txt fix from Phase 4 (commit `1d14a67`). Required a restore commit (`b6a70fc`) after detection in Phase 7 VERIFICATION.md. This is a known pattern (documented in CLAUDE.md Worktree Merge Safety) but still bit us.
- **ROADMAP.md was stale at milestone close**: only showed phases 6-7 (not 04-07), causing gsd-tools milestone complete to report wrong phase/plan counts. Required manual archive fixes.
- **SUMMARY.md one_liner extraction**: gsd-tools couldn't reliably extract one_liners from all SUMMARY files — some were empty, some pulled non-summary text. Counts in MILESTONES.md initial entry were wrong.
- **STATE.md milestone field**: showed v1.0 (stale) even after v1.1 work began. gsd-tools milestone complete set it to v1.1 correctly but it was confusing mid-milestone.

### Patterns Established

- `Map<employeeId, Chart>` + `use:registerCanvas` action for Chart.js sparklines inside `{#each}` blocks — replaces deprecated function-form `bind:this` (broken in rolldown/Vite 8)
- pageAdded re-entrancy guard for PDFKit streaming — `drawingFooter: boolean` flag prevents `text()` → `addPage` → `pageAdded` → `text()` stack overflow
- `affectedEmployeeIds: Set<string>` pattern for post-loop fan-out — deduplicate and call per-entity after loop, not inside
- `onchange` handler (not `$effect`) for year/filter selectors — avoids double-fetch on mount
- Bulk presence resolution: 5 queries + resolvePresenceState() per employee — O(employees) not O(employees × queries)

### Key Lessons

1. **Check merge safety after every worktree merge** — run `git diff HEAD~1 HEAD -- <shared-files>` immediately; the CLAUDE.md rule exists for a reason and was still violated
2. **Keep ROADMAP.md current** — phases added mid-milestone didn't get proper plan details written; archival tooling only sees what's in ROADMAP.md
3. **one_liner field in SUMMARY.md is load-bearing** — gsd-tools uses it for MILESTONES.md extraction; write it explicitly at plan summary time
4. **PDFKit streaming needs a re-entrancy guard** — footer drawing inside `pageAdded` reliably causes stack overflow without the flag; document this in any future PDF plan
5. **resolvePresenceState was reused 3× in one milestone** — utility extraction is worth it even when the first use seems small

### Cost Observations

- Sessions: ~1 intensive day (2026-04-11 → 2026-04-12)
- Notable: all 4 phases completed in a single session sprint; wave execution + yolo mode kept overhead minimal
- Regression cost: ~2 extra commits to fix worktree merge regression (DATEV label + WR-05 sick day double-counting)

---

## Cross-Milestone Trends

### Process Evolution

| Milestone | Commits | Phases | Key Change         |
| --------- | ------- | ------ | ------------------ |
| v1.0      | ~95     | 3      | First milestone — baseline established |
| v1.1      | ~37     | 4      | Yolo mode sprint; worktree merge safety still a gap |

### Cumulative Quality

| Milestone | Unit Tests | E2E Flows | Coverage Baseline |
| --------- | ---------- | --------- | ----------------- |
| v1.0      | ~150+      | 5 flows   | lines=40%, fn=41%, branches=28% |
| v1.1      | ~190+      | 5 flows   | lines=40%, fn=41%, branches=28% (unchanged) |
