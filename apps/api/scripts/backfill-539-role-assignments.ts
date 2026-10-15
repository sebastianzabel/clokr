/**
 * Takeover tool — Issue #539 (Release A), D-01.
 *
 * Until Release A the API resolved the permissions of an ACTIVE user with no stored role assignment
 * in its tenant through the legacy `User.role` column (the "Altrollen-Rückfall"): the system role
 * that column stands for acted as one implicit whole-tenant assignment. Release A removes that
 * fallback — a user without a stored assignment then holds nothing. This script gives every user
 * the fallback still served the assignment it implicitly held, so the removal changes nobody's
 * rights. It is kept for future instances: run it on EVERY instance before deploying Release A
 * (docs/migrations.md, "Phase 539"). On int and prod the probe of 15.10.2026 listed 0 users.
 *
 * Who is eligible (all conditions): the user is active; it has an Employee, and that Employee has a
 * non-blank tenant (a user without an Employee has no tenant since #551 and never resolved
 * anything); the Employee is not DSGVO-anonymised (anonymisation hard-deletes the assignments on
 * purpose, #74b, so an anonymised user must never get one back); and the user holds NO role
 * assignment row at all in that tenant. The last condition is exactly when the old fallback
 * applied: ANY row — even a malformed one — switched it off. A user whose only rows are malformed
 * therefore resolves to nothing today and keeps resolving to nothing: it is neither eligible nor
 * touched, only counted. An inactive user is never touched either.
 *
 * What is written (`--confirm` only): per eligible user, in its own transaction under the Tenant row
 * lock (`FOR NO KEY UPDATE`, the lock every role-assignment write takes) and after a re-check of
 * everything above, one TENANT assignment on `systemRoleIdForLegacyRole(User.role)` — the
 * fallback's own mapping, so "what the fallback resolves to" holds by construction — plus one
 * `CREATE RoleAssignment` audit row with `userId` NULL (the actor is the system, like the data
 * migration of Phase 75b), `origin: "SYSTEM"`, the reason "Übernahme der Alt-Rolle (#75)" and the
 * legacy role. `User.role` is never written (D-06: the column stays until Release B).
 *
 * Idempotent: a user that holds a row is no longer eligible, so a second run writes nothing.
 * Read-only by default: without `--confirm` nothing is written.
 *
 * Output: ids and counts only, never a name or an e-mail address (DSGVO). One line per eligible
 * user, a totals line, and an informational line with the counts of users the script does NOT
 * touch, among them the column drift (users whose stored rows derive a different compat role than
 * the column holds — informational only, the takeover never "repairs" it; D-18).
 *
 * Usage:
 *   DATABASE_URL=<dsn> pnpm --filter @clokr/api exec tsx \
 *     scripts/backfill-539-role-assignments.ts [--confirm] [--help]
 *
 * Exit codes:
 *   0 — nothing to take over (dry run), or the takeover ran (--confirm)
 *   1 — DATABASE_URL missing, bad CLI, or a DB connection/query/write failure
 *   2 — dry run: one or more users are eligible (review, then run with --confirm)
 */
import { PrismaClient, type Prisma, type Role } from "@clokr/db";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { deriveCompatRole, systemRoleIdForLegacyRole } from "../src/contexts/platform/compat-role";
import { isBlankTenantId } from "../src/contexts/platform/access-context-error";
import { isAnonymizedEmployee } from "../src/contexts/platform/employee-anonymization-filter";
import { lockTenantForRoleChanges } from "../src/contexts/platform/facade/role-assignments";
import { materializedAssignmentAuditEntry } from "../src/contexts/platform/role-assignment-audit";
import { storedRoleAssignmentScope } from "../src/contexts/platform/role-assignment";

// ── Exit codes ──────────────────────────────────────────────────────────────
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_FINDINGS = 2;

// ── CLI parsing ───────────────────────────────────────────────────────────────
export type CliArgs = { help: boolean; confirm: boolean };

export function parseCli(argv: string[]): CliArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      help: { type: "boolean", default: false },
      confirm: { type: "boolean", default: false },
    },
    strict: true, // rejects any unknown flag
  });
  return { help: Boolean(values.help), confirm: Boolean(values.confirm) };
}

export const USAGE = `
Usage:
  DATABASE_URL=<dsn> pnpm --filter @clokr/api exec tsx \\
    scripts/backfill-539-role-assignments.ts [--confirm] [--help]

Issue #539 (Release A): gives every ACTIVE user without a stored role assignment the whole-tenant
system-role assignment the legacy-role fallback granted until now (the system role of User.role).

Without --confirm this is a READ-ONLY dry run: it lists the eligible users (ids only), totals per
role and informational counts, writes nothing, and exits 2 when anyone is eligible.
With --confirm it writes one audited assignment per eligible user (one transaction per user) and
exits 0. Inactive, anonymised, Employee-less and malformed-only users are never touched.
Run the dry run on every instance BEFORE deploying Release A, then --confirm if it lists anyone.
`;

// ── Candidate selection ─────────────────────────────────────────────────────

/** A user the old fallback served and Release A would leave without any permission. */
export type TakeoverCandidate = {
  userId: string;
  tenantId: string;
  /** The `User.role` column, i.e. the role the fallback resolves to today. */
  legacyRole: Role;
  /** True when the tenant is deactivated — informational, such a user is taken over like any other. */
  tenantDeactivated: boolean;
};

/** Counts of the users the script does NOT take over, for the operator's information only. */
export type TakeoverReport = {
  eligibleByRole: Record<Role, number>;
  eligibleInDeactivatedTenants: number;
  inactiveWithoutAssignment: number;
  anonymisedWithoutAssignment: number;
  withoutEmployee: number;
  malformedOnly: number;
  columnDrift: number;
};

export async function findTakeoverCandidates(
  prisma: PrismaClient,
): Promise<{ candidates: TakeoverCandidate[]; report: TakeoverReport }> {
  const users = await prisma.user.findMany({
    select: {
      id: true,
      role: true,
      isActive: true,
      employee: {
        select: {
          tenantId: true,
          firstName: true,
          lastName: true,
          tenant: { select: { deactivatedAt: true } },
        },
      },
      roleAssignments: {
        select: {
          tenantId: true,
          scopeType: true,
          salonIds: true,
          employeeIds: true,
          accessRole: { select: { id: true, tenantId: true, permissions: true } },
        },
      },
    },
    orderBy: { id: "asc" },
  });

  const candidates: TakeoverCandidate[] = [];
  const report: TakeoverReport = {
    eligibleByRole: { ADMIN: 0, MANAGER: 0, EMPLOYEE: 0 },
    eligibleInDeactivatedTenants: 0,
    inactiveWithoutAssignment: 0,
    anonymisedWithoutAssignment: 0,
    withoutEmployee: 0,
    malformedOnly: 0,
    columnDrift: 0,
  };

  for (const user of users) {
    if (!user.isActive) {
      if (user.roleAssignments.length === 0) report.inactiveWithoutAssignment += 1;
      continue;
    }
    const employee = user.employee;
    if (employee === null || isBlankTenantId(employee.tenantId)) {
      report.withoutEmployee += 1;
      continue;
    }
    const rowsHere = user.roleAssignments.filter((row) => row.tenantId === employee.tenantId);
    if (isAnonymizedEmployee(employee)) {
      if (rowsHere.length === 0) report.anonymisedWithoutAssignment += 1;
      continue;
    }
    if (rowsHere.length > 0) {
      // The fallback never applied to this user. Report what an operator wants to know about it.
      if (rowsHere.every((row) => storedRoleAssignmentScope(row) === null)) {
        report.malformedOnly += 1;
      }
      if (deriveCompatRole(employee.tenantId, rowsHere) !== user.role) report.columnDrift += 1;
      continue;
    }
    candidates.push({
      userId: user.id,
      tenantId: employee.tenantId,
      legacyRole: user.role,
      tenantDeactivated: employee.tenant.deactivatedAt !== null,
    });
    report.eligibleByRole[user.role] += 1;
    if (employee.tenant.deactivatedAt !== null) report.eligibleInDeactivatedTenants += 1;
  }

  return { candidates, report };
}

// ── The takeover of one user ────────────────────────────────────────────────

/**
 * Takes over ONE user in its own transaction. The Tenant row is locked first, exactly like every
 * role-assignment write, and everything the selection decided is re-read under the lock: a user
 * that was deactivated, anonymised or given an assignment in the meantime is SKIPPED, never written.
 * The role is re-read as well, so the row always matches what the fallback resolves to at the
 * moment of the write.
 */
export async function takeOverUser(
  prisma: PrismaClient,
  candidate: TakeoverCandidate,
): Promise<"WRITTEN" | "SKIPPED"> {
  return prisma.$transaction(async (tx) => {
    await lockTenantForRoleChanges(tx, candidate.tenantId);

    const user = await tx.user.findUnique({
      where: { id: candidate.userId },
      select: {
        role: true,
        isActive: true,
        employee: { select: { tenantId: true, firstName: true, lastName: true } },
      },
    });
    if (
      user === null ||
      !user.isActive ||
      user.employee === null ||
      user.employee.tenantId !== candidate.tenantId ||
      isAnonymizedEmployee(user.employee)
    ) {
      return "SKIPPED";
    }

    const accessRoleId = systemRoleIdForLegacyRole(user.role);
    // Any row of the user in this tenant switched the fallback off; a row with the same unique key
    // (user, role, scope type) elsewhere would make the insert fail. Either way: not eligible.
    const existing = await tx.roleAssignment.count({
      where: {
        userId: candidate.userId,
        OR: [{ tenantId: candidate.tenantId }, { accessRoleId, scopeType: "TENANT" }],
      },
    });
    if (existing > 0) return "SKIPPED";

    const created = await tx.roleAssignment.create({
      data: {
        tenantId: candidate.tenantId,
        userId: candidate.userId,
        accessRoleId,
        scopeType: "TENANT",
        salonIds: [],
        employeeIds: [],
      },
      select: {
        id: true,
        userId: true,
        accessRoleId: true,
        scopeType: true,
        salonIds: true,
        employeeIds: true,
        accessRole: { select: { name: true } },
      },
    });

    const entry = materializedAssignmentAuditEntry({
      assignment: {
        id: created.id,
        userId: created.userId,
        accessRoleId: created.accessRoleId,
        scopeType: created.scopeType,
        salonIds: created.salonIds,
        employeeIds: created.employeeIds,
        roleName: created.accessRole.name,
      },
      legacyRole: user.role,
    });
    // `userId` stays NULL: the grant has no acting user, the system stored what the fallback
    // already granted (as the SYSTEM rows of the Phase 75b migration). No request, so no ip/agent.
    await tx.auditLog.create({
      data: {
        userId: null,
        action: entry.action,
        entity: "RoleAssignment",
        entityId: entry.entityId,
        newValue: entry.newValue as Prisma.InputJsonValue,
      },
    });
    return "WRITTEN";
  });
}

// ── Entry point ─────────────────────────────────────────────────────────────

/**
 * Exported for unit-testability — pass a PrismaClient to inject a test connection (run against the
 * worker test DB only); without one the CLI entrypoint below bootstraps its own connection from
 * DATABASE_URL.
 */
export async function main(argv: string[], injectedPrisma?: PrismaClient): Promise<number> {
  const args = parseCli(argv);

  if (args.help) {
    console.info(USAGE);
    return EXIT_OK;
  }

  if (!injectedPrisma && !process.env.DATABASE_URL) {
    console.error("DATABASE_URL is required");
    return EXIT_ERROR;
  }

  let pool: pg.Pool | undefined;
  let prisma: PrismaClient;
  if (injectedPrisma) {
    prisma = injectedPrisma;
  } else {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = new PrismaPg(pool as any);
    prisma = new PrismaClient({ adapter });
  }

  try {
    const { candidates, report } = await findTakeoverCandidates(prisma);

    for (const candidate of candidates) {
      console.info(
        `userId=${candidate.userId} tenantId=${candidate.tenantId} legacyRole=${candidate.legacyRole}`,
      );
    }
    console.info(
      `Totals: eligible=${candidates.length} ADMIN=${report.eligibleByRole.ADMIN} ` +
        `MANAGER=${report.eligibleByRole.MANAGER} EMPLOYEE=${report.eligibleByRole.EMPLOYEE} ` +
        `inDeactivatedTenants=${report.eligibleInDeactivatedTenants}`,
    );
    console.info(
      `Informational: inactiveWithoutAssignment=${report.inactiveWithoutAssignment} ` +
        `anonymisedWithoutAssignment=${report.anonymisedWithoutAssignment} ` +
        `withoutEmployee=${report.withoutEmployee} malformedOnly=${report.malformedOnly} ` +
        `columnDrift=${report.columnDrift}`,
    );

    if (!args.confirm) {
      if (candidates.length === 0) {
        console.info("No active user without a stored role assignment. Nothing to take over.");
        return EXIT_OK;
      }
      console.info(
        "Dry run: nothing was written. Run with --confirm to give the listed users the " +
          "assignment the legacy-role fallback granted them.",
      );
      return EXIT_FINDINGS;
    }

    let written = 0;
    let skipped = 0;
    for (const candidate of candidates) {
      const outcome = await takeOverUser(prisma, candidate);
      if (outcome === "WRITTEN") written += 1;
      else skipped += 1;
    }
    console.info(`written=${written} skipped=${skipped}`);
    return EXIT_OK;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return EXIT_ERROR;
  } finally {
    if (!injectedPrisma) {
      await prisma.$disconnect();
      await pool?.end();
    }
  }
}

// Run-guard: only bootstrap the DB + execute when invoked as a script, so importing the module
// for unit tests is side-effect-free (no connection, no process.exit).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = EXIT_ERROR;
    });
}
