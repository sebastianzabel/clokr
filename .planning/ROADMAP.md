# Roadmap: Clokr

## Milestones

- ✅ **v1.0 Production Readiness** — Phases 1-3 (shipped 2026-03-31)
- ✅ **v1.1 Reporting & DATEV** — Phases 4-7 (shipped 2026-04-12)
- ✅ **v1.2 UI Polish** — Phases 8-10 (shipped 2026-04-13)
- ✅ **v1.3 Monthly Hours Overhaul** — Phases 11-16 (shipped 2026-04-14)
- 🚧 **v1.4 Manager/MA-Trennung & Reports** — Phases 17-23 (in progress)

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

### 🚧 v1.4 Manager/MA-Trennung & Reports (In Progress)

**Milestone Goal:** Clean separation between personal employee views and manager team views, with a modernised Reports page and per-employee export endpoints.

- [x] **Phase 17: Personal Page Cleanup** — Remove employee selector and team approval tab from personal pages (completed 2026-04-25)
- [x] **Phase 18: Team Route Scaffold & Sidebar Nav** — Create `/team/*` routes and MANAGER sidebar group (completed 2026-04-25)
- [ ] **Phase 19: Team Time-Entries Page** — Manager view of team time entries with correction workflow
- [x] **Phase 20: Team Leave Page** — Manager view of team leave requests with approval/rejection (completed 2026-04-25)
- [x] **Phase 21: Per-Employee Export API** — Single-employee DATEV LODAS and PDF export endpoints (completed 2026-04-25)
- [ ] **Phase 22: Reports Page Redesign** — Glass-design modernization with period selector and export buttons
- [x] **Phase 23: Glass-Card UI Polish** — Schichten and NFC-Terminal pages get glass-card frames (completed 2026-04-25)

## Phase Details

### Phase 17: Personal Page Cleanup
**Goal**: Personal pages show only the logged-in employee's own data — no employee selector, no team-approval tab
**Depends on**: Phase 16
**Requirements**: NAV-01, NAV-02
**Success Criteria** (what must be TRUE):
  1. An employee opening Zeiterfassung sees only their own calendar with no dropdown to switch to another employee
  2. An employee opening Abwesenheiten sees only their own leave requests with no "Team-Genehmigung" tab
  3. A manager opening Zeiterfassung sees only their own personal data (same as any employee)
  4. A manager opening Abwesenheiten sees only their own leave requests (same as any employee)
**Plans**: 2 plans

Plans:
- [x] 17-01-PLAN.md — Remove employee selector from Zeiterfassung page (NAV-01)
- [x] 17-02-PLAN.md — Remove approvals tab and employee selector from Abwesenheiten page (NAV-02)
**UI hint**: yes

### Phase 18: Team Route Scaffold & Sidebar Nav
**Goal**: The sidebar MANAGER group exposes "Team-Zeiten" and "Team-Abwesenheiten" links that route to new, manager-only pages
**Depends on**: Phase 17
**Requirements**: NAV-03, NAV-04, NAV-05
**Success Criteria** (what must be TRUE):
  1. A manager sees a "Team-Zeiten" link in the sidebar that navigates to `/team/time-entries`
  2. A manager sees a "Team-Abwesenheiten" link in the sidebar that navigates to `/team/leave`
  3. An employee (non-manager) does not see the MANAGER sidebar group
  4. Navigating directly to `/team/time-entries` or `/team/leave` as an employee shows an access-denied state
**Plans**: 2 plans

Plans:
- [x] 18-01-PLAN.md — Add Team-Zeiten and Team-Abwesenheiten nav items to sidebar (NAV-05)
- [x] 18-02-PLAN.md — Create team layout role guard and placeholder pages (NAV-03, NAV-04)
**UI hint**: yes

### Phase 19: Team Time-Entries Page
**Goal**: Managers can view, create, and edit time entries for any team member from a dedicated team page with name-search filtering
**Depends on**: Phase 18
**Requirements**: TEAM-01, TEAM-02, TEAM-04
**Success Criteria** (what must be TRUE):
  1. A manager can select any employee from a searchable dropdown on the team time-entries page
  2. The selected employee's time entry calendar renders correctly with the same data as the personal view
  3. A manager can create a new time entry on behalf of a team member and the entry appears in that employee's calendar
  4. A manager can edit an existing time entry for a team member and the change is saved
  5. Typing a name fragment in the employee search filters the dropdown list in real time
**Plans**: 1 plan

Plans:
- [ ] 19-01-PLAN.md — Replace placeholder with full team time-entries page (TEAM-01, TEAM-02, TEAM-04)
**UI hint**: yes

### Phase 20: Team Leave Page
**Goal**: Managers can review and approve or reject pending leave requests for their team from a dedicated page
**Depends on**: Phase 19
**Requirements**: TEAM-03
**Success Criteria** (what must be TRUE):
  1. A manager can see all pending leave requests across the team on `/team/leave`
  2. A manager can approve a pending leave request and the status changes to APPROVED immediately
  3. A manager can reject a pending leave request with an optional reason and the status changes to REJECTED
  4. Approved and rejected requests are shown in a separate historical list
**Plans**: 1 plan

Plans:
- [x] 20-01-PLAN.md — Replace placeholder with full team leave page (TEAM-03)
**UI hint**: yes

### Phase 21: Per-Employee Export API
**Goal**: The API exposes endpoints that generate a single-employee DATEV LODAS TXT file and a single-employee PDF Stundennachweis for a given month
**Depends on**: Phase 16
**Requirements**: RPT-03, RPT-04
**Success Criteria** (what must be TRUE):
  1. A manager can download a DATEV LODAS TXT file for a single employee and a specific month via a GET request
  2. The DATEV TXT output passes the same CP1252/CRLF/INI-section format checks as the company-wide export
  3. A manager can download a tabular PDF Stundennachweis for a single employee and a specific month via a GET request
  4. The PDF lists each day with start time, end time, break minutes, and worked hours in the correct month
**Plans**: 1 plan

Plans:
- [x] 21-01-PLAN.md — Extract buildDatevLodas() + add per-employee DATEV endpoint (RPT-03, RPT-04)

### Phase 22: Reports Page Redesign
**Goal**: The Reports page is fully redesigned with glass-card layout, a month/year period selector on every widget, and export buttons wired to the per-employee endpoints
**Depends on**: Phase 21
**Requirements**: RPT-01, RPT-02
**Success Criteria** (what must be TRUE):
  1. The Reports page uses glass-card surfaces and token-based styling consistent with the rest of the v1.2 design system
  2. Every widget on the Reports page has a month/year period selector that filters its data independently
  3. A manager can click an export button next to an employee row and download their DATEV LODAS TXT for the selected period
  4. A manager can click an export button next to an employee row and download their PDF Stundennachweis for the selected period
**Plans**: 1 plan

Plans:
- [ ] 22-01-PLAN.md — Glass-card redesign, shared period selector, per-employee export buttons (RPT-01, RPT-02)
**UI hint**: yes

### Phase 23: Glass-Card UI Polish
**Goal**: The Schichten (shift schedule) page and the NFC-Terminal overview page are wrapped in glass-card frames matching the v1.2 design system
**Depends on**: Phase 17
**Requirements**: UI-01, UI-02
**Success Criteria** (what must be TRUE):
  1. The Schichten page top-level content block uses `var(--glass-bg)`, `var(--glass-border)`, and `var(--glass-shadow)` surfaces
  2. The NFC-Terminal overview page top-level content block uses the same glass-card token set
  3. Both pages pass a visual check in all three themes (lila, hell, dunkel) without colour contrast issues
**Plans**: 1 plan

Plans:
- [x] 23-01-PLAN.md — Apply glass tokens to Schichten grid wrapper + extract NFC section into own card (UI-01, UI-02)
**UI hint**: yes

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Test Infrastructure | v1.0 | 3/3 | Complete | 2026-03-31 |
| 2. Security Hardening | v1.0 | 6/6 | Complete | 2026-03-31 |
| 3. UI/UX Polish | v1.0 | 6/6 | Complete | 2026-03-31 |
| 4. DATEV Cleanup | v1.1 | 4/4 | Complete | 2026-04-11 |
| 5. Saldo Performance | v1.1 | 3/3 | Complete | 2026-04-11 |
| 6. PDF Exports | v1.1 | 2/2 | Complete | 2026-04-11 |
| 7. Reporting Dashboards | v1.1 | 3/3 | Complete | 2026-04-12 |
| 8. Design System Foundation | v1.2 | 4/4 | Complete | 2026-04-13 |
| 9. Widget/Menu/Page Redesign | v1.2 | 3/3 | Complete | 2026-04-13 |
| 10. Calendar Redesign | v1.2 | 2/2 | Complete | 2026-04-13 |
| 11. Schema Bug Fixes | v1.3 | 2/2 | Complete | 2026-04-13 |
| 12. Lock Enforcement | v1.3 | 3/3 | Complete | 2026-04-13 |
| 13. Overtime Handling Mode | v1.3 | 3/3 | Complete | 2026-04-13 |
| 14. Weekday Config & Per-Day Soll | v1.3 | 2/2 | Complete | 2026-04-13 |
| 15. Tenant Holiday Deduction | v1.3 | 3/3 | Complete | 2026-04-13 |
| 16. BUrlG H2 Exit Rule | v1.3 | 2/2 | Complete | 2026-04-25 |
| 17. Personal Page Cleanup | v1.4 | 2/2 | Complete   | 2026-04-25 |
| 18. Team Route Scaffold & Sidebar Nav | v1.4 | 2/2 | Complete   | 2026-04-25 |
| 19. Team Time-Entries Page | v1.4 | 0/1 | Not started | - |
| 20. Team Leave Page | v1.4 | 1/1 | Complete   | 2026-04-25 |
| 21. Per-Employee Export API | v1.4 | 1/1 | Complete   | 2026-04-25 |
| 22. Reports Page Redesign | v1.4 | 0/1 | Not started | - |
| 23. Glass-Card UI Polish | v1.4 | 1/1 | Complete   | 2026-04-25 |

## Backlog

### SCHED-V14-01: Per-day hour allocation for MONTHLY_HOURS

**Description:** Allow admins to specify exact hours per weekday (e.g. Mo 4h, Fr 6h) instead of equal-split from monthly budget. Currently weekday chips are boolean only (work/don't work), with implicit equal distribution across working days. This enhancement would enable flexible schedules like split-week arrangements or graduated hours.

**Status:** Backlog — candidate for v1.5+
**Related:** Phase 14 (Weekday Configuration)
