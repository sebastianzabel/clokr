/**
 * Issue #539 (Release A), D-09 — the seeds' helper that gives a seeded user its system role as
 * a STORED role assignment.
 *
 * From Release A on, permissions come only from stored role assignments; the legacy fallback
 * that used to resolve a user without any row through `User.role` is gone. A seed that only
 * wrote `User.role` would therefore leave its admin (and every demo user) without a single
 * permission, so every user a seed module creates is followed by one call of
 * {@link ensureSystemRoleAssignment}.
 *
 * `packages/db` cannot import from `apps/api` (the dependency runs the other way), so
 * {@link SEED_SYSTEM_ROLE_IDS} is a deliberate pinned copy of the three legacy system-role ids
 * in `apps/api/src/contexts/platform/system-roles.ts` (`SYSTEM_ROLE_IDS`). The equality is
 * pinned by `apps/api/src/__tests__/seed-role-assignments-539.test.ts`, which also fails when a
 * seed module creates a user without a following helper call or when `tsconfig.seed.json` stops
 * compiling this module into the container's seed build.
 *
 * No audit-log row is written: a seed script has no request principal, the same reasoning as
 * every other seeding call (see `default-salon.ts`). Production writes go through employee
 * creation or the role-assignment API, both audited.
 *
 * No side effects on import — this module only exports data plus one idempotent helper.
 */
import type { PrismaClient } from "../generated/client";

/** Pinned copy of `SYSTEM_ROLE_IDS.ADMIN/.MANAGER/.EMPLOYEE` (drift test on the API side). */
export const SEED_SYSTEM_ROLE_IDS = {
  ADMIN: "00000000-0000-4000-8000-00000000a001",
  MANAGER: "00000000-0000-4000-8000-00000000a002",
  EMPLOYEE: "00000000-0000-4000-8000-00000000a003",
} as const;

/** The three system roles a seeded user can hold. */
export type SeedSystemRoleName = keyof typeof SEED_SYSTEM_ROLE_IDS;

/**
 * Gives `userId` the TENANT-scoped assignment of the system role `role`. Idempotent: an
 * upsert on the unique key `userId_accessRoleId_scopeType` that creates the row and updates
 * nothing, so a re-run against an already-seeded user changes no row.
 */
export async function ensureSystemRoleAssignment(
  prisma: Pick<PrismaClient, "roleAssignment">,
  input: { tenantId: string; userId: string; role: SeedSystemRoleName },
): Promise<void> {
  const accessRoleId = SEED_SYSTEM_ROLE_IDS[input.role];
  await prisma.roleAssignment.upsert({
    where: {
      userId_accessRoleId_scopeType: {
        userId: input.userId,
        accessRoleId,
        scopeType: "TENANT",
      },
    },
    create: {
      tenantId: input.tenantId,
      userId: input.userId,
      accessRoleId,
      scopeType: "TENANT",
      salonIds: [],
      employeeIds: [],
    },
    update: {},
  });
}
