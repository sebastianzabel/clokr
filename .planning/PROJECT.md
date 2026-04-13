# Clokr

## What This Is

Clokr is a German-language, audit-proof time tracking and leave management SaaS for small to mid-size companies. It handles time entries, breaks, overtime saldo, leave requests with BUrlG-compliant carry-over, ArbZG compliance checks, NFC terminal integration, and multi-tenant administration. v1.0 shipped production-ready (test coverage, legal compliance, DSGVO-compliant fonts, mobile-responsive UI). v1.1 shipped full reporting: DATEV LODAS export, company-wide PDF reports, and three manager dashboard sections. v1.2 shipped a complete UI redesign: glassmorphism design system (3 themes: lila/hell/dunkel), Clockodo-inspired sidebar, redesigned dashboard and calendars with gap-based island grid and spanning leave bars. The app is now feature-complete, reporting-capable, and visually polished for live customer use.

## Current Milestone: v1.3 Monthly Hours Overhaul

**Goal:** Fix broken MONTHLY_HOURS behavior and extend for SVP hourly workers — 0h bug, per-employee overtime carry-forward config, globally configurable holiday deductions, and optional fixed weekdays.

**Target features:**
- Bug: `monthlyHours = 0/null` → no daily Soll, no +/- display in calendar
- Overtime handling: per-employee configurable (`CARRY_FORWARD` vs `TRACK_ONLY`)
- Feiertage/Absences: globally configurable whether they reduce monthly Soll for MONTHLY_HOURS workers (via TenantConfig)
- Fixed weekdays (optional): MONTHLY_HOURS employees can configure working days → daily Soll = monthly budget ÷ working days in month

## v1.2 Shipped

**Shipped:** 2026-04-13
**Stack:** Fastify + SvelteKit 5 (runes) + Prisma + PostgreSQL 18
**Codebase:** ~65,000 LOC (TypeScript + Svelte; +13K lines from UI redesign)

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
- ✓ DATEV LODAS ASCII export (CP1252/CRLF, INI sections, configurable Lohnartennummern) — v1.1
- ✓ OvertimeAccount.balanceHours O(1) stored read; all write paths wired — v1.1
- ✓ resolvePresenceState() utility with CANCELLATION_REQUESTED + isInvalid support — v1.1
- ✓ Company-wide Monatsbericht PDF streaming + Urlaubsliste PDF — v1.1
- ✓ Manager dashboard: Heutige Anwesenheit, Überstunden-Übersicht (sparklines), Urlaubsübersicht — v1.1
- ✓ Glass token system (10 tokens: --glass-bg, --glass-blur, --glass-highlight, etc.) + @supports fallback — v1.2
- ✓ 3 themes: lila (default), hell, dunkel — old nacht/wald/schiefer removed — v1.2
- ✓ Sidebar: dark Clockodo-style nav, icon opacity 0.6→1.0 on active, compact spacing — v1.2
- ✓ Card/button/badge overhaul: 18px radius, pill buttons, theme dot-picker — v1.2
- ✓ Dashboard glass stat-cards, widget headers standardized, today-column inset ring — v1.2
- ✓ Zeiterfassung calendar: gap-based island grid (3px, 6px cells), status stripes, token legend — v1.2
- ✓ Leave calendar: gap-based cells, continuous spanning bars for multi-day leave, inset drag ring — v1.2
- ✓ card-animate entrance animation consistent across all admin sub-pages — v1.2

### Active

**v1.3 — Monthly Hours Overhaul:**
- [ ] Fix: MONTHLY_HOURS with monthlyHours = 0/null shows no daily Soll and no +/- in calendar
- [ ] Feature: Per-employee overtime handling config for MONTHLY_HOURS (CARRY_FORWARD vs TRACK_ONLY)
- [ ] Feature: TenantConfig toggle — whether Feiertage/absences reduce monthly Soll for MONTHLY_HOURS workers
- [ ] Feature: Optional fixed weekdays for MONTHLY_HOURS (enables daily Soll = budget ÷ working days in month)

**Deferred (v1.4+):**
- [ ] Leave-Antrag-Modal visual polish (UI-12) — deferred from v1.2
- [ ] Reports page redesign (UI-13) — deferred from v1.2
- [ ] Admin pages full redesign (UI-14) — deferred from v1.2
- [ ] Mobile 390px overflow check + 44px touch targets audit (UI-15) — deferred from v1.2
- [ ] Remaining pages glass-card frame: Schichten, NFC-Terminal overview (UI-17) — deferred from v1.2
- [ ] CI/CD pipeline with test/lint/build gates
- [ ] Monatsabschluss SaldoSnapshot architecture (Issue #6) — snapshot-based saldo replaces hire-date recalc

### Out of Scope

- Internationalization (i18n) — German-only for v1 launch
- GPS/location tracking — DSGVO complications, not target segment
- DATEV BeraterNr/MandantenNr (SSH LODAS Native) — defer until confirmed customer need
- Abteilungsfilter in dashboard views — requires Abteilung as first-class entity
- BI/Analytics pivot reports — separate data layer needed
- Lohnabrechnung/Payslip generation — belongs in Lohnbuchhaltungs-Software

## Context

- v1.0 shipped 2026-03-31: 3 phases, 15 plans, 28 tasks
- v1.1 shipped 2026-04-12: 4 phases, 12 plans, 16 requirements; 44 files changed, +8,405/-793 lines
- v1.2 shipped 2026-04-13: 3 phases, 9 plans; 81 files changed, +12,939/-1,392 lines (2 days)
- Test coverage: lines≥40%, functions≥41%, branches≥28% (thresholds enforced 4pp below baseline)
- Known gap: tenant isolation gap on GET /employees/:id — pre-existing, documented in test comments
- E2E tests: desktop-chrome, mobile-chrome, tablet; storageState auth shared
- Saldo reads are now O(1) via stored OvertimeAccount.balanceHours; snapshot-based architecture (Issue #6) is next major performance milestone
- UI: 3 active themes (lila/hell/dunkel), glassmorphism tokens, Clockodo-style sidebar; Phase 11 (mobile/admin/reports polish) deferred to v1.3

## Constraints

- **Legal**: Must comply with ArbZG, BUrlG, DSGVO, and German retention requirements (§147 AO: 10 years)
- **Tech stack**: Existing stack (Fastify + SvelteKit + Prisma + PostgreSQL) — no migrations
- **Language**: UI in German, code/docs in English
- **Audit-proof**: No hard deletes, all mutations logged, locked months immutable
- **Docker**: Development and deployment via docker compose

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| No new features in v1.0 | App is feature-complete — quality debt must be paid before launch | ✓ Good |
| Tests + Audit + UI in parallel tracks | All three equally important for production readiness | ✓ Good |
| Existing stack unchanged | No reason to migrate — focus on hardening | ✓ Good |
| Coverage thresholds 4pp below baseline | Block regression, not require heroics | ✓ Good |
| vitest globalSetup (not setupFiles) for DB | Must run before module imports for DATABASE_URL override | ✓ Good |
| Type-aware ESLint scoped to **/*.ts only | Svelte parser handles .svelte files separately | ✓ Good |
| Duck-type ApiError in E2E tests | ApiError not exported from client.ts — (e as any)?.status works | ⚠ Revisit |
| Self-host all 3 font families as WOFF2 | DSGVO Art. 44 requires no external CDN requests | ✓ Good |
| iPhone 14 device preset (not raw viewport) | Matches real device characteristics (isMobile, hasTouch) | ✓ Good |
| Hard CI-fail assertions in audit specs | Silent collectors were undetected — must block CI | ✓ Good |
| DATEV LODAS ASCII (not SSH Native) | Matches DATEV LODAS import wizard; no BeraterNr needed for v1.1 | ✓ Good |
| iconv-lite for CP1252 encoding | Only reliable CP1252 library in Node ESM context | ✓ Good |
| OvertimeAccount.balanceHours as O(1) stored read | Eliminates write amplification on every overtime GET | ✓ Good |
| resolvePresenceState() as pure utility | Enables unit testing without DB; reusable across endpoints | ✓ Good |
| PDFKit streaming via doc.end() + reply.send() | No Buffer.concat memory spike for 50+ MA reports | ✓ Good |
| Chart.js Map<employeeId, Chart> lifecycle | Prevents canvas reuse errors on client-side sort re-renders | ✓ Good |
| use:registerCanvas action (not bind:this fn) | rolldown/Vite 8 rejects function-form bind:this in {#each} | ✓ Good |
| Glass tokens at 0.72–0.80 alpha (not 0.97) | Real glassmorphism requires visible blur behind semi-transparent surface | ✓ Good |
| Theme renamed: pflaume → lila | Matches AWH corporate design palette; "pflaume" was too informal | ✓ Good |
| Gap-based calendar grid (not shared borders) | 3px gap + border-radius on cells gives island look; padding:3px prevents radius clipping at overflow:hidden boundary | ✓ Good |
| Spanning leave bars via CSS classes (bar-start/middle/end) | Segment-per-cell approach lets week-row wrap naturally without JS layout math | ✓ Good |
| card-animate applied to content, not skeleton | Skeleton is ephemeral — animation belongs on content that persists | ✓ Good |

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

_Last updated: 2026-04-13 — v1.3 milestone started (Monthly Hours Overhaul: 0h bug, overtime carry-forward, fixed weekdays)_
