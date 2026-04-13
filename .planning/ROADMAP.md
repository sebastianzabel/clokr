# Roadmap: Clokr

## Milestones

- ✅ **v1.0 Production Readiness** — Phases 1-3 (shipped 2026-03-31)
- ✅ **v1.1 Reporting & DATEV** — Phases 4-7 (shipped 2026-04-12)
- ✅ **v1.2 UI Polish** — Phases 8-10 (shipped 2026-04-13)
- 🔄 **v1.3 Monthly Hours Overhaul** — Phases 11-15 (in progress)

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
<summary>🔄 v1.3 Monthly Hours Overhaul (Phases 11-15) — IN PROGRESS</summary>

- [x] Phase 11: Schema Bug Fixes — MONTHLY_HOURS (2/2 plans) — completed 2026-04-13
- [x] Phase 12: Monatsabschluss Lock Enforcement (3/3 plans) — completed 2026-04-13
- [x] Phase 13: Overtime Handling Mode — CARRY_FORWARD / TRACK_ONLY (3/3 plans) — completed 2026-04-13
- [x] Phase 14: Weekday Configuration & Per-Day Soll (2/2 plans) — completed 2026-04-13
- [ ] Phase 15: Tenant Holiday Deduction Configuration (0/3 plans)

</details>

## Progress

| Phase | Milestone | Plans Complete | Status   | Completed  |
|-------|-----------|----------------|----------|------------|
| 1. Test Infrastructure | v1.0 | 3/3 | Complete | 2026-03-31 |
| 2. Security Hardening  | v1.0 | 6/6 | Complete | 2026-03-31 |
| 3. UI/UX Polish        | v1.0 | 6/6 | Complete | 2026-03-31 |
| 4. DATEV Cleanup       | v1.1 | 4/4 | Complete | 2026-04-11 |
| 5. Saldo Performance   | v1.1 | 3/3 | Complete | 2026-04-11 |
| 6. PDF Exports         | v1.1 | 2/2 | Complete | 2026-04-11 |
| 7. Reporting Dashboards| v1.1 | 3/3 | Complete | 2026-04-12 |
| 8. Design System Foundation | v1.2 | 4/4 | Complete | 2026-04-13 |
| 9. Widget/Menu/Page Redesign | v1.2 | 3/3 | Complete | 2026-04-13 |
| 10. Calendar Redesign         | v1.2 | 2/2 | Complete | 2026-04-13 |
| 11. Schema Bug Fixes          | v1.3 | 2/2 | Complete | 2026-04-13 |
| 12. Lock Enforcement          | v1.3 | 3/3 | Complete | 2026-04-13 |
| 13. Overtime Handling Mode    | v1.3 | 3/3 | Complete   | 2026-04-13 |
| 14. Weekday Config & Per-Day Soll | v1.3 | 2/2 | Complete   | 2026-04-13 |
| 15. Tenant Holiday Deduction  | v1.3 | 0/3 | Not Started | — |

### Phase 12: Monatsabschluss Lock Enforcement

**Goal:** Enforce `isLocked` on time-entry mutations (POST create previously unguarded), add `POST /overtime/unlock-month` endpoint with atomic snapshot deletion and full audit log, grace period for auto-close, and proactive UI lock feedback (indicators, hidden controls, Entsperren button).
**Requirements**: BUG-02
**Depends on:** Phase 11
**Plans:** 3/3 plans complete

### Phase 13: Overtime Handling Mode — CARRY_FORWARD / TRACK_ONLY

**Goal:** Allow admins to configure per-employee overtime handling mode for MONTHLY_HOURS schedules. CARRY_FORWARD accumulates excess hours in the overtime account; TRACK_ONLY records excess hours without growing the saldo.
**Requirements**: SCHED-01, SCHED-02, SCHED-03
**Depends on:** Phase 12

### Phase 14: Weekday Configuration & Per-Day Soll

**Goal:** Allow admins to configure which weekdays a MONTHLY_HOURS employee regularly works, and display a per-day Soll in the calendar (budget / working days in month).
**Requirements**: SCHED-04, SCHED-05
**Depends on:** Phase 13
**Plans:** 2/2 plans complete

Plans:
- [x] 14-01-PLAN.md — API tests + saveEmployee bug fix + weekday toggle chip picker
- [x] 14-02-PLAN.md — Calendar per-day Soll computation and display

### Phase 15: Tenant Holiday Deduction Configuration

**Goal:** Allow tenant admins to configure whether public holidays on a MONTHLY_HOURS employee's configured workdays reduce the monthly Soll.
**Requirements**: TENANT-01
**Depends on:** Phase 14
**Plans:** 3 plans

Plans:
- [ ] 15-01-PLAN.md — Schema field + Settings API + toggle persistence test
- [ ] 15-02-PLAN.md — Backend holiday deduction logic at all 4 computation sites
- [ ] 15-03-PLAN.md — Frontend admin toggle + calendar Soll display

## Backlog

### SCHED-V14-01: Per-day hour allocation for MONTHLY_HOURS

**Description:** Allow admins to specify exact hours per weekday (e.g. Mo 4h, Fr 6h) instead of equal-split from monthly budget. Currently weekday chips are boolean only (work/don't work), with implicit equal distribution across working days. This enhancement would enable flexible schedules like split-week arrangements or graduated hours.

**Status:** Backlog — candidate for Phase 16+
**Related:** Phase 14 (Weekday Configuration)
