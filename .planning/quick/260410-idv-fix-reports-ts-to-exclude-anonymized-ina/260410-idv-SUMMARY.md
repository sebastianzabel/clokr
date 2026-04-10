---
phase: 260410-idv
plan: 01
subsystem: api/reports
tags: [bugfix, dsgvo, reports, datev, anonymization]
dependency_graph:
  requires: []
  provides: [anonymized-employee-filtering-in-reports]
  affects: [apps/api/src/routes/reports.ts]
tech_stack:
  added: []
  patterns: [user-relation-filter-for-isActive]
key_files:
  created: []
  modified:
    - apps/api/src/routes/reports.ts
decisions:
  - Used user: { isActive: true } relation filter — same shape as overtime.ts team-week handler — for consistency
metrics:
  duration: "3 minutes"
  completed: "2026-04-10"
  tasks_completed: 1
  files_modified: 1
---

# Phase 260410-idv Plan 01: Fix reports.ts to exclude anonymized/inactive employees — Summary

**One-liner:** Added `user: { isActive: true }` relation filter to both `/monthly` and `/datev` Prisma queries in reports.ts, preventing DSGVO-anonymized employees from appearing in monthly PDFs and DATEV LODAS exports.

## What Was Done

Two targeted edits to `apps/api/src/routes/reports.ts`:

**Change 1 — GET /monthly handler (line 35):**

Before:
```ts
where: {
  tenantId: req.user.tenantId,
  ...(employeeId ? { id: employeeId } : {}),
  exitDate: null,
},
```

After:
```ts
where: {
  tenantId: req.user.tenantId,
  ...(employeeId ? { id: employeeId } : {}),
  exitDate: null,
  user: { isActive: true },
},
```

**Change 2 — GET /datev handler (line 277):**

Before:
```ts
where: { tenantId: req.user.tenantId, exitDate: null },
```

After:
```ts
where: { tenantId: req.user.tenantId, exitDate: null, user: { isActive: true } },
```

## Verification

- `pnpm --filter @clokr/api exec tsc --noEmit` — exit code 0, no errors
- `grep -c "user: { isActive: true }" apps/api/src/routes/reports.ts` → `2`
- No other files were touched (include, orderBy, handler logic, schema, imports all unchanged)

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None.

## Self-Check: PASSED

- File modified: `/Users/sebastianzabel/git/clokr/apps/api/src/routes/reports.ts` — FOUND
- Commit f69855a exists — FOUND
- grep count = 2 — VERIFIED
