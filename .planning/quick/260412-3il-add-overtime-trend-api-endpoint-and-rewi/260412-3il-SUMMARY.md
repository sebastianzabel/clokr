---
phase: quick-260412-3il
plan: 01
subsystem: dashboard
tags: [overtime, saldo, chart, api, tdd]
dependency_graph:
  requires: []
  provides: [dashboard-overtime-trend-endpoint]
  affects: [apps/api/src/routes/dashboard.ts, apps/web/src/routes/(app)/dashboard/+page.svelte]
tech_stack:
  added: []
  patterns: [prisma-groupBy-aggregation, tenant-scoping-via-employee-relation]
key_files:
  created:
    - apps/api/src/routes/__tests__/dashboard-overtime-trend.test.ts
  modified:
    - apps/api/src/routes/dashboard.ts
    - apps/web/src/routes/(app)/dashboard/+page.svelte
    - apps/api/package.json
key_decisions:
  - Added dotenv as explicit devDependency in api package.json (was undeclared transitive dep causing worktree test failures)
  - Hoisted months and overtimeTrend variables above the try block in loadCharts() to fix lint/scope errors
  - Removed now-unused SaldoSnapshotApi interface from dashboard page
metrics:
  duration: ~25 minutes
  completed: 2026-04-12
  tasks_completed: 2
  tasks_total: 3
  files_modified: 4
---

# Quick Task 260412-3il: Add overtime-trend API endpoint and rewire dashboard chart

One-liner: Tenant-scoped GET /api/v1/dashboard/overtime-trend endpoint aggregating SaldoSnapshot.carryOver per month + live OvertimeAccount balances, wired to the dashboard Überstunden-Trend chart.

## Summary

Added a new backend API endpoint and rewired the dashboard overtime chart to show the team's **absolute** saldo at each month end, replacing the previous per-user relative calculation.

### Task 1: Backend endpoint (TDD)

- Created `GET /api/v1/dashboard/overtime-trend` in `apps/api/src/routes/dashboard.ts`
- Uses `prisma.saldoSnapshot.groupBy` (grouped by `periodStart`, filtered to `MONTHLY`, 6-month window)
- Tenant scoping via employee.tenantId (Prisma groupBy doesn't support relation filters directly)
- Sums `OvertimeAccount.balanceHours` for the current open-month team balance
- 6 Vitest tests all pass: 401, empty state, ascending order, balance sum, cross-tenant isolation, MONTHLY+window filter

### Task 2: Frontend chart rewiring

- Replaced per-user `/overtime/snapshots/:employeeId` fetch with single `/dashboard/overtime-trend` call
- New dataset uses fill-forward from `snapshotByMonth` map; last point = `currentTeamBalanceMinutes / 60`
- Dataset label changed from "Überstunden kumuliert (h)" to "Team-Überstunden (h)"
- Removed now-unused `SaldoSnapshotApi` interface
- Weekly bar chart and sick days chart are unchanged

### Task 3: Visual verification (skipped — checkpoint)

Task 3 is a `checkpoint:human-verify` — skipped per execution constraints. Visual verification requires running docker compose and confirming the chart in a browser.

## Commits

| Hash    | Type  | Description                                                                   |
|---------|-------|-------------------------------------------------------------------------------|
| 0654da0 | test  | test(dashboard): add failing tests for overtime-trend endpoint                |
| ad11a0a | feat  | feat(dashboard): add /overtime-trend endpoint for team saldo chart            |
| 45fcdcd | feat  | feat(dashboard): rewire Überstunden-Trend chart to use /dashboard/overtime-trend endpoint |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] dotenv not installed in worktree**
- **Found during:** Task 1 (RED phase test run)
- **Issue:** `vitest.setup.ts` imports `dotenv` which wasn't listed in package.json devDependencies, causing test runner failure in the worktree environment
- **Fix:** Added `dotenv: ^16.6.1` to `apps/api/package.json` devDependencies
- **Files modified:** `apps/api/package.json`
- **Commit:** Included in `0654da0`

**2. [Rule 3 - Blocking] months and overtimeTrend variables out of scope in Phase 3**
- **Found during:** Task 2 lint check
- **Issue:** ESLint reported `overtimeTrend` and `months` as undefined at lines 482-499 because they were declared inside the `try` block but used after the `try/finally` block in Phase 3
- **Fix:** Hoisted `months` array construction and `overtimeTrend` declaration above the `try` block (function-scoped, consistent with `reports`, `labels`, `brandColor`)
- **Files modified:** `apps/web/src/routes/(app)/dashboard/+page.svelte`
- **Commit:** Part of `45fcdcd`

**3. [Rule 2 - Cleanup] Unused SaldoSnapshotApi interface**
- **Found during:** Task 2 lint check
- **Issue:** After replacing the snapshot fetch logic, `SaldoSnapshotApi` was no longer referenced
- **Fix:** Removed the unused interface
- **Files modified:** `apps/web/src/routes/(app)/dashboard/+page.svelte`
- **Commit:** Part of `45fcdcd`

## Verification Results

- `pnpm --filter @clokr/api test -- dashboard-overtime-trend`: **6/6 pass**
- `pnpm --filter @clokr/api lint`: **0 errors** (1 pre-existing warning in reports.ts)
- `pnpm --filter @clokr/api typecheck`: **0 errors in changed files** (pre-existing DATEV schema errors in reports.ts/reports.test.ts)
- `pnpm --filter @clokr/web lint`: **0 errors in dashboard/+page.svelte** (pre-existing error in reports/+page.svelte)
- `pnpm --filter @clokr/web typecheck`: **0 errors in changed files** (pre-existing hooks.server.ts error)
- Visual verification (Task 3): **pending** — checkpoint skipped

## Known Stubs

None. The endpoint returns real data from `SaldoSnapshot.carryOver` and `OvertimeAccount.balanceHours`.

## Threat Flags

None. The new endpoint uses the same auth pattern (`requireAuth`) as other personal dashboard endpoints. Tenant isolation is enforced via `employee.tenantId` filter. No new network surface or trust boundary introduced.

## Self-Check

- [x] `apps/api/src/routes/__tests__/dashboard-overtime-trend.test.ts` exists
- [x] `apps/api/src/routes/dashboard.ts` contains `overtime-trend` route
- [x] `apps/web/src/routes/(app)/dashboard/+page.svelte` contains `dashboard/overtime-trend` fetch
- [x] Commits 0654da0, ad11a0a, 45fcdcd exist in git log
