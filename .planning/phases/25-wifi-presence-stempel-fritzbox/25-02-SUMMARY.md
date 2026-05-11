---
phase: 25-wifi-presence-stempel-fritzbox
plan: "02"
subsystem: api-utils
tags: [wifi-presence, utilities, tdd, mac-normalization, shift-lookup]
dependency_graph:
  requires: []
  provides:
    - apps/api/src/utils/normalize-mac.ts (normalizeMac)
    - apps/api/src/utils/get-current-shift.ts (getCurrentShift, ShiftWindow)
  affects:
    - apps/api/src/routes/presence.ts (Wave 2 - Plan 25-03)
    - apps/api/src/routes/employees.ts (Wave 2 - Plan 25-05)
tech_stack:
  added: []
  patterns:
    - TDD (RED-GREEN with vitest)
    - fromZonedTime for timezone-aware UTC conversion (date-fns-tz)
    - mock PrismaClient via object literal for unit tests
key_files:
  created:
    - apps/api/src/utils/normalize-mac.ts
    - apps/api/src/utils/get-current-shift.ts
    - apps/api/src/__tests__/normalize-mac.test.ts
    - apps/api/src/__tests__/get-current-shift.test.ts
  modified: []
decisions:
  - "Overnight shift detection: compare endH < startH (or equal H with endM <= startM) → endDay = day + 1. Simple numeric comparison, no DB schema change needed."
  - "normalizeMac strips all non-hex before byte count check: GG:HH:... strips to empty → length 0 ≠ 12 → throws correctly without a separate regex validation pass."
metrics:
  duration_minutes: 2
  completed_date: "2026-05-11"
  tasks_completed: 3
  files_changed: 4
requirements:
  - WIFI-03
---

# Phase 25 Plan 02: Utility Functions (normalizeMac + getCurrentShift) Summary

Tested pure utility functions: MAC normalization to lowercase colon-separated form and timezone-aware Shift DB lookup returning UTC boundaries, consumed by Wave 2 presence and employee routes.

## Tasks Completed

| Task | Type | Description | Commit |
|------|------|-------------|--------|
| 1 | TDD-RED | Failing tests for normalizeMac (9 cases) | fe32116 |
| 2 | TDD-RED | Failing tests for getCurrentShift (4 cases, REQ-10/REQ-11) | 2cd939f |
| 3 | TDD-GREEN | Implement both utilities; all tests pass | 2077b38 |

## Files Created

| File | Description |
|------|-------------|
| `apps/api/src/utils/normalize-mac.ts` | `normalizeMac(raw: string): string` — strips separators, validates 12 hex chars, returns `aa:bb:cc:dd:ee:ff` |
| `apps/api/src/utils/get-current-shift.ts` | `getCurrentShift(prisma, employeeId, at, tz)` — DB lookup by employee+date in tenant TZ; returns `ShiftWindow` with UTC timestamps or `null` |
| `apps/api/src/__tests__/normalize-mac.test.ts` | 9 vitest cases: colon/dash/no-sep/mixed/FritzBox formats + 4 error cases |
| `apps/api/src/__tests__/get-current-shift.test.ts` | 4 vitest cases: REQ-10 (null), REQ-11 (UTC times), timezone boundary, ordering |

## Function Signatures (from implementations)

```typescript
// normalize-mac.ts
export function normalizeMac(raw: string): string;

// get-current-shift.ts
export interface ShiftWindow {
  shift: { id: string; startTime: string; endTime: string };
  startUtc: Date;
  endUtc: Date;
}
export async function getCurrentShift(
  prisma: PrismaClient,
  employeeId: string,
  at: Date,
  tz: string,
): Promise<ShiftWindow | null>;
```

## Test Results

- `normalize-mac.test.ts`: 9/9 passed
- `get-current-shift.test.ts`: 4/4 passed
- `pnpm --filter @clokr/api exec tsc --noEmit`: exit 0

## Decisions Made

**Overnight shift handling:** Detect by comparing `endH < startH` (or equal hours with `endM <= startM`). If true, increment `endDay` by 1 before building the `endLocal` Date. This keeps the logic simple without touching the DB schema or requiring additional Shift fields.

**normalizeMac strip-first approach:** Strip all non-hex characters first, then validate that exactly 12 hex chars remain. This handles colon/dash/no-separator variants in one pass. Non-hex letters like G, H, I strip to nothing → count drops below 12 → throws without a second regex pass.

## Deviations from Plan

None — plan executed exactly as written. Both utilities implemented verbatim from the plan's action blocks.

## Threat Mitigations Applied

- T-25-02-01 (Tampering — normalizeMac input): Strict hex-strip + 12-char count check enforced. Any non-hex character reduces count below 12 → throws `Ungültige MAC-Adresse`.

## Self-Check: PASSED

All 4 files exist on disk. All 3 commits verified in git log.
