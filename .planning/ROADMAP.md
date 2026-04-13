# Roadmap: Clokr

## Milestones

- ✅ **v1.0 Production Readiness** — Phases 1-3 (shipped 2026-03-31)
- ✅ **v1.1 Reporting & DATEV** — Phases 4-7 (shipped 2026-04-12)
- ✅ **v1.2 UI Polish** — Phases 8-10 (shipped 2026-04-13)
- 🔄 **v1.3 Monthly Hours Overhaul** — Phases 11-12 (in progress)

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
<summary>🔄 v1.3 Monthly Hours Overhaul (Phases 11-12) — IN PROGRESS</summary>

- [x] Phase 11: Schema Bug Fixes — MONTHLY_HOURS (2/2 plans) — completed 2026-04-13
- [ ] Phase 12: Monatsabschluss Lock Enforcement (0/3 plans)

Plans:
- [ ] 12-01-PLAN.md — API: POST lock guard + unlock endpoint + grace period
- [ ] 12-02-PLAN.md — UI: lock indicators, Entsperren button, hidden controls
- [ ] 12-03-PLAN.md — Tests: lock enforcement integration test suite

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
| 12. Lock Enforcement          | v1.3 | 0/3 | Planned  | —          |

### Phase 12: Monatsabschluss Lock Enforcement

**Goal:** Enforce `isLocked` on time-entry mutations (POST create previously unguarded), add `POST /overtime/unlock-month` endpoint with atomic snapshot deletion and full audit log, grace period for auto-close, and proactive UI lock feedback (indicators, hidden controls, Entsperren button).
**Requirements**: BUG-02
**Depends on:** Phase 11
**Plans:** 3 plans

Plans:
- [ ] 12-01-PLAN.md — API: POST lock guard (D-04, D-05) + unlock endpoint (D-01, D-02, D-03) + grace period + earlyClose (D-11, D-12)
- [ ] 12-02-PLAN.md — UI: monthIsLocked derived (D-06) + lock icons (D-07) + hidden controls (D-08) + Abgeschlossen badge (D-09) + Entsperren button (D-10)
- [ ] 12-03-PLAN.md — Tests: integration test suite for all Phase 12 API behaviors
