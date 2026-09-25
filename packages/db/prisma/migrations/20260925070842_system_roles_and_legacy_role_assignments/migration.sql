-- Phase 75b (Issue #75) — system roles and the rights-neutral migration of the legacy roles.
--
-- DATA ONLY: no table, column, index, type or constraint is created, altered or dropped
-- (`prisma migrate diff` against the migration history stays empty, D-05). "User"."role" is
-- never written — every migrated user keeps a byte-identical legacy role, so the previous
-- release keeps working after a rollback (D-06, AC-75-8).
--
-- IDEMPOTENT (D-07): the system roles are inserted with ON CONFLICT ("id") DO NOTHING, and a
-- user receives an assignment only while they hold no "RoleAssignment" row at all. Running this
-- file a second time creates no row and no audit entry. The test suite relies on that: it
-- executes this exact file against its fixtures (src/__tests__/legacy-role-migration-sql.ts).
--
-- Rollout, the SELECTs that reproduce the NOTICE numbers, and the rollback note:
-- docs/migrations.md, section "Phase 75b".

-- 1) The three global system roles (tenantId NULL) with fixed, well-known ids (D-01, D-02).
--    Code identifies them by id only (apps/api/src/contexts/platform/system-roles.ts). The
--    permission lists equal SYSTEM_ROLE_PERMISSIONS there, in catalog order; a drift test
--    compares the migrated rows with that constant (D-04). Changing a system role later means a
--    new migration plus a code change — never an edit of this file.
INSERT INTO "AccessRole" ("id", "tenantId", "name", "nameKey", "permissions", "createdAt", "updatedAt")
VALUES
  ('00000000-0000-4000-8000-00000000a001', NULL, 'Admin', 'admin', ARRAY[
      'employee:read:EIGENE',
      'employee:read:ZUGEWIESEN',
      'employee:create:ZUGEWIESEN',
      'employee:update:ZUGEWIESEN',
      'employee:manage-access:ZUGEWIESEN',
      'employee:anonymize:ZUGEWIESEN',
      'employee:import:ZUGEWIESEN',
      'employee:update-avatar:EIGENE',
      'employee:update-avatar:ZUGEWIESEN',
      'contract:read:EIGENE',
      'contract:read:ZUGEWIESEN',
      'contract:update:ZUGEWIESEN',
      'tenant-settings:read:ZUGEWIESEN',
      'tenant-settings:update:ZUGEWIESEN',
      'api-key:manage:ZUGEWIESEN',
      'audit-log:read:ZUGEWIESEN',
      'holiday:manage:ZUGEWIESEN',
      'salon:read:ZUGEWIESEN',
      'salon:manage:ZUGEWIESEN',
      'role:read:ZUGEWIESEN',
      'role:manage:ZUGEWIESEN',
      'role-assignment:manage:ZUGEWIESEN',
      'time-entry:read:EIGENE',
      'time-entry:read:ZUGEWIESEN',
      'time-entry:create:EIGENE',
      'time-entry:create:ZUGEWIESEN',
      'time-entry:update:EIGENE',
      'time-entry:update:ZUGEWIESEN',
      'time-entry:delete:EIGENE',
      'time-entry:delete:ZUGEWIESEN',
      'time-entry:revalidate:ZUGEWIESEN',
      'time-entry:import:ZUGEWIESEN',
      'retro-request:read:EIGENE',
      'retro-request:read:ZUGEWIESEN',
      'retro-request:create:EIGENE',
      'retro-request:create:ZUGEWIESEN',
      'retro-request:approve:ZUGEWIESEN',
      'presence-source:manage:ZUGEWIESEN',
      'terminal:manage:ZUGEWIESEN',
      'leave-request:read:EIGENE',
      'leave-request:read:ZUGEWIESEN',
      'leave-request:create:EIGENE',
      'leave-request:create:ZUGEWIESEN',
      'leave-request:approve:ZUGEWIESEN',
      'leave-request:correct:ZUGEWIESEN',
      'leave-request:attest:ZUGEWIESEN',
      'leave-request:cancel:EIGENE',
      'leave-request:cancel:ZUGEWIESEN',
      'section9:read:EIGENE',
      'section9:read:ZUGEWIESEN',
      'section9:upload:EIGENE',
      'section9:upload:ZUGEWIESEN',
      'section9:decide:ZUGEWIESEN',
      'leave-entitlement:read:EIGENE',
      'leave-entitlement:read:ZUGEWIESEN',
      'leave-entitlement:update:ZUGEWIESEN',
      'leave-config:read:ZUGEWIESEN',
      'leave-config:manage:ZUGEWIESEN',
      'company-shutdown:manage:ZUGEWIESEN',
      'vocational-school:read:EIGENE',
      'vocational-school:read:ZUGEWIESEN',
      'vocational-school:manage:ZUGEWIESEN',
      'overtime:read:EIGENE',
      'overtime:read:ZUGEWIESEN',
      'overtime:settle:ZUGEWIESEN',
      'overtime:set-opening-balance:ZUGEWIESEN',
      'month-close:read:ZUGEWIESEN',
      'month-close:close:ZUGEWIESEN',
      'month-close:unlock:ZUGEWIESEN',
      'month-close:close-year:ZUGEWIESEN',
      'shift:read:EIGENE',
      'shift:read:ZUGEWIESEN',
      'shift:plan:ZUGEWIESEN',
      'shift-config:manage:ZUGEWIESEN',
      'shift-pattern:read:EIGENE',
      'shift-pattern:read:ZUGEWIESEN',
      'shift-pattern:update:ZUGEWIESEN',
      'availability:read:EIGENE',
      'availability:read:ZUGEWIESEN',
      'availability:update:EIGENE',
      'availability:update:ZUGEWIESEN',
      'integration:manage:ZUGEWIESEN',
      'report:read:ZUGEWIESEN',
      'report:export:EIGENE',
      'report:export:ZUGEWIESEN',
      'report:notify:ZUGEWIESEN',
      'team-overview:read:ZUGEWIESEN'
    ]::text[], NOW(), NOW()),
  ('00000000-0000-4000-8000-00000000a002', NULL, 'Manager', 'manager', ARRAY[
      'employee:read:EIGENE',
      'employee:read:ZUGEWIESEN',
      'employee:update-avatar:EIGENE',
      'employee:update-avatar:ZUGEWIESEN',
      'contract:read:EIGENE',
      'contract:read:ZUGEWIESEN',
      'contract:update:ZUGEWIESEN',
      'salon:read:ZUGEWIESEN',
      'time-entry:read:EIGENE',
      'time-entry:read:ZUGEWIESEN',
      'time-entry:create:EIGENE',
      'time-entry:create:ZUGEWIESEN',
      'time-entry:update:EIGENE',
      'time-entry:update:ZUGEWIESEN',
      'time-entry:delete:EIGENE',
      'time-entry:delete:ZUGEWIESEN',
      'time-entry:revalidate:ZUGEWIESEN',
      'retro-request:read:EIGENE',
      'retro-request:read:ZUGEWIESEN',
      'retro-request:create:EIGENE',
      'retro-request:create:ZUGEWIESEN',
      'retro-request:approve:ZUGEWIESEN',
      'leave-request:read:EIGENE',
      'leave-request:read:ZUGEWIESEN',
      'leave-request:create:EIGENE',
      'leave-request:create:ZUGEWIESEN',
      'leave-request:approve:ZUGEWIESEN',
      'leave-request:correct:ZUGEWIESEN',
      'leave-request:attest:ZUGEWIESEN',
      'leave-request:cancel:EIGENE',
      'leave-request:cancel:ZUGEWIESEN',
      'section9:read:EIGENE',
      'section9:read:ZUGEWIESEN',
      'section9:upload:EIGENE',
      'section9:upload:ZUGEWIESEN',
      'section9:decide:ZUGEWIESEN',
      'leave-entitlement:read:EIGENE',
      'leave-entitlement:read:ZUGEWIESEN',
      'leave-entitlement:update:ZUGEWIESEN',
      'leave-config:read:ZUGEWIESEN',
      'vocational-school:read:EIGENE',
      'vocational-school:read:ZUGEWIESEN',
      'vocational-school:manage:ZUGEWIESEN',
      'overtime:read:EIGENE',
      'overtime:read:ZUGEWIESEN',
      'overtime:settle:ZUGEWIESEN',
      'month-close:read:ZUGEWIESEN',
      'month-close:close:ZUGEWIESEN',
      'shift:read:EIGENE',
      'shift:read:ZUGEWIESEN',
      'shift:plan:ZUGEWIESEN',
      'shift-pattern:read:EIGENE',
      'shift-pattern:read:ZUGEWIESEN',
      'shift-pattern:update:ZUGEWIESEN',
      'availability:read:EIGENE',
      'availability:read:ZUGEWIESEN',
      'availability:update:EIGENE',
      'availability:update:ZUGEWIESEN',
      'report:read:ZUGEWIESEN',
      'report:export:EIGENE',
      'report:export:ZUGEWIESEN',
      'report:notify:ZUGEWIESEN',
      'team-overview:read:ZUGEWIESEN'
    ]::text[], NOW(), NOW()),
  ('00000000-0000-4000-8000-00000000a003', NULL, 'Mitarbeiter', 'mitarbeiter', ARRAY[
      'employee:read:EIGENE',
      'employee:update-avatar:EIGENE',
      'contract:read:EIGENE',
      'time-entry:read:EIGENE',
      'time-entry:create:EIGENE',
      'time-entry:update:EIGENE',
      'time-entry:delete:EIGENE',
      'retro-request:read:EIGENE',
      'retro-request:create:EIGENE',
      'leave-request:read:EIGENE',
      'leave-request:create:EIGENE',
      'leave-request:cancel:EIGENE',
      'section9:read:EIGENE',
      'section9:upload:EIGENE',
      'leave-entitlement:read:EIGENE',
      'vocational-school:read:EIGENE',
      'overtime:read:EIGENE',
      'shift:read:EIGENE',
      'shift-pattern:read:EIGENE',
      'availability:read:EIGENE',
      'availability:update:EIGENE',
      'report:export:EIGENE'
    ]::text[], NOW(), NOW())
ON CONFLICT ("id") DO NOTHING;

-- 2) One TENANT assignment per eligible user on the system role of their legacy role, plus one
--    audit row per created assignment, actor System (D-05, AC-75-4..AC-75-6).
--
--    Eligible = the user has an "Employee" (which carries the tenant), that employee is NOT
--    anonymized, and the user holds no "RoleAssignment" yet. Anonymized persons hold no rights
--    (Phase 74b removes their assignments on anonymization) and are skipped (D-28). The
--    anonymization sentinel is the one of employee-anonymization-filter.ts: firstName
--    'Gelöscht' AND lastName starting with 'GELÖSCHT-'; the umlauts are written as U& escapes
--    so the match does not depend on the file encoding (precedent: 20260914154803).
--
--    The audit "newValue" uses the Phase 74b RoleAssignment keys verbatim (userId, accessRoleId,
--    roleName, scopeType, salonIds, employeeIds) plus origin, reason and legacyRole, so every
--    RoleAssignment audit row has one shape (75b-RESEARCH C-5). "userId" of the audit row is NULL:
--    the actor is the system, not a person.
--
--    The NOTICE reports four numbers that partition every "User" row: created assignments,
--    users without an Employee (no tenant, so no assignment — AC-75-5), anonymized users skipped,
--    and users skipped because they already held an assignment. Prisma does not surface notices;
--    docs/migrations.md carries read-only SELECTs that reproduce the numbers.
DO $$
DECLARE
  created_count int;
  without_employee_count int;
  anonymized_count int;
  already_assigned_count int;
BEGIN
  -- Counted BEFORE the insert: afterwards the created users would count as "already assigned".
  SELECT count(*) INTO without_employee_count
  FROM "User" u
  WHERE NOT EXISTS (SELECT 1 FROM "Employee" e WHERE e."userId" = u."id");

  SELECT count(*) INTO anonymized_count
  FROM "User" u
  JOIN "Employee" e ON e."userId" = u."id"
  WHERE e."firstName" = U&'Gel\00F6scht' AND e."lastName" LIKE U&'GEL\00D6SCHT-%';

  SELECT count(*) INTO already_assigned_count
  FROM "User" u
  JOIN "Employee" e ON e."userId" = u."id"
  WHERE NOT (e."firstName" = U&'Gel\00F6scht' AND e."lastName" LIKE U&'GEL\00D6SCHT-%')
    AND EXISTS (SELECT 1 FROM "RoleAssignment" ra WHERE ra."userId" = u."id");

  WITH created AS (
    INSERT INTO "RoleAssignment" (
      "id", "tenantId", "userId", "accessRoleId", "scopeType", "salonIds", "employeeIds",
      "createdAt", "updatedAt"
    )
    SELECT
      gen_random_uuid()::text,
      e."tenantId",
      u."id",
      CASE u."role"
        WHEN 'ADMIN' THEN '00000000-0000-4000-8000-00000000a001'
        WHEN 'MANAGER' THEN '00000000-0000-4000-8000-00000000a002'
        ELSE '00000000-0000-4000-8000-00000000a003'
      END,
      'TENANT',
      ARRAY[]::text[],
      ARRAY[]::text[],
      NOW(),
      NOW()
    FROM "User" u
    JOIN "Employee" e ON e."userId" = u."id"
    WHERE NOT (e."firstName" = U&'Gel\00F6scht' AND e."lastName" LIKE U&'GEL\00D6SCHT-%')
      AND NOT EXISTS (SELECT 1 FROM "RoleAssignment" ra WHERE ra."userId" = u."id")
    RETURNING "id", "userId", "accessRoleId"
  )
  INSERT INTO "AuditLog" ("id", "userId", "action", "entity", "entityId", "newValue", "createdAt")
  SELECT
    gen_random_uuid()::text,
    NULL,
    'CREATE',
    'RoleAssignment',
    created."id",
    jsonb_build_object(
      'origin', 'SYSTEM',
      'reason', 'Migration der Alt-Rolle (#75)',
      'userId', created."userId",
      'accessRoleId', created."accessRoleId",
      'roleName', ar."name",
      'scopeType', 'TENANT',
      'salonIds', '[]'::jsonb,
      'employeeIds', '[]'::jsonb,
      'legacyRole', u."role"::text
    ),
    NOW()
  FROM created
  JOIN "AccessRole" ar ON ar."id" = created."accessRoleId"
  JOIN "User" u ON u."id" = created."userId";

  -- One audit row per created assignment (both joins are 1:1), so this is the created count.
  GET DIAGNOSTICS created_count = ROW_COUNT;

  RAISE NOTICE 'Phase 75b legacy-role migration: % role assignment(s) created, % user(s) without Employee (no assignment), % anonymized user(s) skipped, % user(s) skipped (already assigned)',
    created_count, without_employee_count, anonymized_count, already_assigned_count;
END $$;
