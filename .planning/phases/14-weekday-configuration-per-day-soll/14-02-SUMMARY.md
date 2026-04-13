---
phase: 14-weekday-configuration-per-day-soll
plan: "02"
subsystem: time-entries-calendar
tags: [MONTHLY_HOURS, per-day-soll, calendar-display, SCHED-05]
dependency_graph:
  requires: [14-01]
  provides: [SCHED-05-per-day-soll-display]
  affects: [apps/web/src/routes/(app)/time-entries/+page.svelte]
tech_stack:
  added: []
  patterns: [dailySollMin computation, isConfiguredWorkday check, countWorkingDaysInMonth helper]
key_files:
  created: []
  modified:
    - apps/web/src/routes/(app)/time-entries/+page.svelte
decisions:
  - "dailySollMin = Math.round(monthlyBudgetMin / workingDays) — rounding avoids fractional minutes in the display"
  - "isConfiguredWorkday reuses same DOW_KEYS array pattern as getDayExpected for consistency"
  - "Status logic falls through to generic ok/partial/missing for configured MONTHLY_HOURS days (expectedMin > 0) — no special-casing needed once monthly && expectedMin === 0 guards pure-flexible mode"
  - "Leave/holiday zeroing of expectedMin kept as-is for MONTHLY_HOURS — consistent with FIXED_WEEKLY behavior per D-10"
metrics:
  duration: "~10 minutes"
  completed_date: "2026-04-13"
  tasks_completed: 2
  files_changed: 1
---

# Phase 14 Plan 02: Per-day Soll for MONTHLY_HOURS Calendar Summary

**One-liner:** Per-day Soll display in the time-entries calendar for MONTHLY_HOURS employees with configured weekdays — dailySoll = monthlyBudget / workingDaysInMonth, with green/red delta and missing-hours indicators via expectedMin gate.

## What Was Built

**Task 1: Add helpers, fix makeCalDay expectedMin and status logic for MONTHLY_HOURS**

Added two helper functions after `getDayExpected`:

- `isConfiguredWorkday(sched, date)` — returns true when the day-of-week field (mondayHours...sundayHours) is > 0 for the given schedule
- `countWorkingDaysInMonth(monthStart, sched)` — iterates all days in the month and counts those where the DOW field is > 0; uses the already-imported `endOfMonth` from date-fns

Modified `buildCalendarDays` to compute `dailySollMin` before building calendar cells:
```typescript
let dailySollMin = 0;
if (monthly && sched) {
  const monthlyBudgetMin = Number(sched.monthlyHours ?? 0) * 60;
  if (monthlyBudgetMin > 0) {
    const workingDays = countWorkingDaysInMonth(monthStart, sched);
    if (workingDays > 0) dailySollMin = Math.round(monthlyBudgetMin / workingDays);
  }
}
```

Extended `makeCalDay` signature with `dailySollMin: number = 0` as 9th parameter and updated all 3 call sites.

Fixed `makeCalDay` expectedMin logic:
- Before: `let expectedMin = monthly ? 0 : sched ? getDayExpected(sched, date) * 60 : 0;`
- After: if monthly, uses `dailySollMin` on configured workdays, 0 on non-configured days

Fixed status block condition:
- Before: `else if (monthly) { ... noExpect for all ... }`
- After: `else if (monthly && expectedMin === 0) { ... }` — configured days fall through to generic ok/partial/missing logic

**Task 2: Remove calendar cell guards blocking MONTHLY_HOURS delta display**

Removed `!isMonthlyHours &&` from two template guards in the calendar cell:
- Delta display: `{#if !isMonthlyHours && day.expectedMin > 0}` → `{#if day.expectedMin > 0}`
- Missing hours: `{:else if day.isCurrentMonth && !isMonthlyHours && day.expectedMin > 0 && !day.isFuture}` → `{:else if day.isCurrentMonth && day.expectedMin > 0 && !day.isFuture}`

`day.expectedMin > 0` is now the semantically correct gate: non-configured MONTHLY_HOURS weekdays have `expectedMin = 0` so no delta appears; configured weekdays have `expectedMin = dailySollMin > 0` so delta renders.

## Commits

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add helpers, fix makeCalDay expectedMin and status logic | 42904f3 | time-entries/+page.svelte |
| 2 | Remove !isMonthlyHours guards from calendar cell delta display | c917636 | time-entries/+page.svelte |

## Deviations from Plan

None — plan executed exactly as written.

## Verification Results

- `grep -c "function countWorkingDaysInMonth"` → 1
- `grep -c "function isConfiguredWorkday"` → 1
- `grep -c "dailySollMin"` → 8 (parameter declaration, computation, 3 makeCalDay calls, expectedMin assignment)
- `grep -c "!isMonthlyHours && day.expectedMin"` → 0 (guards fully removed)
- `grep -c "monthly && expectedMin === 0"` → 1 (fixed status condition)
- `grep -c "let expectedMin = monthly"` → 0 (old one-liner replaced by if/else block)
- `endOfMonth` import still present in date-fns import line

## Known Stubs

None — per-day Soll computation is fully wired from WorkSchedule data through calendar rendering.

## Threat Flags

No new security surface introduced. All computation is client-side display only from already-fetched WorkSchedule data. The calendar is a read-only view; no new endpoints, auth paths, or data exposure beyond what monthlyHours already reveals.

## Self-Check: PASSED

- `42904f3` commit exists: verified via git log
- `c917636` commit exists: verified via git log
- `apps/web/src/routes/(app)/time-entries/+page.svelte` modified: confirmed
