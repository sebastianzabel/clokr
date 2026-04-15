# Milestones

## v1.3 Monthly Hours Overhaul (Shipped: 2026-04-14)

**Phases completed:** 4 phases, 11 plans, 12 tasks

**Key accomplishments:**

- SaldoSnapshot-based POST /time-entries lock guard (403), atomic unlock-month endpoint with audit trail, and configurable 15-day grace period in auto-close-month
- Proactive lock feedback in the time-entries page: Abgeschlossen badge, Entsperren button for managers, hidden edit/delete for locked rows, and lock icon in calendar cells — all derived from already-loaded entry data.
- 13 Vitest integration tests covering POST /time-entries lock guard (D-04/D-05), unlock-month role check and atomicity (D-01/D-02/D-03), tenant isolation (T-12-05), and close-month earlyClose response (D-12) — all green
- One-liner:
- One-liner:
- Überstunden-Modus select field added to schedule edit modal for MONTHLY_HOURS employees, wired to PUT /settings/work/:employeeId with German labels and hint text.
- One-liner:
- One-liner:
- One-liner:
- Toggle-guarded dailySoll holiday deduction applied symmetrically across all 4 saldo computation sites (updateOvertimeAccount, close-month, auto-close, recalculate-snapshots), plus computed-holiday merge bugfix in recalculate-snapshots
- One-liner:

---

## v1.2 UI Polish (Shipped: 2026-04-13)

**Phases completed:** 3 phases, 9 plans, 12 tasks

**Key accomplishments:**

- Glass token system overhauled — 10 new tokens (`--glass-bg`, `--glass-blur`, `--glass-highlight`, etc.), 3 new themes (lila, hell, dunkel), old nacht/wald/schiefer themes removed
- Sidebar modernized to Clockodo-style dark nav — icon opacity 0.6→1.0 on active, compact 8px/16px spacing, rgba white text system
- Card, button, input, and badge components overhaul — 18px border-radius cards, pill buttons (9999px), theme dot-picker replaces text dropdown
- Dashboard redesigned — glass stat-cards, widget headers standardized to title-left/action-right, cell-badge semantic colors, today-column inset ring
- Zeiterfassung calendar redesigned — gap-based island grid (3px gaps, 6px rounded cells), colored left-border status stripes, token-only legend
- Leave calendar redesigned — gap-based cells, continuous spanning bars for multi-day leave (left-capped/flat/right-capped), inset drag selection ring
- card-animate entrance animation added consistently across all 6 admin sub-pages previously missing it

---

## v1.1 Reporting & DATEV (Shipped: 2026-04-12)

**Phases completed:** 4 phases (04-07), 12 plans, 16 requirements delivered

**Key accomplishments:**

- DATEV LODAS ASCII export rewritten with CP1252/CRLF, `[Allgemein]`/`[Satzbeschreibung]`/`[Bewegungsdaten]` INI sections, and configurable Lohnartennummern (100/300/200/302 defaults) via admin UI
- OvertimeAccount.balanceHours reads are now O(1) — eager recalculation removed from GET, all write paths (leave approval, CSV import) wired to updateOvertimeAccount
- `resolvePresenceState()` pure utility extracted with 13 unit tests; CANCELLATION_REQUESTED and isInvalid entries handled correctly in dashboard
- Company-wide Monatsbericht PDF + Urlaubsliste PDF streaming endpoints added (PDFKit, no Buffer.concat); single-employee PDF now has tenant-branded header
- Three manager-only sections added to /reports: Heutige Anwesenheit (today status + 4-counter summary), Überstunden-Übersicht (sortable table with Chart.js sparklines per employee), Urlaubsübersicht (year selector, 7 columns including pendingDays)
- 39 new integration tests across reporting endpoints (DATEV, today-attendance, overtime-overview, leave-overview, PDF exports)

---

## v1.0 Production Readiness (Shipped: 2026-03-31)

**Phases completed:** 3 phases, 15 plans, 28 tasks

**Key accomplishments:**

- 4 silent `.catch(() => {})` patterns replaced with structured `app.log.error` / `req.server.log.error` logging across API middleware and routes
- Replaced silently-suppressed inline tsc seed compilation with a dedicated tsconfig.seed.json + package script, and hardened entrypoint to exit 1 instead of falling back to tsx
- Playwright storageState setup project added — login runs once per test run, session shared across desktop-chrome, mobile-chrome, and tablet browser projects via .auth/admin.json
- Type-aware ESLint block added enforcing `no-floating-promises` and `no-misused-promises` as errors for all TypeScript files, with five pre-existing floating promise bugs fixed in plugin shutdown hooks and server entry point.
- Vitest globalSetup routing API tests to PostgreSQL ?schema=test, with pretest prisma db push and try/catch cleanup guards across all 12 test suites
- vitest.config.ts enforces lines>=37%, functions>=37%, branches>=24% coverage thresholds (4pp below measured baseline of 40.22%/41.05%/28.48%)
- ArbZG §3 24-week rolling average check implemented with fixed 144-Werktage denominator, plus 26 boundary and DST tests covering all thresholds at exact values
- Two-tenant cross-resource isolation tests (SEC-02) and audit trail completeness tests for 10 mutating endpoints (SEC-03) covering TimeEntry, Employee, LeaveRequest, Auth, and Settings
- Time entry CRUD, soft-delete enforcement (deletedAt), and locked-month immutability (isLocked 403) tests added to time-entries.test.ts
- Leave lifecycle (PENDING->CANCELLED) and Monatsabschluss compliance tests covering status transitions, cross-year entitlement splits, SaldoSnapshot creation, and locked-entry immutability
- JWT lifecycle compliance tests (login/refresh/expiry/role gates), DSGVO Art. 17 anonymization proof (employee anonymized not deleted, data preserved), and NFC terminal API key validation tests including lastUsedAt tracking
- 8 WOFF2 font files downloaded locally, Google Fonts CDN replaced with @font-face declarations, CSP cleaned to remove all Google domain references
- E2E coverage for clock-in/out and time entry CRUD flows, with German "Monat ist gesperrt" error message for locked-month attempts (E2E-01, E2E-02, UI-02)
- E2E tests for leave approval (employee-creates/admin-approves via API token), employee creation, Monatsabschluss close with API pre-seeding, and password policy persistence with reload verification
- iPhone 14 device preset for mobile E2E tests, 44px WCAG touch target threshold with critical severity, and hard CI-failing assertions on audit findings replacing silent console logging

---
