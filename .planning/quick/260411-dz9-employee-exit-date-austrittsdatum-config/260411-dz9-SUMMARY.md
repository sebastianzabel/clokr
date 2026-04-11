---
phase: quick
plan: 260411-dz9
subsystem: leave-management
tags: [BUrlG, pro-rata, exitDate, vacation, audit, german-law]
dependency_graph:
  requires: []
  provides:
    [calculateProRataVacation, exitDate-PATCH-employees, proRataWarning-API, Austrittsdatum-UI]
  affects:
    [
      apps/api/src/routes/employees.ts,
      apps/api/src/routes/leave.ts,
      apps/web/src/routes/(app)/admin/employees/+page.svelte,
      apps/web/src/routes/(app)/leave/+page.svelte,
    ]
tech_stack:
  added: []
  patterns: [pro-rata calculation, non-blocking warning payload, frontend derived warning]
key_files:
  created: [apps/api/src/utils/__tests__/vacation-calc.test.ts (extended)]
  modified:
    - apps/api/src/utils/vacation-calc.ts
    - apps/api/src/routes/employees.ts
    - apps/api/src/routes/leave.ts
    - apps/web/src/routes/(app)/admin/employees/+page.svelte
    - apps/web/src/routes/(app)/leave/+page.svelte
decisions:
  - "Pro-rata warning is informational only (non-blocking) — approval and save always succeed"
  - "Frontend duplicates inline pro-rata calculation to avoid cross-package import"
  - "exitDate persisted via PATCH /employees/:id (separate from /deactivate which manages isActive)"
  - "Warning computation wrapped in try/catch: silently skipped if VACATION leave type not found"
metrics:
  duration: 25min
  completed: "2026-04-11"
  tasks: 3
  files: 5
---

# Phase quick Plan 260411-dz9: Employee Exit Date (Austrittsdatum) + Pro-Rata Vacation Summary

**One-liner:** BUrlG §5 Abs. 2 pro-rata vacation entitlement via exitDate field, with non-blocking warnings on PATCH /employees and PATCH /leave/requests/review, plus Austrittsdatum date input in admin modal and banner in leave overview.

## Tasks Completed

| Task | Name                                                     | Commit  | Files                                            |
| ---- | -------------------------------------------------------- | ------- | ------------------------------------------------ |
| 1    | Add calculateProRataVacation helper + unit tests         | 730b52e | vacation-calc.ts, vacation-calc.test.ts          |
| 2    | Wire exitDate through employees PATCH + leave review API | f4aa071 | employees.ts, leave.ts                           |
| 3    | Admin edit modal date input + leave overview banner      | 601ff03 | admin/employees/+page.svelte, leave/+page.svelte |

**Stopped at checkpoint:** Task 4 (human-verify) — awaiting user verification.

## What Was Built

### Backend: calculateProRataVacation (apps/api/src/utils/vacation-calc.ts)

New export: `calculateProRataVacation(baseDays: number, year: number, exitDate: Date): number`

- Implements BUrlG §5 Abs. 2 "volle Beschäftigungsmonate" rule
- A month counts as full ONLY if exitDate >= last day of that month (e.g., Jun 30 = 6 months, Jun 29 = 5)
- Rounds UP to nearest 0.5 using `Math.ceil(raw * 2) / 2`
- Guards: NaN/negative/zero → 0; future year → baseDays; past year → 0
- 10 new vitest cases (26 total tests pass)

### Backend: employees.ts PATCH changes

- `updateEmployeeSchema` extended with `exitDate: z.string().datetime().nullable().optional()`
- PATCH `/:id` handler now persists `exitDate` when provided
- After update: looks up VACATION `LeaveEntitlement` for the exit year
- Computes `proRata = calculateProRataVacation(totalDays, exitYear, effectiveExitDate)`
- If `usedDays > proRata`: returns `{ ...employee, proRataWarning: { used, entitlement, message } }`
- Audit log includes `exitDate` in both `oldValue` and `newValue`
- Warning computation is wrapped in try/catch (silent failure if leave type not found)

### Backend: leave.ts review handler changes

- Import `calculateProRataVacation` added alongside `splitDaysAcrossYears`
- After VACATION approval (`deductVacationDays` completes): fetches employee's `exitDate`
- If `exitDate` set: re-reads `LeaveEntitlement`, computes pro-rata, attaches `proRataWarning` to response
- Does NOT block approval — purely informational
- Cancellation branch (`CANCELLATION_REQUESTED`) unchanged (no warning on cancellations)
- Non-VACATION types (OVERTIME_COMP, SPECIAL, etc.) do not emit the warning

### Frontend: Admin Employees Edit Modal

- Import `toasts` from `$stores/toast` added
- `let eExitDate = $state("")` added to edit modal state
- `openEdit(emp)` initializes: `eExitDate = emp.exitDate ? emp.exitDate.split("T")[0] : ""`
- `saveEdit()` sends `exitDate: eExitDate ? new Date(eExitDate).toISOString() : null`
- Captures `proRataWarning` from response → `toasts.warning(message, 8000)` if present
- New form group added before NFC input:
  ```
  label: "Austrittsdatum (optional)"
  input: type="date", bind:value={eExitDate}, class="form-input"
  hint: "Bei gesetztem Datum wird der Jahresurlaub anteilig berechnet (§ 5 Abs. 2 BUrlG)."
  ```

### Frontend: Leave Overview Banner

- `let viewedExitDate = $state<string | null>(null)` added
- `loadVacationSummary()` extended to also fetch `GET /employees/:userId` and read `exitDate`
- `proRataWarning` derived with inline volle-Monate calculation (keeps in sync with backend helper)
- Banner rendered above `.vac-summary` in calendar view:
  ```svelte
  {#if proRataWarning}
    <div class="alert alert-warning card-animate" role="status">
      Achtung: ... ({proRataWarning.used} Tage) ... ({proRataWarning.entitlement} Tage) ...
    </div>
  {/if}
  ```

## Deviations from Plan

None — plan executed exactly as written. The plan specified adding tests to a new file next to the source, but the existing project convention places tests in `__tests__/` subdirectory — tests were added to the existing `__tests__/vacation-calc.test.ts` which follows the project's actual convention.

## Verification Status

- `calculateProRataVacation` exported from `vacation-calc.ts` ✓
- 26 unit tests pass (10 new `calculateProRataVacation` cases) ✓
- TypeScript compiles without errors (`tsc --noEmit`) ✓
- svelte-check: no errors in modified files (pre-existing errors in other files unrelated) ✓
- No Prisma migration needed (column already exists) ✓
- Cancellation branch does NOT emit `proRataWarning` ✓
- Non-VACATION types do NOT emit `proRataWarning` ✓
- Audit log includes `exitDate` old/new values ✓
- German labels, `card-animate` on banner, no hardcoded hex colors ✓

**Pending:** Task 4 — human verification via Docker (`docker compose up --build -d`)

## Known Stubs

None — all data is wired from the database through the API to the UI.

## Self-Check: PASSED

Files verified present:

- apps/api/src/utils/vacation-calc.ts — FOUND (contains calculateProRataVacation)
- apps/api/src/utils/**tests**/vacation-calc.test.ts — FOUND (26 tests)
- apps/api/src/routes/employees.ts — FOUND (contains exitDate, proRataWarning)
- apps/api/src/routes/leave.ts — FOUND (contains proRataWarning)
- apps/web/src/routes/(app)/admin/employees/+page.svelte — FOUND (contains Austrittsdatum)
- apps/web/src/routes/(app)/leave/+page.svelte — FOUND (contains exitDate, proRataWarning)

Commits verified:

- 730b52e: feat(quick-260411-dz9-01): add calculateProRataVacation helper with unit tests ✓
- f4aa071: feat(quick-260411-dz9-02): wire exitDate through employees PATCH + leave review ✓
- 601ff03: feat(quick-260411-dz9-03): add Austrittsdatum UI in admin edit modal and leave overview banner ✓
