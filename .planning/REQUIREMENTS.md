# Requirements: Clokr v1.4

**Defined:** 2026-04-25
**Core Value:** Reliable, secure, legally compliant time tracking SaaS ready for live customers

## v1.4 Requirements

### Navigation & Routing

- [x] **NAV-01**: Personal time-entries page shows only own data (employee selector removed)
- [x] **NAV-02**: Personal leave page shows only own requests (team approval tab removed)
- [x] **NAV-03**: Manager can access dedicated team time-entries page at `/team/time-entries`
- [x] **NAV-04**: Manager can access dedicated team leave page at `/team/leave`
- [x] **NAV-05**: Sidebar MANAGER group shows "Team-Zeiten" and "Team-Abwesenheiten" nav items

### Team

- [ ] **TEAM-01**: Manager can view time entries of any team member on team time-entries page
- [ ] **TEAM-02**: Manager can create/edit time entries for team members (correction workflow)
- [x] **TEAM-03**: Manager can approve/reject leave requests on team leave page
- [ ] **TEAM-04**: Manager can filter employees by name search on team pages

### Reports & Exports

- [ ] **RPT-01**: Reports page redesigned with modernized Glass-Design (charts, tables, export buttons)
- [ ] **RPT-02**: Reports page has month/year period selector on all widgets
- [x] **RPT-03**: Manager can export single employee as DATEV LODAS TXT
- [x] **RPT-04**: Manager can export single employee as PDF (tabellarischer Stundennachweis)

### UI Polish

- [x] **UI-01**: Schichten page has Glass-Card frame
- [x] **UI-02**: NFC-Terminal overview page has Glass-Card frame

## Future Requirements

### Deferred (v1.5+)

- **UI-15**: Mobile 390px overflow check + 44px touch targets audit — after v1.4 UI restructuring
- **RPT-05**: Batch approve leave requests from team page
- **RPT-06**: Leave balance bar chart in Reports
- **RPT-07**: Drill-down detail view from Reports widgets
- **RPT-08**: Carry-over expiry warnings in Reports
- **RPT-09**: PDF with company branding + signature fields

## Out of Scope

| Feature | Reason |
|---------|--------|
| Department/Abteilung filter | Requires Abteilung as first-class entity (schema migration) |
| Excel/CSV export | Diverges from DATEV-first positioning |
| Real-time presence WebSocket | Complexity without proportional value |
| Manager self-approval from team page | Self-approval block is a compliance requirement |
| Server-side route protection | hooks.server.ts never decodes JWTs; client-side onMount guard is the correct pattern |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| NAV-01 | Phase 17 | Complete |
| NAV-02 | Phase 17 | Complete |
| NAV-03 | Phase 18 | Complete |
| NAV-04 | Phase 18 | Complete |
| NAV-05 | Phase 18 | Complete |
| TEAM-01 | Phase 19 | Pending |
| TEAM-02 | Phase 19 | Pending |
| TEAM-04 | Phase 19 | Pending |
| TEAM-03 | Phase 20 | Complete |
| RPT-03 | Phase 21 | Complete |
| RPT-04 | Phase 21 | Complete |
| RPT-01 | Phase 22 | Pending |
| RPT-02 | Phase 22 | Pending |
| UI-01 | Phase 23 | Complete |
| UI-02 | Phase 23 | Complete |

**Coverage:**
- v1.4 requirements: 15 total
- Mapped to phases: 15
- Unmapped: 0 ✓

---
*Requirements defined: 2026-04-25*
*Last updated: 2026-04-25 — traceability mapped to Phases 17-23*
