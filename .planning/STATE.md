---
gsd_state_version: 1.0
milestone: v1.4
milestone_name: Manager/MA-Trennung & Reports
status: executing
stopped_at: Completed 25-04-PLAN.md
last_updated: "2026-05-11T19:23:45.364Z"
last_activity: 2026-05-11
progress:
  total_phases: 7
  completed_phases: 7
  total_plans: 9
  completed_plans: 9
  percent: 100
---

## Current Position

Phase: 25 (wifi-presence-stempel-fritzbox) — EXECUTING
Plan: 7 of 9
Status: Ready to execute
Last activity: 2026-05-11

Progress: [████████░░] 83%

## Project Reference

See: .planning/PROJECT.md (updated 2026-04-25)

**Core value:** Reliable, secure, legally compliant time tracking SaaS ready for live customers
**Current focus:** Phase 25 — wifi-presence-stempel-fritzbox

## Performance Metrics

**Velocity:**

- Total plans completed: 47 (across v1.0–v1.3)
- Average duration: ~30 min/plan (estimated)
- Total execution time: ~24 hours (v1.0–v1.3)

**Recent Trend:**

- v1.3: 11 plans, 5 phases in 1 day
- Trend: Stable

*Updated after each plan completion*

## Accumulated Context

### Roadmap Evolution

- Phase 24 added (2026-05-11): v1.4 UAT Fixes — 3 bugs (DATEV permissions, DATEV header, month filter) + 1 small feature (manager-creates-absences)

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting v1.4:

- [v1.4 research]: Personal page cleanup first — removes merge conflict risk for team route additions
- [v1.4 research]: DATEV utility extraction (Phase 21) prerequisite before Reports wires export buttons (Phase 22)
- [v1.4 research]: Glass-card polish (Phase 23) independent of all team/routing work — lowest risk, do last
- [v1.4 research]: TEAM-04 (employee name search filter) assigned to Phase 19 — pattern established there, reused in Phase 20
- [v1.3]: Server-side route protection out of scope — hooks.server.ts never decodes JWTs; onMount guard is the correct pattern
- [Phase 17-personal-page-cleanup]: Remove unlock button from personal Zeiterfassung page entirely — it was a manager-only action that moves to team pages in later phases
- [Phase 17-personal-page-cleanup]: Personal time-entries page now uses ownEmployeeId directly with no selectedEmployeeId indirection — own-data-only scope
- [Phase 17-personal-page-cleanup]: iCal team export ungated from isManager — all employees can download team absence calendar
- [Phase 18-team-route-scaffold-sidebar-nav]: Team nav items inserted before Berichte/Admin so team tools are discoverable first in manager sidebar
- [Phase 18-team-route-scaffold-sidebar-nav]: Team layout is transparent pass-through (no chrome/tabs) — individual pages own their layout
- [Phase 18-team-route-scaffold-sidebar-nav]: Placeholder pages intentionally scaffold for Phase 19 and 20 full implementations
- [Phase 19-team-time-entries-page]: Fork personal page rather than build from scratch — ensures full feature parity (ArbZG, lock enforcement, MONTHLY_HOURS, break slots)
- [Phase 19-team-time-entries-page]: onMount defers loadAll() until employee selected — no wasted API call on page load
- [Phase 19-team-time-entries-page]: Manager POST uses source=CORRECTION (not MANUAL) to distinguish manager corrections in audit trail
- [Phase 20-team-leave-page]: Team leave page forks personal leave page: no submit form, team-wide data, approval code restored from pre-Phase-17 history
- [Phase 21-per-employee-export-api]: buildDatevLodas() kept module-scope (not exported) to avoid leaking DATEV format details outside reports.ts
- [Phase 23-glass-card-ui-polish]: Promoted NFC-Terminals h3/p title to section-label div to match API Keys reference pattern
- [Phase 25]: PresenceSource uses soft-delete (deletedAt); PresenceDevice uses onDelete: Cascade to Employee; Employee.wifiMacs coexists with PresenceDevice for webhook fallback lookup; wifiPresenceEnabled=false enforces GDPR opt-in
- [Phase 25]: Overnight shift detected by numeric HH:MM comparison; endDay+1 avoids schema changes
- [Phase 25]: normalizeMac strip-first approach handles all MAC formats in one pass
- [Phase 25]: tenantId_mac uniqueness: MAC deduplication is per-tenant (not per-employee) — actual constraint from plan 25-01 schema
- [Phase 25]: wifiOptInAt never nulled on opt-out — preserves GDPR consent withdrawal trace
- [Phase 25]: purgeable flag intentionally absent from all wifi consent audit entries — consent events permanently retained
- [Phase 25]: Use minimum tenant retention (most restrictive) as global AuditLog purge cutoff since AuditLog has no tenantId
- [Phase 25]: Hard-delete purgeable=true AuditLog rows justified by DSGVO Art. 5(1)(e) — WiFi-presence-only events are not payroll-relevant
- [Phase 25]: Presence webhook uses direct prisma.auditLog.create (not app.audit) for purgeable field support; Employee lookup uses user.isActive=true (no deletedAt on Employee model)
- [Phase 25]: GET /opted-in registered before /:id routes to prevent Fastify path collision
- [Phase 25]: Soft delete sets both deletedAt and isActive=false (audit-proof, never hard-delete)

### Pending Todos

None yet.

### Blockers/Concerns

None yet.

## Session Continuity

Last session: 2026-05-11T19:23:45.360Z
Stopped at: Completed 25-04-PLAN.md
Resume file: None
