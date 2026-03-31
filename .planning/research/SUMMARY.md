# Project Research Summary

**Project:** Clokr — Production Readiness / Hardening Milestone
**Domain:** German B2B SaaS — Audit-proof time tracking and leave management
**Researched:** 2026-03-30
**Confidence:** HIGH

## Executive Summary

Clokr is a feature-complete German HR time tracking product that must be hardened to production quality before it can serve paying customers. The milestone is not about new features — it is about making the existing features trustworthy, legally defensible, and demonstrably correct. The research confirms that the technology stack (Fastify 5, SvelteKit 2/Svelte 5, Prisma 7, PostgreSQL 18) is solid and requires no migration. What is missing is a production-readiness layer: error tracking, enforced coverage thresholds, blocking linters, and a reliable isolated test database.

The recommended approach is to sequence work in three phases driven by a clear dependency graph. Test infrastructure must come first because all other quality work — coverage, compliance, and UI audits — produces unreliable results without it. A shared dev/test database (the current state) means any coverage metric or compliance assertion is only as trustworthy as the last test run's cleanup. Once the test infrastructure is solid, API-level compliance testing (ArbZG, DSGVO, audit trail, tenant isolation) and UI quality work can proceed in parallel across two tracks.

The highest-impact risks are two legal issues that are one-hour fixes but carry serious consequences if left unresolved: the Google Fonts CDN import (a confirmed DSGVO Art. 44 violation per LG München I ruling) and the silent `.catch(() => {})` patterns that can hide compliance-critical failures. A further risk is the absence of any test coverage for the ArbZG utility — the legal compliance engine of the product has no automated verification. These three items must be resolved before any customer sees the product.

---

## Key Findings

### Recommended Stack

The existing stack requires no changes to frameworks or runtime dependencies. The production-readiness gap is filled by six targeted additions and configuration changes. Sentry (`@sentry/node` + `@sentry/sveltekit` 10.x) is the only net-new runtime dependency — it is the only tool with official first-party support for both Fastify 5 and SvelteKit 2 simultaneously. For component testing, `vitest-browser-svelte` + `@vitest/browser` provide the only reliable path to testing Svelte 5 runes reactivity, as `@testing-library/svelte` runs in jsdom and cannot correctly await `$state`/`$derived` updates.

**Core technology additions:**

- `@sentry/node` + `@sentry/sveltekit` 10.x: error tracking and performance tracing — only Sentry has first-party Fastify 5 + SvelteKit 2 integration
- `vitest.config.ts` coverage thresholds (lines 70, functions 75, branches 65): CI enforcement against coverage regression — V8 provider already configured, only config missing
- `pnpm audit --audit-level=high` in CI: zero-setup CVE gating — Trivy has documented pnpm monorepo scanning issues (GitHub issue #3793)
- ESLint `@typescript-eslint/no-floating-promises` as error (blocking): catches fire-and-forget patterns that are the root cause of silent compliance failures
- `@vitest/browser` + `vitest-browser-svelte`: component testing for Svelte 5 with real browser — scoped to time entry form and leave request flow only
- Prisma `$on("query")` slow query logging: uses existing Prisma event API, no new dependency

**Explicitly excluded:** Testcontainers (CI overhead), PGLite (no Prisma 7 adapter), vitest-environment-prisma-postgres (incompatible with audit log tests), Istanbul (V8 already configured), Snyk (requires paid plan).

### Expected Features

The research frames "features" for this milestone as qualities and capabilities, not user-facing functionality. The product is feature-complete. The test is: would a paying German SME customer notice, reject, or face legal exposure if this quality is absent?

**Must have — ship before any customer sees the product:**

- Isolated test database (`TEST_DATABASE_URL`) — prerequisite for trusting all other test assertions
- Silent failure elimination (4 confirmed `.catch(() => {})` locations) — compliance-critical; overtime recalculation failure is silent
- ArbZG compliance test coverage — `arbzg.test.ts` does not exist; untested legal compliance engine
- Soft delete enforcement tests — legal requirement; DSGVO Art. 17 anonymization must preserve records
- Tenant isolation tests — DSGVO Art. 83 risk; cross-tenant data leakage is highest-impact SaaS vulnerability
- Google Fonts CDN fix — confirmed DSGVO Art. 44 violation; one-hour fix with significant legal exposure if skipped

**Must have — ship before charging customers:**

- API route coverage for all critical paths (time entries, leave, Monatsabschluss, auth, DSGVO anonymization)
- Timezone/date boundary tests (DST transitions, Dec 31 → Jan 1, hire-date boundaries)
- Audit trail completeness verification (every POST/PUT/DELETE writes AuditLog row)
- Mobile-responsive UI across all views (no horizontal scroll at 390px, 44px touch targets)
- Consistent user-facing error feedback in German

**Should have — ship before meaningful scale:**

- UI design consistency (spacing scale, color tokens, loading skeletons uniform across views)
- Password policy UI (backend exists; admin settings form is missing)

**Defer entirely:**

- Saldo snapshot architecture migration (Issue #6) — out of scope per PROJECT.md; correctness risk if attempted alongside hardening
- DATEV integration — separate milestone requiring customer demand signal
- i18n/localization — German-only for v1; no customer request
- GPS/location tracking — DSGVO complications; wrong customer segment
- CI/CD pipeline — infrastructure concern; test suite must be reliable first

### Architecture Approach

The hardening work spans three subsystems — Test Suite, Code Audit, and UI Quality — that share no runtime dependencies but all operate against the existing application without modifying its behavior. This is the key architectural insight: nothing in the production layer changes how the app works; it verifies and instruments it. The three subsystems map cleanly to the three roadmap phases, with Test Suite necessarily preceding the other two because API tests and E2E tests both depend on infrastructure decisions made in Phase 1.

**Major components:**

1. **Test Suite Subsystem** — Separate `TEST_DATABASE_URL` pointing to `clokr_test` DB; Playwright `storageState` setup project replacing per-test login; Vitest coverage thresholds enforced in CI; missing route coverage and ArbZG unit tests added
2. **Code Audit Subsystem** — ESLint `no-floating-promises` (blocking); systematic grep-based audit of soft delete filters, audit trail calls, `isLocked` checks, and tenant scoping; `decryptSafe` plaintext fallback fix; Google Fonts self-hosting; seed script `|| true` removal
3. **UI Quality Subsystem** — E2E storageState prerequisite; mobile viewport audit (375px/390px); `@axe-core/playwright` accessibility audit; critical flow E2E coverage; design consistency pass; password policy admin form

**Cross-cutting constraint:** API tests use `app.inject()` and require only a PostgreSQL service container. E2E tests require the full Docker Compose stack. This creates two distinct CI job types; E2E in CI is infrastructure scope and deferred — but E2E test architecture must be designed around this from the start (storageState, role-based auth setup).

### Critical Pitfalls

1. **Shared test DB contaminates runs** — Tests write to the dev database. Cleanup in `afterAll` fails if a test throws first, leaving orphaned tenants. Parallel execution is impossible. Fix first: add `PG_TEST_URL` env var pointing to `clokr_test`; wrap cleanup in `try/finally`. Everything else depends on this.

2. **Google Fonts CDN is a confirmed DSGVO violation** — `app.css` imports from `fonts.googleapis.com`; CSP explicitly whitelists Google domains. LG München I issued injunctions for exactly this pattern. Fix: self-host Jost/DM Sans/Fraunces under `apps/web/static/fonts/` using `fontsource` packages, remove Google domains from CSP.

3. **Silent `.catch(() => {})` hides compliance-critical failures** — Four confirmed locations; the overtime recalculation failure is most dangerous (stale saldo shown with no error). ESLint `no-floating-promises` surfaces these statically. Replace each with `app.log.error({ err }, "context")`.

4. **ArbZG compliance engine has zero test coverage** — `arbzg.test.ts` does not exist. The 24-week rolling average rule (8h/day average, not a daily limit) is the most legally nuanced and most likely to be implemented incorrectly. Pure unit tests with no DB dependency; must be written from scratch.

5. **`decryptSafe` falls back to plaintext on decryption failure** — Key rotation silently breaks all tenant SMTP configs; emails fail with misleading "auth failed" errors. Add startup health check verifying encryption key round-trip; remove plaintext fallback once migration window is confirmed closed.

---

## Implications for Roadmap

Based on the combined dependency graph from all four research files, three phases are recommended. Phases 2 and 3 are partially parallelizable by different team members or tracks, but Phase 1 must complete before either begins.

### Phase 1: Test Infrastructure Hardening

**Rationale:** The `setup.ts` TODO ("separate test DB for CI") is the single highest-leverage structural fix in the codebase. Every subsequent test written without this fix is written on an unreliable foundation. Coverage metrics, compliance assertions, and audit trail tests are all meaningless if the test DB is shared with dev. This phase is a prerequisite — non-negotiable.

**Delivers:** Reliable, isolated test execution; baseline coverage thresholds enforced in CI; fast E2E iteration via storageState.

**Addresses:** FEATURES.md #1 (Isolated Test DB), STACK.md coverage enforcement, ARCHITECTURE.md subsystem 1

**Avoids:**

- PITFALLS.md Pitfall 1 (shared DB contamination)
- PITFALLS.md Pitfall 3 (fire-and-forget hidden by unreliable tests)
- Anti-Pattern 2 (shared dev/test DB)

**Key tasks:**

- Add `TEST_DATABASE_URL` env var; configure `vitest.config.ts` to use it when `NODE_ENV=test`
- Wrap all `cleanupTestData` in `try/finally`; add `beforeAll` cleanup of stale test tenants
- Implement `auth.setup.ts` Playwright setup project; save `storageState` for admin and employee roles
- Add coverage thresholds to `apps/api/vitest.config.ts` (lines 70, functions 75, branches 65)
- Add `pnpm audit --audit-level=high` to CI workflow
- Make ESLint blocking in CI (remove `|| true`); add `no-floating-promises` as error

**Research flag:** None — patterns are well-documented and grounded directly in existing codebase analysis.

---

### Phase 2: Compliance Audit and API Test Coverage

**Rationale:** With reliable test infrastructure, all compliance-critical gaps can be expressed as failing tests and then fixed. This phase works inward from legal risk: ArbZG (German labor law), DSGVO (data protection), revisionssicherheit (audit trail), and security (tenant isolation). These items carry legal exposure that dwarfs any UI issue. The phase also resolves the four known silent failure locations that could mask audit trail failures in production.

**Delivers:** Legally defensible test coverage of all critical business rules; no silent failures; confirmed audit trail completeness; tenant isolation verified.

**Addresses:** FEATURES.md #2 (API route coverage), #3 (timezone tests), #4 (silent failures), #5 (ArbZG), #6 (tenant isolation), #9 (audit trail), #10 (soft delete)

**Avoids:**

- PITFALLS.md Pitfall 2 (Google Fonts — fix here, one-hour task)
- PITFALLS.md Pitfall 3 (fire-and-forget — fix here after linter surfaces all instances)
- PITFALLS.md Pitfall 4 (`decryptSafe` — add health check and logging)
- PITFALLS.md Pitfall 5 (ArbZG untested — create `arbzg.test.ts`)
- PITFALLS.md Pitfall 6 (leave carry-over cross-year — add Dec→Jan test cases)
- PITFALLS.md Pitfall 7 (timezone midnight boundary in ArbZG queries — test-then-fix)
- PITFALLS.md Pitfall 9 (seed `|| true` — remove suppression)

**Key tasks:**

- Create `apps/api/src/utils/__tests__/arbzg.test.ts` (§3 daily, §3 24-week average, §3 weekly 48h, §4 breaks, §5 rest, cross-midnight, DST)
- Self-host fonts (Jost, DM Sans, Fraunces) via `@fontsource/*`; remove Google domains from CSP
- Replace all four `.catch(() => {})` with `app.log.error(...)` equivalents
- Add `apps/api/src/__tests__/compliance.test.ts`: assert soft delete, isLocked enforcement, audit log presence after every mutation
- Add tenant isolation tests (two-tenant seed; cross-tenant 403/404 assertions)
- Add timezone boundary tests (DST spring/fall, Dec 31 → Jan 1, hire-date boundaries)
- Add leave carry-over cross-year test cases (Dec 29 → Jan 2 spanning scenarios)
- Add Sentry to API and web (`@sentry/node`, `@sentry/sveltekit`)
- Add Prisma slow query logging (`$on("query")` — threshold 2000ms)
- Fix `decryptSafe`: add startup health check; log decryption failures with tenantId
- Remove seed `2>/dev/null || true` from Dockerfile

**Research flag:** ArbZG 24-week rolling average implementation needs careful review against CLAUDE.md rules before test cases are written — the "8h rule is a 24-week average, NOT a daily limit" distinction is likely not reflected correctly in all test scenarios. No additional research needed; re-read CLAUDE.md ArbZG section.

---

### Phase 3: UI Quality and Polish

**Rationale:** UI quality work depends on E2E infrastructure being solid (Playwright storageState from Phase 1). It can proceed in parallel with Phase 2 as a separate track. The mobile responsiveness and error feedback work are customer-facing and determine first impressions during demos. Password policy UI is a one-form addition that unblocks enterprise security requirements.

**Delivers:** Mobile-usable product at 390px; German-language error messages on all failure paths; consistent visual design; password policy configurable by admins.

**Addresses:** FEATURES.md #7 (mobile), #8 (error feedback), #11 (UI consistency), #12 (password policy UI)

**Avoids:**

- PITFALLS.md Pitfall 11 (password policy config invisible to admins)
- PITFALLS.md Pitfall 14 (table overflow on narrow viewports)
- PITFALLS.md Pitfall 12 (notification polling without backoff — add exponential backoff)
- Anti-Pattern 5 (E2E assertions on CSS classes — maintain role-based locators)

**Key tasks:**

- Mobile audit at 375px and 390px: dashboard, time entry form, leave form, employee table, login
- Add `overflow-x: auto` to all table wrappers; add `overflow-x: hidden` to `.app-main`
- Run `@axe-core/playwright` against all main views; triage color contrast and touch target violations
- Verify German-language validation messages surface on all form error paths
- Add "Monat ist gesperrt" feedback for locked-month edit attempts in the UI
- Add password policy form section to admin settings (5 fields, backend already works)
- Audit spacing/color/skeleton consistency; resolve drift from recent dashboard redesign
- Add exponential backoff to notification polling (60s → max 5 min on error)

**Research flag:** Accessibility (a11y) triage — `@axe-core/playwright` will likely surface more violations than can be fixed in one pass. Triage is needed to distinguish "must fix" (WCAG AA blockers) from "should fix" (improvements). No external research needed; standard WCAG 2.1 AA is the bar.

---

### Phase Ordering Rationale

The ordering is driven entirely by the dependency graph documented in FEATURES.md and confirmed by ARCHITECTURE.md:

- **Phase 1 is a hard prerequisite.** The shared test DB means any test written before this fix may produce false positives. Coverage thresholds set before measuring actual coverage will be set to wrong values. E2E tests with per-test login overhead inflate run times and discourage test writing.
- **Phase 2 before Phase 3 for the API track.** Compliance tests must pass before UI error messaging can be verified — the errors must actually reach the user before the UI can show them correctly. Silent failures fixed in Phase 2 are a prerequisite for consistent error feedback in Phase 3.
- **Phase 3 can start immediately after Phase 1** for the UI track (different team member). Mobile audit and design consistency are independent of API compliance work.
- **Google Fonts fix belongs in Phase 2, not Phase 3.** It is a compliance issue, not a UI quality issue. Its legal exposure is disproportionate to its implementation cost (one hour).

### Research Flags

Phases needing closer attention during planning:

- **Phase 2 — ArbZG rolling average:** The 24-week rolling average rule is the most nuanced ArbZG requirement. Confirm the existing `arbzg.ts` implementation actually computes a rolling average (not a per-day check) before writing tests that assert correct behavior. If the implementation is wrong, tests will cement the bug.
- **Phase 2 — Leave carry-over cross-year:** The existing `leave.test.ts` (425 lines) creates false confidence. Explicitly map CLAUDE.md's documented carry-over rules to test cases before starting — carry-over priority (FIFO), advance booking projection, and March 31 deadline each need separate test scenarios.
- **Phase 2 — `decryptSafe` migration window:** Before removing the plaintext fallback, confirm (by DB query) that no tenant still has plaintext SMTP passwords. If any do, the fix must include a migration script, not just a code change.

Phases with standard, well-documented patterns (no additional research needed):

- **Phase 1 — TEST_DATABASE_URL isolation:** Standard pattern; documented in Vitest config docs. The existing per-tenant isolation approach is correct; only the DB URL needs to change.
- **Phase 1 — Playwright storageState:** Official Playwright auth docs cover this exactly. `auth.setup.ts` → `storageState` → dependency in `playwright.config.ts`. No ambiguity.
- **Phase 3 — Mobile responsiveness:** Viewport audit with Playwright's `mobile-chrome` project is standard. No new patterns needed.

---

## Confidence Assessment

| Area         | Confidence | Notes                                                                                                                                                                                                     |
| ------------ | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stack        | HIGH       | All additions verified against official docs (Sentry, Vitest, Playwright, typescript-eslint). Exclusions (PGLite, Testcontainers) verified via GitHub issue tracking.                                     |
| Features     | HIGH       | Grounded entirely in codebase analysis (CONCERNS.md, PROJECT.md) and German legal statutes (ArbZG, BUrlG, DSGVO). No speculation about user preferences — these are legal requirements or confirmed bugs. |
| Architecture | HIGH       | Based on actual file reads of `setup.ts`, `playwright.config.ts`, and `ci.yml`. All patterns verified against official Playwright and Vitest documentation.                                               |
| Pitfalls     | HIGH       | All critical pitfalls are confirmed in actual source code with file paths and line numbers. Legal citations (LG München I, BUrlG § 7, ArbZG §§ 3-5) are primary sources.                                  |

**Overall confidence:** HIGH

The research is unusually high-confidence for a brownfield project because it is grounded in the actual codebase state (CONCERNS.md was a pre-existing detailed audit) rather than external documentation about a hypothetical system. Every pitfall has a confirmed file path; every stack recommendation has an official doc URL.

### Gaps to Address

- **Actual current coverage percentage is unknown.** Vitest coverage thresholds must be set at or below the current baseline (measure first, then enforce). Recommended approach: run `pnpm --filter @clokr/api test --coverage` once as the first task in Phase 1, use the output to set pragmatic thresholds (suggested: lines 70, branches 65 — adjust down if current coverage is below these).
- **`decryptSafe` migration state is unknown.** The research confirms the pattern is dangerous but cannot determine without a DB query whether any tenant still stores plaintext SMTP passwords. This must be checked before removing the fallback.
- **E2E test scope for Phase 3 is not fully enumerated.** The mobile audit will discover issues that are currently unknown. Phase 3 task list should be treated as a starting framework, not a fixed list.
- **Notification polling SSE migration.** Pitfall 12 (polling without backoff) has a better long-term fix (Server-Sent Events). Exponential backoff is the right short-term fix, but SSE should be logged as a future issue rather than deferred indefinitely.

---

## Sources

### Primary (HIGH confidence)

- Codebase: `.planning/codebase/CONCERNS.md` — pre-existing detailed codebase audit; line-level findings
- Codebase: `apps/api/src/__tests__/setup.ts` — shared DB pattern confirmed
- Codebase: `apps/web/src/app.css` — Google Fonts import confirmed
- Codebase: `apps/api/src/middleware/auth.ts`, `routes/overtime.ts`, `routes/time-entries.ts`, `routes/terminals.ts` — fire-and-forget patterns confirmed
- Codebase: `apps/api/src/utils/crypto.ts` — `decryptSafe` plaintext fallback confirmed
- Codebase: `apps/api/Dockerfile` — seed `|| true` confirmed
- `CLAUDE.md` — ArbZG rules, DSGVO anonymization rules, audit requirements (project law)
- LG München I, Az. 3 O 17493/20 (2022) — Google Fonts DSGVO ruling
- ArbZG §§ 3, 4, 5 — statutory text (daily/weekly max, break, rest period)
- BUrlG § 7 Abs. 3 — statutory text (carry-over deadline)
- DSGVO Art. 17, 44, 83 — statutory text (deletion, third-country transfer, fines)
- Sentry Fastify integration: https://docs.sentry.io/platforms/javascript/guides/fastify/
- Sentry SvelteKit integration: https://docs.sentry.io/platforms/javascript/guides/sveltekit/
- Playwright Authentication Docs: https://playwright.dev/docs/auth
- Vitest coverage config: https://vitest.dev/config/coverage
- typescript-eslint no-floating-promises: https://typescript-eslint.io/rules/no-floating-promises/
- Fastify Testing Guide: https://fastify.dev/docs/v5.3.x/Guides/Testing/

### Secondary (MEDIUM confidence)

- pnpm audit: https://pnpm.io/cli/audit — built-in CVE gating
- Trivy pnpm issue: https://github.com/aquasecurity/trivy/issues/3793 — monorepo scanning limitation
- vitest-browser-svelte GitHub: https://github.com/vitest-dev/vitest-browser-svelte — Svelte 5 support
- OWASP Multi-Tenant Security Cheat Sheet — tenant isolation test patterns
- OWASP Node.js Security Cheat Sheet — audit checklist

### Tertiary (LOW confidence)

- Indusface H1 2025 report — "API attacks up 104% YoY" (cited for threat context, not implementation decisions)

---

_Research completed: 2026-03-30_
_Ready for roadmap: yes_
