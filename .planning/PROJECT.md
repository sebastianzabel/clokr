# Clokr — Production Readiness

## What This Is

Clokr is a German-language, audit-proof time tracking and leave management SaaS for small to mid-size companies. It handles time entries, breaks, overtime saldo, leave requests with BUrlG-compliant carry-over, ArbZG compliance checks, NFC terminal integration, and multi-tenant administration. The app is feature-complete for v1 — this milestone focuses on making it production-ready.

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

### Active

- [ ] Mobile overflow at 390px — human verification pending (run mobile-flow.spec.ts with Docker)

### Validated in Phase 3 (E2E and UI Quality)

- ✓ E2E test coverage for critical user flows — clock-in/out, time entry CRUD, leave approval, admin management, Monatsabschluss, password policy (E2E-01–E2E-05)
- ✓ German locked-month error message — "Monat ist gesperrt" shown when 403 returned on time entry save/delete (UI-02)
- ✓ Mobile viewport at 390px (iPhone 14 preset) with 44px touch targets (UI-01, pending Docker run)
- ✓ Audit tests converted to hard CI-failing assertions (UI-03)
- ✓ UX reachability checks — critical actions reachable in ≤2 taps, loading states verified (UI-04)
- ✓ Password policy E2E — save + reload persistence confirmed (UI-05)

### Validated in Phase 2 (Compliance and API Coverage)

- ✓ Comprehensive API test coverage — tenant isolation, audit trail, time entries, leave lifecycle, overtime/Monatsabschluss, auth/JWT, DSGVO anonymization, NFC punch
- ✓ ArbZG edge case validation — 24-week rolling average (§3), boundary thresholds, DST transitions, cross-midnight shifts
- ✓ Code audit: compliance verification — soft deletes enforced (deletedAt), audit trail complete, locked-month immutability
- ✓ Multi-tenant security hardened — employee GET/PUT routes now include tenantId guard (SEC-02 fix)
- ✓ DSGVO Art. 44 compliance — Google Fonts self-hosted, no external font CDN requests

### Out of Scope

- New features (feature-complete for v1) — focus is quality, not scope
- Saldo snapshot architecture (Issue #6) — separate milestone, performance optimization
- CI/CD pipeline setup — infrastructure concern, not app quality
- Internationalization (i18n) — German-only for v1 launch

## Context

- Brownfield monorepo: `apps/api` (Fastify), `apps/web` (SvelteKit/Svelte 5), `packages/db` (Prisma/PostgreSQL)
- Tests exist with ~41% line coverage — API tests now isolated to `?schema=test`, E2E uses shared storageState auth
- Known tech debt: saldo recalculation from hire date (perf)
- Phase 1 complete: silent catches eliminated, Docker seed fixed, no-floating-promises lint gate active, coverage thresholds enforced
- Codebase map available at `.planning/codebase/` with 7 documents
- UI was recently redesigned (dashboard, charts, skeleton loading) but mobile and consistency need work

## Constraints

- **Legal**: Must comply with ArbZG, BUrlG, DSGVO, and German retention requirements (§147 AO: 10 years)
- **Tech stack**: Existing stack (Fastify + SvelteKit + Prisma + PostgreSQL) — no migrations
- **Language**: UI in German, code/docs in English
- **Audit-proof**: No hard deletes, all mutations logged, locked months immutable
- **Docker**: Development and deployment via docker compose

## Key Decisions

| Decision                       | Rationale                                                         | Outcome   |
| ------------------------------ | ----------------------------------------------------------------- | --------- |
| No new features this milestone | App is feature-complete — quality debt must be paid before launch | — Pending |
| Tests + Audit + UI in parallel | All three are equally important for production readiness          | — Pending |
| Existing stack unchanged       | No reason to migrate — focus on hardening what exists             | — Pending |

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

_Last updated: 2026-03-31 after Phase 3 (E2E and UI Quality) completion_
