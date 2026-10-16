-- Phase 86b (Issue #86) — the global system-role template Personalabteilung gains
-- `salon:read:ZUGEWIESEN` (to maintain salon assignments, inactive salons included) and
-- `report:read:ZUGEWIESEN` (the three JSON report routes carry only sums per person and month).
-- Owner decision 16.10.2026 (decision comment on #86); an Unterbau semantic change that reverses
-- Phase 76b D-07 for `report:read`.
--
-- DATA ONLY: no table, column, index, type or constraint is created, altered or dropped
-- (`prisma migrate diff` against the migration history stays empty). It updates exactly ONE row,
-- the global Personalabteilung template (fixed id, `"tenantId" IS NULL`). IDEMPOTENT and
-- REPLAY-SAFE: the `IS DISTINCT FROM` guard makes a replay a no-op, so it changes no row and no
-- timestamp. It assigns nothing to anyone — no "RoleAssignment" row, no "AuditLog" row. Customer
-- copies of the template are separate, tenant-owned rows and stay unchanged.
--
-- Code identifies the row by id (apps/api/src/contexts/platform/system-roles.ts); a drift test
-- (src/__tests__/hr-template-migration-86.test.ts) proves the migrated row equals
-- SYSTEM_ROLE_PERMISSIONS.HR, in catalog order. Changing the template again means a NEW migration
-- plus a code change there — never a hand-edit of this file or of the 76b migration.

UPDATE "AccessRole"
SET "permissions" = ARRAY[
      'employee:read:ZUGEWIESEN',
      'employee:create:ZUGEWIESEN',
      'employee:update:ZUGEWIESEN',
      'employee:update-avatar:ZUGEWIESEN',
      'contract:read:ZUGEWIESEN',
      'contract:update:ZUGEWIESEN',
      'salon:read:ZUGEWIESEN',
      'leave-request:read:ZUGEWIESEN',
      'section9:read:ZUGEWIESEN',
      'leave-entitlement:read:ZUGEWIESEN',
      'leave-entitlement:update:ZUGEWIESEN',
      'vocational-school:read:ZUGEWIESEN',
      'overtime:read:ZUGEWIESEN',
      'month-close:read:ZUGEWIESEN',
      'report:read:ZUGEWIESEN'
    ]::text[],
    "updatedAt" = NOW()
WHERE "id" = '00000000-0000-4000-8000-00000000a006'
  AND "tenantId" IS NULL
  AND "permissions" IS DISTINCT FROM ARRAY[
      'employee:read:ZUGEWIESEN',
      'employee:create:ZUGEWIESEN',
      'employee:update:ZUGEWIESEN',
      'employee:update-avatar:ZUGEWIESEN',
      'contract:read:ZUGEWIESEN',
      'contract:update:ZUGEWIESEN',
      'salon:read:ZUGEWIESEN',
      'leave-request:read:ZUGEWIESEN',
      'section9:read:ZUGEWIESEN',
      'leave-entitlement:read:ZUGEWIESEN',
      'leave-entitlement:update:ZUGEWIESEN',
      'vocational-school:read:ZUGEWIESEN',
      'overtime:read:ZUGEWIESEN',
      'month-close:read:ZUGEWIESEN',
      'report:read:ZUGEWIESEN'
    ]::text[];
