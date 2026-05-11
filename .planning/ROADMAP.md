# Roadmap: Clokr

## Milestones

- ✅ **v1.0 Production Readiness** — Phases 1-3 (shipped 2026-03-31)
- ✅ **v1.1 Reporting & DATEV** — Phases 4-7 (shipped 2026-04-12)
- ✅ **v1.2 UI Polish** — Phases 8-10 (shipped 2026-04-13)
- ✅ **v1.3 Monthly Hours Overhaul** — Phases 11-16 (shipped 2026-04-14)
- ✅ **v1.4 Manager/MA-Trennung & Reports** — Phases 17-25 (shipped 2026-05-11) — see .planning/milestones/v1.4-ROADMAP.md

## Phases

<details>
<summary>✅ v1.0 Production Readiness (Phases 1-3) — SHIPPED 2026-03-31</summary>

See `.planning/milestones/v1.0-ROADMAP.md` for full details.

- [x] Phase 1: Test Infrastructure & Coverage (completed 2026-03-31)
- [x] Phase 2: Security & Compliance Hardening (completed 2026-03-31)
- [x] Phase 3: UI/UX Polish & Mobile (completed 2026-03-31)

</details>

<details>
<summary>✅ v1.1 Reporting & DATEV (Phases 4-7) — SHIPPED 2026-04-12</summary>

See `.planning/milestones/v1.1-ROADMAP.md` for full details.

- [x] Phase 4: DATEV Code Cleanup (4/4 plans) — completed 2026-04-11
- [x] Phase 5: Saldo Performance & Presence Resolver (3/3 plans) — completed 2026-04-11
- [x] Phase 6: PDF Exports — Monatsbericht, Urlaubsliste (2/2 plans) — completed 2026-04-11
- [x] Phase 7: Reporting Dashboards — Überstunden, Urlaub, Anwesenheit (3/3 plans) — completed 2026-04-12

</details>

<details>
<summary>✅ v1.2 UI Polish (Phases 8-10) — SHIPPED 2026-04-13</summary>

- [x] Phase 8: Design System Foundation (4/4 plans) — completed 2026-04-13
- [x] Phase 9: Widget, Menu & Page Redesign — Clockodeo (3/3 plans) — completed 2026-04-13
- [x] Phase 10: Calendar Redesign — Zeiterfassung & Abwesenheiten (2/2 plans) — completed 2026-04-13

</details>

<details>
<summary>✅ v1.3 Monthly Hours Overhaul (Phases 11-16) — SHIPPED 2026-04-14</summary>

See `.planning/milestones/v1.3-ROADMAP.md` for full details.

- [x] Phase 11: Schema Bug Fixes — MONTHLY_HOURS (2/2 plans) — completed 2026-04-13
- [x] Phase 12: Monatsabschluss Lock Enforcement (3/3 plans) — completed 2026-04-13
- [x] Phase 13: Overtime Handling Mode — CARRY_FORWARD / TRACK_ONLY (3/3 plans) — completed 2026-04-13
- [x] Phase 14: Weekday Configuration & Per-Day Soll (2/2 plans) — completed 2026-04-13
- [x] Phase 15: Tenant Holiday Deduction Configuration (3/3 plans) — completed 2026-04-13
- [x] Phase 16: § 5 BUrlG June 30th Rule — Full Entitlement on H2 Exit (2/2 plans) — completed 2026-04-25

</details>

<details>
<summary>✅ v1.4 Manager/MA-Trennung & Reports (Phases 17-25) — SHIPPED 2026-05-11</summary>

See `.planning/milestones/v1.4-ROADMAP.md` for full details.

- [x] Phase 17: Personal Page Cleanup (2/2 plans) — completed 2026-04-25
- [x] Phase 18: Team Route Scaffold & Sidebar Nav (2/2 plans) — completed 2026-04-25
- [x] Phase 19: Team Time-Entries Page (1/1 plan) — completed 2026-04-25
- [x] Phase 20: Team Leave Page (1/1 plan) — completed 2026-04-25
- [x] Phase 21: Per-Employee Export API (1/1 plan) — completed 2026-04-25
- [x] Phase 22: Reports Page Redesign (1/1 plan) — completed 2026-04-25
- [x] Phase 23: Glass-Card UI Polish (1/1 plan) — completed 2026-04-25
- [x] Phase 24: v1.4 UAT Fixes (4/4 plans) — completed 2026-05-11
- [x] Phase 25: WiFi-Presence Stempel (FritzBox) (9/9 plans) — completed 2026-05-11

</details>

## Backlog

### SCHED-V14-01: Per-day hour allocation for MONTHLY_HOURS

**Description:** Allow admins to specify exact hours per weekday (e.g. Mo 4h, Fr 6h) instead of equal-split from monthly budget. Currently weekday chips are boolean only (work/don't work), with implicit equal distribution across working days. This enhancement would enable flexible schedules like split-week arrangements or graduated hours.

**Status:** Backlog — candidate for v1.5+
**Related:** Phase 14 (Weekday Configuration)

### v1.5+ Reports & UI Backlog (carried from v1.4)

- **UI-15**: Mobile 390px overflow check + 44px touch targets audit
- **RPT-05**: Batch approve leave requests from team page
- **RPT-06**: Leave balance bar chart in Reports
- **RPT-07**: Drill-down detail view from Reports widgets
- **RPT-08**: Carry-over expiry warnings in Reports
- **RPT-09**: PDF with company branding + signature fields
