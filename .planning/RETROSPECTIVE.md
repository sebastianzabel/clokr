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

## Milestone: v1.2 — UI Polish

**Shipped:** 2026-04-13
**Phases:** 3 (08-10) | **Plans:** 9 | **Commits:** ~58 | **Duration:** 2 days

### What Was Built

- Glass token system: 10 new tokens (`--glass-bg`, `--glass-blur`, `--glass-highlight`, etc.), `@supports (backdrop-filter)` fallback, `prefers-reduced-transparency` media query
- 3 new themes (lila/hell/dunkel) replacing 4 old themes (nacht/wald/schiefer/pflaume) — ~415 lines removed
- Sidebar redesigned: dark Clockodo-style, icon opacity system (0.6→1.0 on active), compact 8px/16px spacing, rgba white text
- Card/button/badge overhaul: 18px border-radius cards, pill buttons (9999px), theme dot-picker replaces text dropdown
- Dashboard: glass stat-cards, widget headers standardized (title-left/action-right), cell-badge semantic colors, today-column inset ring
- Zeiterfassung calendar: gap-based island grid (3px gaps, 6px rounded cells), colored left-border status stripes, token-only legend (no hardcoded hex)
- Leave calendar: gap-based cells, continuous spanning bars for multi-day leave (bar-start/middle/end CSS classes), inset drag selection ring
- `/overtime` route deleted (dead code); card-animate added consistently across 6 admin sub-pages missing it

### What Worked

- **Gap-based calendar grid**: replacing border-based layout with `gap: 3px` + `border-radius: 6px` on cells was a single CSS change with dramatic visual impact; the `padding: 3px` on `.cal-grid` was a non-obvious but critical fix to prevent radius clipping at `overflow: hidden` boundaries
- **Spanning bar CSS classes** (bar-start/middle/end): segment-per-cell approach let week-row wrapping happen naturally without JS layout math; far simpler than a grid overlay approach
- **Discussion phase before UI phases**: capturing design decisions (glassmorphism subtlety level, "one dominant glass surface" principle, Clockodo inspiration) in CONTEXT.md eliminated back-and-forth during execution
- **Token-first approach**: replacing all hardcoded hex values with CSS custom properties in Phase 8 meant Phase 10 color changes were 1-line edits
- **Quick tasks mid-milestone**: card-animate consistency fix and leave bar gap fix were handled as quick tasks without interrupting phase flow

### What Was Inefficient

- **SUMMARY.md one_liner still garbled**: gsd-tools milestone complete extracted incomplete sentences ("Replaced 5 old tokens with 10 new tokens:") as accomplishments; required manual MILESTONES.md correction again — same issue as v1.1
- **Phase 11 not executed**: 5 requirements (UI-12 through UI-17 except UI-16) deferred to v1.3; this was a scope decision, not an inefficiency, but means the milestone is incomplete on paper
- **UAT left at 7 pending items**: human UAT items were defined but not verified before phase completion; milestone was approved based on user visual review, not structured test execution
- **leave calendar fix required post-plan quick tasks**: bar segments had visible gaps at 3px grid boundary, requiring `fix/leave-cal-bar-gaps` branch and two fix commits after Phase 10 was "complete"

### Patterns Established

- `gap: 3px` + `padding: 3px` on `.cal-grid`, `border-radius: 6px` on `.cal-cell` — canonical island calendar grid pattern; `padding` on grid prevents radius clipping at `overflow: hidden` parent boundary
- `color-mix(in srgb, var(--token) N%, transparent)` for tinted backgrounds — dark-theme-safe alternative to `rgba()` with hardcoded values
- CSS class variants for spanning UI elements: `bar-start` / `bar-middle` / `bar-end` lets CSS handle visual joins without JS geometry
- `card-animate` on content wrapper (not skeleton) — skeleton is ephemeral; animation belongs on the element that persists after load

### Key Lessons

1. **Design token discipline pays compound interest**: every hex value replaced in Phase 8 saved a theme-specific fix in Phase 10; the debt is invisible until you try to theme something
2. **Gap-based grids beat border-based grids for island UX**: `border-collapse: collapse` makes theming impossible; gap + individual border-radius is more CSS, but zero hacks
3. **SUMMARY.md one_liner field is still not being written correctly**: 3 milestones in, gsd-tools still can't extract clean one_liners; write them explicitly at plan-end, always
4. **Post-phase fix branches add commit noise**: the `fix/leave-cal-bar-gaps` branch required its own PR/merge flow; consider folding visual polish fixes into the same plan rather than branching post-verification
5. **Defer Phase 11 explicitly, not silently**: UI-12 through UI-17 just didn't happen — next milestone planning should explicitly decide whether to carry them forward or drop them

### Cost Observations

- Sessions: ~2 intensive days (2026-04-11 → 2026-04-13)
- Notable: fastest milestone by LOC/day — 13K lines across 81 files in 2 days; UI work is high-volume but low-complexity per change
- Quick tasks: 2 fix commits (card-animate consistency, leave bar gaps) added ~15 commits to the milestone range

---

## Milestone: v1.3 — Monthly Hours Overhaul

**Shipped:** 2026-04-14
**Phases:** 5 (11-15) | **Plans:** 11 | **Commits:** ~73 | **Duration:** 2 days

### What Was Built

- Fixed MONTHLY_HOURS null-budget bugs: no 422 on save, pure tracking mode with no daily Soll/+/- display, ArbZG 24-week average warning correctly skipped
- Monatsabschluss lock enforcement: POST /time-entries blocked (SaldoSnapshot composite key, HTTP 403), atomic unlock-month endpoint with $transaction + full audit trail, 15-day grace period in auto-close
- Lock UI: Abgeschlossen badge, Entsperren button for managers, hidden edit/delete controls, lock icon in calendar cells — all derived from loaded entry data without extra requests
- Per-employee overtime mode: CARRY_FORWARD accumulates excess hours in OvertimeAccount; TRACK_ONLY records balance but holds carryOver at 0 across all 4 computation sites
- Weekday configuration: boolean chip picker in admin (eMonWd…eSunWd flags), per-day Soll = monthly budget ÷ working days in month displayed in calendar
- Tenant holiday deduction toggle: public holidays on configured workdays reduce monthly Soll when enabled; applied symmetrically at all 4 computation sites
- Post-audit fix: INTEG-01 — missing isTrackOnly guard in recalculate-snapshots.ts; TRACK_ONLY employees were accumulating carry-over during retroactive schedule-change recalculation

### What Worked

- **Milestone audit caught a real bug**: INTEG-01 (missing isTrackOnly guard in recalculate-snapshots.ts) would have silently corrupted TRACK_ONLY overtime balances on schedule changes; the audit found it, UAT confirmed the fix
- **isPureTracking guard pattern** established in Phase 11 propagated cleanly through Phases 12-15; each new computation site followed the same guard structure
- **4-site consistency rule** for saldo computation (updateOvertimeAccount, close-month, auto-close, recalculate-snapshots) made it easy to verify TENANT-01 toggle coverage — check all 4, done
- **Phase 15 UAT driven by real user testing**: both issues found (dashboard widget showing week Soll instead of month, toggle inversion) were caught by live testing, not just code inspection
- **Nyquist validation on Phase 15**: 17/17 tests green before milestone close gave high confidence in the holiday deduction logic

### What Was Inefficient

- **Two phases (11, 15) had no VERIFICATION.md**: audit flagged them as "orphaned"; UAT substituted but the formal verification artifact was missing — caused `gaps_found` audit status that required manual promotion to `passed`
- **UAT for Phase 15 required a debug + fix cycle**: the dashboard MONTHLY_HOURS widget was showing week-scoped Soll instead of month-scoped; root cause (calcExpectedMinutesTz ignoring date range for MONTHLY_HOURS) required a separate debug session and WR-01..04 fix commits
- **SUMMARY.md one_liner extraction broken again**: gsd-tools milestone complete returned "One-liner:" placeholders for 6 of 11 plans; MILESTONES.md accomplishments required manual review — same issue for the 4th consecutive milestone

### Patterns Established

- `isTrackOnly = schedule.overtimeMode === "TRACK_ONLY"` guard before carryOver write — must be applied at ALL saldo computation sites (updateOvertimeAccount, close-month, auto-close, recalculate-snapshots)
- `isPureTracking = schedule.monthlyHours == null || schedule.monthlyHours === 0` — server-side guard, never trust client-supplied schedule type
- SaldoSnapshot composite key as lock authority — more robust than entry count; works even when no entries exist for the month
- `periodType: MONTHLY` + `periodStart` composite unique key pattern for lock detection in POST /time-entries
- Boolean Prisma field with `@default(false)` for feature toggles (TenantConfig.monthlyHoursHolidayDeduction) — zero-migration for existing tenants

### Key Lessons

1. **Run `/gsd:audit-milestone` before completion, not after** — this milestone had `gaps_found` status that blocked completion until INTEG-01 was fixed; the audit is most valuable when run before UAT, not after
2. **VERIFICATION.md is not optional for audit compliance** — phases without VERIFICATION.md always produce orphaned requirements in the audit; even a brief verification pass prevents this
3. **"4 computation sites" is a feature contract, not an implementation detail** — when adding saldo modifiers (holiday deduction, TRACK_ONLY), explicitly list all 4 sites in the plan and verify each; partial coverage causes silent discrepancies
4. **Dashboard widget scope matters**: MONTHLY_HOURS dashboard tile used a week-scoped API call instead of month-scoped; for hourly workers, monthly is the correct granularity — validate widget scope in Phase planning
5. **SUMMARY.md one_liner is still not being written** — 4 milestones in, same extraction failure; this needs to be a required field in the plan template, checked by the executor before completing each plan

### Cost Observations

- Sessions: 2 days (2026-04-13 → 2026-04-14)
- Notable: 5 phases completed in 2 days; post-execution UAT revealed real issues (dashboard scope bug, toggle inversion) that required a debug session — actual shipping took longer than execution
- Audit value: ~1 hour of audit + fix work prevented a silent data corruption bug (INTEG-01) from reaching production

---

## Cross-Milestone Trends

### Process Evolution

| Milestone | Commits | Phases | Key Change         |
| --------- | ------- | ------ | ------------------ |
| v1.0      | ~95     | 3      | First milestone — baseline established |
| v1.1      | ~37     | 4      | Yolo mode sprint; worktree merge safety still a gap |
| v1.2      | ~58     | 3      | Pure UI milestone; fastest LOC/day; SUMMARY one_liner still broken |
| v1.3      | ~73     | 5      | Backend-heavy overhaul; audit caught real bug (INTEG-01); UAT found 2 real issues |

### Cumulative Quality

| Milestone | Unit Tests | E2E Flows | Coverage Baseline |
| --------- | ---------- | --------- | ----------------- |
| v1.0      | ~150+      | 5 flows   | lines=40%, fn=41%, branches=28% |
| v1.1      | ~190+      | 5 flows   | lines=40%, fn=41%, branches=28% (unchanged) |
| v1.2      | ~190+      | 5 flows   | lines=40%, fn=41%, branches=28% (UI only — no new tests) |
| v1.3      | ~220+      | 5 flows   | lines=40%, fn=41%, branches=28% (13+ integration tests added: lock guard, unlock-month, minijob) |
