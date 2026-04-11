---
phase: 05-saldo-performance-presence-resolver
verified: 2026-04-11T20:41:00Z
status: human_needed
score: 9/9 must-haves verified
overrides_applied: 0
human_verification:
  - test: "Approve a leave request via the API and check OvertimeAccount.balanceHours changes"
    expected: "After PATCH /api/v1/leave/requests/:id/review with status APPROVED, OvertimeAccount.balanceHours reflects the reduced expected hours"
    why_human: "Integration test requires a running database (overtime-calc.test.ts could not run in this environment due to missing DB env). Code is wired correctly; behavioral confirmation needs a DB."
  - test: "Bulk import time entries via POST /api/v1/imports/time-entries and check OvertimeAccount per employee"
    expected: "After CSV import, each unique employee's OvertimeAccount.balanceHours is updated"
    why_human: "Requires running database and valid CSV upload. Code is wired correctly via affectedEmployeeIds pattern."
---

# Phase 05: Saldo Performance & Presence Resolver Verification Report

**Phase Goal:** Store OvertimeAccount.balanceHours for O(1) reads, fix resolvePresenceState() for CANCELLATION_REQUESTED
**Verified:** 2026-04-11T20:41:00Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | GET /api/v1/overtime/:employeeId returns stored balanceHours (O(1) read, no recalculation) | VERIFIED | `overtime.ts` line 35: `prisma.overtimeAccount.findUnique` directly. No `updateOvertimeAccount` reference anywhere in the file. |
| 2 | No DB write occurs when GET /overtime/:employeeId is called | VERIFIED | `grep "updateOvertimeAccount" overtime.ts` returns no results. Import removed from file. |
| 3 | Approving leave (PENDING→APPROVED) updates OvertimeAccount.balanceHours | VERIFIED | `leave.ts` line 741: `updateOvertimeAccount(app, existing.employeeId)` called after `recalculateSnapshots` in the APPROVED branch. |
| 4 | Approving leave cancellation (CANCELLATION_REQUESTED→CANCELLED) updates OvertimeAccount.balanceHours | VERIFIED | `leave.ts` line 612: `updateOvertimeAccount(app, existing.employeeId)` called after `recalculateSnapshots` in the APPROVED sub-branch of CANCELLATION_REQUESTED handler. |
| 5 | Bulk time-entry import updates OvertimeAccount.balanceHours for each affected employee | VERIFIED | `imports.ts` lines 182/225/237-241: `affectedEmployeeIds` Set collected in loop ok-branch, post-loop per-employee `updateOvertimeAccount` calls. |
| 6 | resolvePresenceState() is a pure function with no DB dependency | VERIFIED | `presence.ts` has no imports from prisma, fastify, or any DB layer. Only plain TypeScript types. All 13 unit tests pass with no DB setup. |
| 7 | isInvalid:true entries do not count as present or clocked_in | VERIFIED | `presence.ts` line 66: `validEntries = entries.filter((e) => !e.isInvalid)`. Dashboard `workedMinutes` also guards with `!e.isInvalid` (line 198). |
| 8 | CANCELLATION_REQUESTED leave returns status=absent, reason='Urlaubsstornierung beantragt' | VERIFIED | `presence.ts` lines 81-83: explicit branch for `CANCELLATION_REQUESTED`. Test "CANCELLATION_REQUESTED leave → absent with German reason (D-09)" passes (13/13). |
| 9 | Dashboard team-week query fetches both APPROVED and CANCELLATION_REQUESTED leaves with isInvalid on time entries | VERIFIED | `dashboard.ts` line 147: `status: { in: ["APPROVED", "CANCELLATION_REQUESTED"] }`. Line 139: `isInvalid: true` in timeEntry select. |

**Score:** 9/9 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `apps/api/src/routes/overtime.ts` | GET handler without updateOvertimeAccount() call; reads via findUnique | VERIFIED | No `updateOvertimeAccount` reference; `findUnique` at line 35. |
| `apps/api/src/__tests__/overtime-calc.test.ts` | Tests use POST /api/v1/time-entries, not direct DB insert | VERIFIED | Lines 33 and 79: both rewrites use `app.inject` POST; no `app.prisma.timeEntry.create` in those test bodies. |
| `apps/api/src/routes/leave.ts` | updateOvertimeAccount calls in both APPROVED paths | VERIFIED | 3 lines: import (line 10) + 2 call sites (lines 612, 741). |
| `apps/api/src/routes/imports.ts` | affectedEmployeeIds + post-loop updateOvertimeAccount | VERIFIED | Lines 182, 225, 237-241 all present. |
| `apps/api/src/utils/presence.ts` | resolvePresenceState() pure function + all 5 types exported | VERIFIED | File exists. Exports: `resolvePresenceState`, `PresenceStatus`, `PresenceEntry`, `PresenceLeave`, `PresenceAbsence`, `PresenceResult`. |
| `apps/api/src/__tests__/presence.test.ts` | 13 unit tests, no DB, all passing | VERIFIED | 13 tests, 13 passed, 147ms, no DB needed. `import { resolvePresenceState } from "../utils/presence"` — no getTestApp. |
| `apps/api/src/routes/dashboard.ts` | resolvePresenceState() call replacing inline logic; CANCELLATION_REQUESTED in leave query; isInvalid in time entry select | VERIFIED | Line 13 import, line 147 leave filter, line 139 isInvalid select, line 259 resolvePresenceState() call. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| GET /overtime/:employeeId handler | prisma.overtimeAccount.findUnique | direct read, no updateOvertimeAccount | WIRED | Line 35 confirmed; no updateOvertimeAccount anywhere in overtime.ts |
| leave.ts PENDING→APPROVED handler | updateOvertimeAccount(app, existing.employeeId) | called after recalculateSnapshots | WIRED | Lines 735 (recalculate) + 741 (updateOvertimeAccount) — correct order |
| leave.ts CANCELLATION_REQUESTED→CANCELLED handler | updateOvertimeAccount(app, existing.employeeId) | called after recalculateSnapshots | WIRED | Lines 606 (recalculate) + 612 (updateOvertimeAccount) — correct order |
| imports.ts POST /time-entries loop | updateOvertimeAccount per unique employeeId | affectedEmployeeIds Set | WIRED | Lines 182, 225, 237-241 |
| dashboard.ts team-week handler | resolvePresenceState() | import from ../utils/presence | WIRED | Lines 13-14 (import), 259 (call site) |
| resolvePresenceState | PresenceLeave.status CANCELLATION_REQUESTED branch | explicit if check | WIRED | presence.ts lines 81-83 |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|-------------------|--------|
| `dashboard.ts` team-week | `presenceEntries`, `presenceLeave`, `presenceAbsence` | `prisma.timeEntry.findMany`, `prisma.leaveRequest.findMany`, `prisma.absence.findMany` (lines 126, 144, 161) | Yes — real DB queries with tenantId scoping | FLOWING |
| `overtime.ts` GET | `account.balanceHours` | `prisma.overtimeAccount.findUnique` (line 35) | Yes — reads stored DB field | FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| resolvePresenceState() unit tests pass | `vitest run presence.test.ts` | 13/13 tests passed in 147ms | PASS |
| TypeScript compiles without errors | `tsc --noEmit -p apps/api/tsconfig.json` | No output (clean) | PASS |
| Commits for all 7 tasks exist in git history | `git log --oneline` | d88c72c, 7690ec3, 64e6a93, 604f700, 2f5be84, 03d3002, ff7407a all confirmed | PASS |
| overtime-calc integration tests | `vitest run overtime-calc.test.ts` | SKIP — requires DB env (missing in verification environment) | SKIP |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| SALDO-01 | 05-01-PLAN.md | Overtime GET endpoint reads stored balanceHours without triggering recalculation | SATISFIED | `overtime.ts` GET handler: only `findUnique`, no `updateOvertimeAccount`. Truth 1 + 2 verified. |
| SALDO-02 | 05-02-PLAN.md | `updateOvertimeAccount` called consistently on all write operations | SATISFIED | `leave.ts` 2 call sites + `imports.ts` post-loop pattern. Truths 3-5 verified. |
| RPT-04 | 05-03-PLAN.md | resolvePresenceState() handles CANCELLATION_REQUESTED + isInvalid entries correctly | SATISFIED | `presence.ts` pure function + 13 passing unit tests + dashboard.ts wired. Truths 6-9 verified. |

All 3 requirement IDs from plan frontmatter are accounted for. No orphaned requirements for Phase 5 in REQUIREMENTS.md (traceability table maps exactly SALDO-01, SALDO-02, RPT-04 to Phase 5).

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| None | — | — | — | — |

No TODO/FIXME/placeholder comments, no empty implementations, no hardcoded empty arrays/objects found in any modified file.

### Human Verification Required

#### 1. Leave approval saldo update (integration)

**Test:** Use a running API with a seeded employee. Create a leave request (PENDING), then call `PATCH /api/v1/leave/requests/:id/review` with `{ status: "APPROVED" }`. Read `OvertimeAccount.balanceHours` before and after.
**Expected:** `balanceHours` changes after leave approval (leave reduces expected hours, increasing balance).
**Why human:** Integration test suite (`overtime-calc.test.ts`) requires a live PostgreSQL database. The test env file exists (`apps/api/.env.test`) but the database was not available in the verification context. Code analysis confirms wiring is correct — the await chain at leave.ts lines 735+741 is properly ordered.

#### 2. Bulk import saldo update (integration)

**Test:** Upload a valid CSV of time entries via `POST /api/v1/imports/time-entries`. Check `OvertimeAccount.balanceHours` for each employee in the CSV before and after the import.
**Expected:** Each employee's balance is updated after the import. Employees with failed import rows are not updated.
**Why human:** Requires a running database and a valid CSV file. Code wiring at imports.ts lines 182/225/237-241 is confirmed correct — only ok-branch employees are collected, post-loop per-employee calls fire.

### Gaps Summary

No gaps. All 9 observable truths verified against the actual codebase. All 7 commits documented in summaries exist and are traceable. TypeScript compiles clean. 13 unit tests pass. Human verification items are behavioral confirmations of already-verified wiring — they do not indicate implementation gaps.

---

_Verified: 2026-04-11T20:41:00Z_
_Verifier: Claude (gsd-verifier)_
