# Clokr — Production Readiness

## What This Is

Clokr is a German-language, audit-proof time tracking and leave management SaaS for small to mid-size companies. It handles time entries, breaks, overtime saldo, leave requests with BUrlG-compliant carry-over, ArbZG compliance checks, NFC terminal integration, and multi-tenant administration. v1.0 (Production Readiness) is now shipped — the app has test coverage, legal compliance validation, DSGVO-compliant font hosting, and mobile-responsive UI.

## Core Value

The app must be reliable, secure, and legally compliant enough to go live with real customers — no silent failures, no untested edge cases, no broken mobile experience.

## Requirements

### Validated

- ✓ Time entry CRUD with break tracking — existing
- ✓ Overtime saldo calculation from hire date — existing
- ✓ Leave requests with approval workflow — existing
- ✓ Leave cancellation flow with manager approval — existing
- ✓ Vacation carry-over (BUrlG §3, §7) — existing
- ✓ ArbZG compliance checks (§3 daily max, §4 breaks, §5 rest period) — existing
- ✓ ArbZG §3 24-week rolling average check — v1.0
- ✓ Monthly closure (Monatsabschluss) with lock — existing
- ✓ Audit trail for all mutations — existing
- ✓ DSGVO-compliant employee anonymization — existing
- ✓ Multi-tenant isolation — existing
- ✓ NFC terminal punch integration — existing
- ✓ Role-based access control (ADMIN, MANAGER, EMPLOYEE) — existing
- ✓ JWT auth with refresh tokens — existing
- ✓ Dashboard with clock widget, weekly overview, open items — existing
- ✓ Employee admin with hire date, schedules — existing
- ✓ FIXED_WEEKLY and MONTHLY_HOURS schedule types — existing
- ✓ Isolated test DB (TEST_DATABASE_URL, ?schema=test) — v1.0
- ✓ Playwright storageState E2E auth setup — v1.0
- ✓ Vitest coverage thresholds enforced (lines/functions/branches) — v1.0
- ✓ no-floating-promises ESLint gate (blocking error) — v1.0
- ✓ Docker seed deterministic build (tsconfig.seed.json) — v1.0
- ✓ ArbZG + tenant isolation + audit trail test coverage — v1.0
- ✓ Full API test coverage (time entries, leave, Monatsabschluss, auth, DSGVO, NFC) — v1.0
- ✓ Google Fonts self-hosted locally (DSGVO Art. 44) — v1.0
- ✓ E2E test coverage for 5 critical user flows — v1.0
- ✓ Mobile viewport (390px iPhone 14) with 44px WCAG touch targets — v1.0
- ✓ German error messages for locked-month, form validation, API failures — v1.0
- ✓ Password policy admin UI — v1.0
- ✓ Hard CI-failing assertions in UI/UX audit specs — v1.0

### Active

- [ ] Mobile overflow at 390px — human verification pending (run mobile-flow.spec.ts with Docker)
- [ ] Saldo snapshot architecture (Issue #6) — performance optimization for next milestone
- [ ] CI/CD pipeline with test/lint/build gates — infrastructure for next milestone

### Out of Scope

- New features (feature-complete for v1) — focus was quality, not scope
- Internationalization (i18n) — German-only for v1 launch
- DATEV integration — separate integration project requiring API access
- GPS/location tracking — DSGVO complications, not target segment

## Context

- v1.0 shipped 2026-03-31: 3 phases, 15 plans, 28 tasks completed
- Codebase: ~44,334 LOC (TypeScript + Svelte), Fastify API + SvelteKit web + Prisma/PostgreSQL
- Test coverage baseline: lines=40.22%, functions=41.05%, branches=28.48% (thresholds enforced 4pp below)
- Known tech debt: saldo recalculation from hire date on every GET (perf concern, Issue #6)
- Known gap: tenant isolation gap on GET /employees/:id route — pre-existing, documented in test comments
- E2E tests run on desktop-chrome, mobile-chrome, tablet; storageState auth shared across all projects

## Constraints

- **Legal**: Must comply with ArbZG, BUrlG, DSGVO, and German retention requirements (§147 AO: 10 years)
- **Tech stack**: Existing stack (Fastify + SvelteKit + Prisma + PostgreSQL) — no migrations
- **Language**: UI in German, code/docs in English
- **Audit-proof**: No hard deletes, all mutations logged, locked months immutable
- **Docker**: Development and deployment via docker compose

## Key Decisions

| Decision                                    | Rationale                                                         | Outcome    |
| ------------------------------------------- | ----------------------------------------------------------------- | ---------- |
| No new features this milestone              | App is feature-complete — quality debt must be paid before launch | ✓ Good     |
| Tests + Audit + UI in parallel tracks       | All three are equally important for production readiness          | ✓ Good     |
| Existing stack unchanged                    | No reason to migrate — focus on hardening what exists             | ✓ Good     |
| Coverage thresholds 4pp below baseline      | Not aspirational — set to block regression, not require heroics   | ✓ Good     |
| vitest globalSetup (not setupFiles) for DB  | Must run before module imports for DATABASE_URL override to work  | ✓ Good     |
| Type-aware ESLint scoped to **/*.ts only    | Svelte parser handles .svelte files separately                    | ✓ Good     |
| SICK leave for cancellation test            | Avoids VACATION entitlement conflicts in test data                | ✓ Good     |
| Duck-type ApiError in E2E tests             | ApiError not exported from client.ts — (e as any)?.status works  | ⚠ Revisit  |
| page.route() mock for locked-month test     | Avoids real locked month dependency in test DB                    | ✓ Good     |
| Self-host all 3 font families as WOFF2      | DSGVO Art. 44 requires no external CDN requests                   | ✓ Good     |
| iPhone 14 device preset (not raw viewport)  | Matches real device characteristics (isMobile, hasTouch)          | ✓ Good     |
| Hard CI-fail assertions in audit specs      | Silent collectors were undetected — must block CI on critical findings | ✓ Good  |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd:transition`):

1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd:complete-milestone`):

1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---

_Last updated: 2026-03-31 after v1.0 milestone (Production Readiness) completion_
