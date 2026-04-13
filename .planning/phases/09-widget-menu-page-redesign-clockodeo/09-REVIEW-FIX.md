---
phase: 09-widget-menu-page-redesign-clockodeo
fixed_at: 2026-04-13T12:30:00Z
review_path: .planning/phases/09-widget-menu-page-redesign-clockodeo/09-REVIEW.md
iteration: 1
findings_in_scope: 5
fixed: 5
skipped: 0
status: all_fixed
---

# Phase 09: Code Review Fix Report

**Fixed at:** 2026-04-13T12:30:00Z
**Source review:** .planning/phases/09-widget-menu-page-redesign-clockodeo/09-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 5 (WR-01 through WR-05; no Critical findings; Info findings out of scope)
- Fixed: 5
- Skipped: 0

## Fixed Issues

### WR-01: Unsafe `e.date.split()` in `arbzgDayMap` derived block

**Files modified:** `apps/web/src/routes/(app)/time-entries/+page.svelte`
**Commit:** fc64619
**Applied fix:** Replaced `e.date.split("T")[0]` with `(e.date ?? e.startTime).split("T")[0]` at line 757, matching the defensive null-coalescing pattern already used in the `allEntries` sort on line 771. Prevents a runtime crash when NFC-sourced or clock-in/out entries omit the `date` field.

---

### WR-02: `isAnonymized()` uses a hardcoded German sentinel string

**Files modified:** `apps/web/src/routes/(app)/admin/employees/+page.svelte`
**Commit:** efcc8fe
**Applied fix:** Added a second condition `emp.lastName.startsWith("GELÖSCHT-")` to the existing `emp.firstName === "Gelöscht"` check, matching the exact two-field sentinel pattern documented in CLAUDE.md's DSGVO anonymization spec. Added a comment linking to the anonymization flow. This prevents a real employee named "Gelöscht" from being misclassified and having the hard-delete button exposed.

---

### WR-03: `phSaved` success indicator is never auto-reset

**Files modified:** `apps/web/src/routes/(app)/admin/system/+page.svelte`
**Commit:** 3bbd195
**Applied fix:** Added `setTimeout(() => (phSaved = false), 3000)` immediately after `phSaved = true` in `savePhorest()`. This matches the 3-second auto-reset pattern used by all other save functions in the same file (`stateSaved`, `datevSaved`, `smtpSaved`, `sessionSaved`, `pwSaved`, `emailSaved`).

---

### WR-04: `pollDashboard()` fetches team-week data for non-manager users

**Files modified:** `apps/web/src/routes/(app)/dashboard/+page.svelte`
**Commit:** 9b0a726
**Applied fix:** Wrapped the `await loadTeamWeek()` call in `pollDashboard()` with an `if (isManager)` guard. Regular employees no longer issue a `GET /dashboard/team-week` request every 5 seconds. The clock-in status refresh (the try/catch block below) continues to run unconditionally for all users as intended.

---

### WR-05: `saveDatev()` sends a partial `PUT /settings/work` payload

**Files modified:** `apps/web/src/routes/(app)/admin/system/+page.svelte`
**Commit:** bb480bb
**Applied fix:** Added `if (!_gOtherFields) return;` guard (matching `saveFederalState()`) and spread `..._gOtherFields, federalState: gFederalState, timezone: gTimezone` into the `api.put("/settings/work", ...)` call alongside the four DATEV fields. This ensures a full work-settings payload is sent, preventing silent overwrite of federal state, timezone, weekly hours, vacation days, and all other tenant work config fields.

---

_Fixed: 2026-04-13T12:30:00Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
