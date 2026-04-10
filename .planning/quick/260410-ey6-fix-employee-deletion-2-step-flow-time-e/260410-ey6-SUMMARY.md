---
phase: quick-260410-ey6
plan: 01
subsystem: api, web/admin, web/time-entries, web/leave
tags: [bug-fix, dsgvo, retention, audit-proof, ux, month-navigation]
dependency_graph:
  requires: []
  provides:
    - "DELETE /api/v1/employees/:id/hard-delete (retention-gated, audit-logged)"
    - "2-step employee deletion UI (anonymize + hard-delete) in admin/employees"
    - "Month navigation in time-entries list view"
    - "Month navigation + client-side month filter in leave list view"
  affects:
    - apps/api/src/routes/employees.ts
    - apps/web/src/routes/(app)/admin/employees/+page.svelte
    - apps/web/src/routes/(app)/time-entries/+page.svelte
    - apps/web/src/routes/(app)/leave/+page.svelte
tech_stack:
  added: []
  patterns:
    - "Prisma $transaction with manual ordered delete for Restrict-protected relations"
    - "Client-side month overlap filter in $derived"
    - "Cross-year data reload on month navigation"
key_files:
  created: []
  modified:
    - apps/api/src/routes/employees.ts
    - apps/web/src/routes/(app)/admin/employees/+page.svelte
    - apps/web/src/routes/(app)/time-entries/+page.svelte
    - apps/web/src/routes/(app)/leave/+page.svelte
decisions:
  - "Hard-delete is gated by DEFAULT_RETENTION_YEARS=10 (§147 AO) — no admin bypass"
  - "Retention period expires at end of calendar year of (exitDate ?? createdAt + 10 years)"
  - "doAnonymize() calls loadEmployees() to refresh UI state instead of local array mutation"
  - "filteredMyRequests month filter uses overlap logic: reqEnd >= monthStart && reqStart <= monthEnd"
  - "Leave data reload on year-boundary navigation only (not on every month change)"
metrics:
  duration_minutes: 40
  completed_date: "2026-04-10"
  tasks_completed: 4
  tasks_total: 5
  files_modified: 4
---

# Quick Task 260410-ey6: Fix Employee Deletion 2-Step Flow + Time Entries / Leave Month Navigation

**One-liner:** DSGVO-compliant 2-step employee deletion (anonymize → hard-delete with 10-year retention gate + audit log) plus month navigation exposed in both time-entries and leave list views.

## Summary

Three user-facing bugs are now fixed:

**Bug 1 — Employee deletion was misleading:**
The admin UI previously showed a single "Löschen" button that claimed to perform "unwiderruflich" deletion but only anonymized. It now implements a proper 2-step flow:
1. **Anonymisieren** — for active employees. Modal explains DSGVO purpose and retention (10 years, §147 AO). Calls existing `DELETE /employees/:id` (anonymize) endpoint.
2. **Endgültig löschen** — only visible on already-anonymized employees. Calls new `DELETE /employees/:id/hard-delete`. Inline error display for the 409 retention gate.

A new "Anonymisierte anzeigen" toggle hides anonymized rows by default to keep the list clean.

**Bug 2 — Time entries list view had no month navigation:**
The `<div class="cal-nav">` block was nested inside `{#if teView === "calendar"}`. It is now moved outside and rendered for both calendar and list views. The `gotoMonth()` function already called `loadAll()` so list view reloads correctly.

**Bug 3 — Leave list showed the entire year:**
The list view had no month filter and no navigation. Now:
- A month nav bar (prev/title/next/Heute) appears above the list.
- `filteredMyRequests` applies an overlap filter: include request if `[startDate, endDate]` overlaps the selected month.
- `prevMonth()`/`nextMonth()`/`gotoMonthYear()`/`gotoToday()` call `loadData()` when the year changes (cross-year navigation reloads from API).

## API Changes

### New: `DELETE /api/v1/employees/:id/hard-delete`
- **Auth:** ADMIN only
- **Guards:**
  - 404 if employee not found in tenant
  - 409 `"Mitarbeiter muss zuerst anonymisiert werden"` if not yet anonymized
  - 409 `"Aufbewahrungsfrist noch nicht abgelaufen"` + `retentionExpiresAt` ISO string if within retention period
- **Retention:** `retentionStart = exitDate ?? createdAt`, expires at `end of calendar year of (retentionStart + DEFAULT_RETENTION_YEARS)` where `DEFAULT_RETENTION_YEARS = 10` (§147 AO)
- **Audit log BEFORE deletion:** action=`"HARD_DELETE"`, entity=`"Employee"`, with employeeNumber + userEmail + retentionStart
- **Transaction delete order:** Break → TimeEntry → LeaveRequest → Absence → LeaveEntitlement → WorkSchedule → OvertimeAccount → Employee → User
- **Returns:** 204

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| 1    | b75d869 | feat(260410-ey6-01): add DELETE /:id/hard-delete endpoint with retention check |
| 2    | 3f6ed2f | feat(260410-ey6-01): 2-step employee deletion UI — anonymize + hard-delete |
| 3    | 8114f9e | feat(260410-ey6-01): expose month navigation in time-entries list view |
| 4    | c82eadb | feat(260410-ey6-01): add month nav and client-side month filter to leave list view |

## Deviations from Plan

None — plan executed exactly as written.

The constraint instructions specified skipping the checkpoint:human-verify task (Task 5) and proceeding to PR creation.

## Audit-Proof Compliance Notes

- The existing anonymize route (`DELETE /:id`) is untouched.
- `HARD_DELETE` audit log is written **before** any delete operations — the entity ID remains traceable in the audit trail even after the record is gone.
- `DEFAULT_RETENTION_YEARS = 10` matches §147 AO / §257 HGB (longest applicable retention). No admin bypass parameter was added.
- The retention end date is computed as `new Date(retentionStart.getFullYear() + 10, 11, 31, 23, 59, 59)` — calendar year end, not rolling.
- Delete order in transaction follows Prisma `onDelete: Restrict` dependency graph: Break first (nested under TimeEntry), then the three Restrict-protected models, then cascade-owned models, then the root records.

## Known Stubs

None. All functionality is fully wired.

## Self-Check: PASSED

- `apps/api/src/routes/employees.ts` — modified with hard-delete route ✓
- `apps/web/src/routes/(app)/admin/employees/+page.svelte` — modified with 2-step UI ✓
- `apps/web/src/routes/(app)/time-entries/+page.svelte` — modified with exposed month nav ✓
- `apps/web/src/routes/(app)/leave/+page.svelte` — modified with list nav + filter ✓
- Commits b75d869, 3f6ed2f, 8114f9e, c82eadb all present ✓
- `pnpm --filter @clokr/api typecheck` passes ✓
- `pnpm --filter @clokr/web typecheck` passes ✓
