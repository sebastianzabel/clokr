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

- [ ] Comprehensive API test coverage (routes, validation, permissions, edge cases)
- [ ] E2E test coverage for critical user flows
- [ ] ArbZG edge case validation (boundary conditions, cross-day shifts)
- [ ] Code audit: security review, silent failure elimination, error handling
- [ ] Code audit: compliance verification (soft deletes, audit trail completeness)
- [ ] Mobile-responsive UI across all views
- [ ] UI consistency (spacing, colors, components, design system)
- [ ] UX flow improvements (fewer clicks, better navigation, clearer feedback)

### Out of Scope

- New features (feature-complete for v1) — focus is quality, not scope
- Saldo snapshot architecture (Issue #6) — separate milestone, performance optimization
- CI/CD pipeline setup — infrastructure concern, not app quality
- Internationalization (i18n) — German-only for v1 launch

## Context

- Brownfield monorepo: `apps/api` (Fastify), `apps/web` (SvelteKit/Svelte 5), `packages/db` (Prisma/PostgreSQL)
- Tests exist but coverage is thin — API tests use shared dev DB, E2E scaffolding exists but sparse
- Known tech debt: saldo recalculation from hire date (perf), fire-and-forget `.catch(() => {})` patterns, shared test DB
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

_Last updated: 2026-03-30 after initialization_
