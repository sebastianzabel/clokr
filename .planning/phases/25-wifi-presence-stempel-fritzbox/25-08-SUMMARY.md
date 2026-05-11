---
phase: 25-wifi-presence-stempel-fritzbox
plan: "08"
subsystem: api/plugins
tags: [data-retention, cron, dsgvo, audit-log, tdd]
dependency_graph:
  requires: [25-01]
  provides: [purgeable-auditlog-purge-cron]
  affects: [apps/api/src/plugins/data-retention.ts]
tech_stack:
  added: []
  patterns: [cron-job, fastify-decorate, prisma-deleteMany]
key_files:
  created:
    - apps/api/src/__tests__/data-retention.test.ts
  modified:
    - apps/api/src/plugins/data-retention.ts
decisions:
  - "Use minimum configured retention across all tenants as global cutoff (most privacy-preserving, since AuditLog has no tenantId)"
  - "Math.max(1, days) guard per T-25-08-02 threat mitigation prevents 0-day tampering"
  - "TypeScript cast used for purgeableAuditRetentionDays until 25-01 Prisma client is regenerated"
  - "Hard-delete is justified by DSGVO Art. 5(1)(e) — purgeable=true rows are non-payroll-relevant"
metrics:
  duration: "6 minutes"
  completed: "2026-05-11"
  tasks_completed: 2
  files_modified: 2
---

# Phase 25 Plan 08: Purgeable AuditLog Purge Cron Summary

Daily hard-delete cron for DSGVO-compliant purge of WiFi-presence-only AuditLog entries (`purgeable=true`) older than 90 days, implemented as a TDD extension to the existing `data-retention.ts` plugin.

## What Was Built

### Modified: `apps/api/src/plugins/data-retention.ts`

Added `runPurgeableAuditLogs()` function that:

- Queries all tenants to find the minimum configured `purgeableAuditRetentionDays` (default 90). Uses the minimum (most restrictive) because `AuditLog` has no `tenantId` column — deletions are global.
- Applies `Math.max(1, days)` to the configured value to prevent a mis-configured 0-day window from becoming a destructive wipe (T-25-08-02 threat mitigation).
- Computes a cutoff date: `now - minRetentionDays`.
- Calls `prisma.auditLog.deleteMany({ where: { purgeable: true, createdAt: { lt: cutoff } } })`.
- Logs deletion count and cutoff date for operational auditability.

Registered as a daily cron (`"0 3 * * *"`) alongside the existing annual retention cron (`"0 3 2 1 *"`). Both tasks pushed into the shared `tasks: ScheduledTask[]` array for `onClose` cleanup.

Exposed via `app.decorate("runPurgeableAuditLogs", ...)` for manual trigger (e.g., via admin route).

Updated `declare module "fastify"` augmentation to include `runPurgeableAuditLogs?: () => Promise<void>`.

### Created: `apps/api/src/__tests__/data-retention.test.ts`

3 integration tests (REQ-13 / WIFI-04) using real DB:

| Test | Assertion |
|------|-----------|
| `hard-deletes purgeable entries older than retention days` | 3 rows with `purgeable=true`, `daysAgo=91/95/120` — all deleted |
| `does NOT delete non-purgeable entries regardless of age` | 2 rows with `purgeable=false`, `daysAgo=91/365` — both kept |
| `does NOT delete purgeable entries younger than retention window` | 2 rows with `purgeable=true`, `daysAgo=89/1` — both kept |

## Cron Expression and Rationale

- Expression: `"0 3 * * *"` — runs daily at 03:00
- Chosen to run at a low-traffic time, distinct from the annual job (`"0 3 2 1 *"`)
- Daily frequency ensures DSGVO minimization is applied promptly after the 90-day window expires

## How `runPurgeableAuditLogs()` Is Triggered

1. **Scheduled**: Daily cron at 03:00 via `node-cron`
2. **Manual**: Via `app.runPurgeableAuditLogs()` decoration — allows admin routes or tests to invoke directly without waiting for cron schedule

## DSGVO Justification

DSGVO Art. 5(1)(e) (Datensparsamkeit / storage limitation): AuditLog entries with `purgeable=true` represent WiFi-presence-only events that never produced a `TimeEntry`. They are not payroll-relevant and therefore not subject to the §147 AO 10-year retention requirement (which applies to `purgeable=false` entries). The 90-day window provides sufficient operational debugging history while complying with data minimization principles.

## TypeScript Cast

```typescript
(t.config as { purgeableAuditRetentionDays?: number } | null)?.purgeableAuditRetentionDays ?? 90
```

This cast is used because `TenantConfig.purgeableAuditRetentionDays` may not exist in the Prisma-generated client type if plan 25-01 has not been applied yet. Once 25-01 ships and `pnpm --filter @clokr/db exec prisma generate` is run, the cast can be removed — the field will be properly typed as `number`.

## Deviations from Plan

None — plan executed exactly as written, plus T-25-08-02 threat mitigation (`Math.max(1, days)` guard) which was required by the threat model.

## Self-Check: PASSED

- `apps/api/src/__tests__/data-retention.test.ts` — FOUND
- `apps/api/src/plugins/data-retention.ts` — FOUND (modified)
- Commit `06b7278` (RED: failing tests) — FOUND
- Commit `949d8fa` (GREEN: implementation) — FOUND
- 3 tests pass, 0 fail in data-retention test suite
- TypeScript compilation: 0 errors in modified file
- Cron `"0 3 * * *"` registered on line 173
- DSGVO Art. 5 comment present (1 occurrence)
- `runPurgeableAuditLogs` appears in: declare module (line 7), function def (line 130), cron callback (line 174), app.decorate (line 181)
- Pre-existing test failures in `overtime-calc.test.ts` and `time-entries-validation.test.ts` are out of scope and existed before this plan
