/**
 * Phase 75b (Issue #75) — the system roles and the legacy-role data migration, proven on REAL SQL
 * execution of the checked-in file (`legacy-role-migration-sql.ts`), never on a restatement of it.
 *
 * - D-04 drift: the three global rows in the migrated worker database equal
 *   `SYSTEM_ROLE_PERMISSIONS` — the code constant and the migration cannot silently diverge.
 * - AC-75-4 / AC-75-6: a legacy MANAGER with an Employee receives exactly one TENANT assignment on
 *   the Manager system role, with exactly one CREATE audit row whose actor is the system.
 * - Edge cases (AC-75-4..AC-75-8, D-07, D-28): eligibility (anonymized, employee-less and
 *   pre-assigned users get nothing), idempotency of a second run, `User.role` untouched, and the
 *   four NOTICE numbers — read through a raw pg client, because Prisma does not surface notices.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import {
  executeLegacyRoleMigration,
  executeLegacyRoleMigrationCapturingNotices,
} from "./legacy-role-migration-sql";
import {
  SYSTEM_ROLE_IDS,
  SYSTEM_ROLE_NAMES,
  SYSTEM_ROLE_PERMISSIONS,
  DEFAULT_SALON_OPENING_HOURS,
  normalizeRolePermissions,
  roleNameKey,
} from "../contexts/platform";

type LegacyRole = "ADMIN" | "MANAGER" | "EMPLOYEE";

const MIGRATION_REASON = "Migration der Alt-Rolle (#75)";

/** Role-descriptive fixture user + employee — no person names (CLAUDE.md PII rule). */
async function createUserWithEmployee(
  app: FastifyInstance,
  tenantId: string,
  label: string,
  role: LegacyRole,
  options: { isActive?: boolean; anonymized?: boolean } = {},
) {
  const s = label + "-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const anonymizedLabel = `GELÖSCHT-${s}`.slice(0, 20);
  const user = await app.prisma.user.create({
    data: {
      email: options.anonymized ? `deleted-${s}@anonymized.local` : `${s}@test.de`,
      // The anonymization sentinel of anonymize.ts; a real hash otherwise.
      passwordHash: options.anonymized ? "ANONYMIZED" : await bcrypt.hash("test1234", 4),
      role,
      isActive: options.anonymized ? false : (options.isActive ?? true),
    },
  });
  const employee = await app.prisma.employee.create({
    data: {
      tenantId,
      userId: user.id,
      employeeNumber: options.anonymized ? anonymizedLabel : `MIG-${s}`.slice(0, 20),
      firstName: options.anonymized ? "Gelöscht" : label,
      lastName: options.anonymized ? anonymizedLabel : "Test",
      hireDate: new Date("2024-01-01"),
    },
  });
  return { user, employee };
}

/** The exact audit `newValue` the migration writes (74b keys verbatim + origin/reason/legacyRole). */
function expectedAuditValue(
  userId: string,
  accessRoleId: string,
  roleName: string,
  legacyRole: LegacyRole,
) {
  return {
    origin: "SYSTEM",
    reason: MIGRATION_REASON,
    userId,
    accessRoleId,
    roleName,
    scopeType: "TENANT",
    salonIds: [],
    employeeIds: [],
    legacyRole,
  };
}

interface MigrationCounts {
  created: number;
  withoutEmployee: number;
  anonymized: number;
  alreadyAssigned: number;
}

// __dirname is apps/api/src/__tests__ — four levels up is the repo root.
const MIGRATIONS_DOC = join(__dirname, "..", "..", "..", "..", "docs", "migrations.md");

/**
 * The single ```sql block between `<!-- <marker>:begin -->` and `<!-- <marker>:end -->` in
 * docs/migrations.md. The operators' SELECTs are executed FROM THE DOC, so the documented SQL
 * cannot drift from what the migration reports. A missing marker or block throws.
 */
function readDocumentedSql(marker: string): string {
  const doc = readFileSync(MIGRATIONS_DOC, "utf8");
  const begin = `<!-- ${marker}:begin -->`;
  const end = `<!-- ${marker}:end -->`;
  const beginIdx = doc.indexOf(begin);
  const endIdx = doc.indexOf(end);
  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) {
    throw new Error(`docs/migrations.md: markers "${begin}" / "${end}" not found in order`);
  }
  const blocks = [...doc.slice(beginIdx + begin.length, endIdx).matchAll(/```sql\n([\s\S]*?)```/g)];
  if (blocks.length !== 1) {
    throw new Error(
      `docs/migrations.md: expected one sql block in "${marker}", found ${blocks.length}`,
    );
  }
  return blocks[0][1];
}

/**
 * Read-only: the four numbers the migration's NOTICE reports, via the documented SELECT
 * (docs/migrations.md § Phase 75b). Run BEFORE the migration, "created" counts the users it is
 * about to assign; every "User" row falls into exactly one bucket.
 */
async function countMigrationBuckets(app: FastifyInstance): Promise<MigrationCounts> {
  const rows = await app.prisma.$queryRawUnsafe<
    { created: bigint; without_employee: bigint; anonymized: bigint; already_assigned: bigint }[]
  >(readDocumentedSql("75b-count-selects"));
  expect(rows).toHaveLength(1);
  return {
    created: Number(rows[0].created),
    withoutEmployee: Number(rows[0].without_employee),
    anonymized: Number(rows[0].anonymized),
    alreadyAssigned: Number(rows[0].already_assigned),
  };
}

const NOTICE_PATTERN =
  /^Phase 75b legacy-role migration: (\d+) role assignment\(s\) created, (\d+) user\(s\) without Employee \(no assignment\), (\d+) anonymized user\(s\) skipped, (\d+) user\(s\) skipped \(already assigned\)$/;

function parseNotice(message: string): MigrationCounts | null {
  const m = NOTICE_PATTERN.exec(message);
  if (!m) return null;
  return {
    created: Number(m[1]),
    withoutEmployee: Number(m[2]),
    anonymized: Number(m[3]),
    alreadyAssigned: Number(m[4]),
  };
}

describe("Phase 75b — system roles and legacy-role migration (Issue #75)", () => {
  let app: FastifyInstance;
  let tenantA: Awaited<ReturnType<typeof seedTestData>>;
  let manager: Awaited<ReturnType<typeof createUserWithEmployee>>;

  beforeAll(async () => {
    app = await getTestApp();
    tenantA = await seedTestData(app, "75b-mig-a");
    manager = await createUserWithEmployee(app, tenantA.tenant.id, "Manager", "MANAGER");
    await executeLegacyRoleMigration(app.prisma);
  });

  afterAll(async () => {
    try {
      // The user cascade removes the users' role assignments before the tenant is deleted.
      await cleanupTestData(app, tenantA.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("(a) D-04 drift: the three global rows equal SYSTEM_ROLE_PERMISSIONS", async () => {
    const rows = await app.prisma.accessRole.findMany({
      where: { id: { in: Object.values(SYSTEM_ROLE_IDS) } },
      orderBy: { id: "asc" },
    });
    expect(rows).toHaveLength(3);
    const bySlot = [
      ["ADMIN", rows[0]],
      ["MANAGER", rows[1]],
      ["EMPLOYEE", rows[2]],
    ] as const;
    for (const [slot, row] of bySlot) {
      expect(row.id).toBe(SYSTEM_ROLE_IDS[slot]);
      expect(row.tenantId).toBeNull();
      expect(row.name).toBe(SYSTEM_ROLE_NAMES[slot]);
      expect(row.nameKey).toBe(SYSTEM_ROLE_NAMES[slot].toLowerCase());
      expect(row.permissions).toEqual([...SYSTEM_ROLE_PERMISSIONS[slot]]);
    }
  });

  it("(b) a legacy MANAGER receives one TENANT assignment on the Manager role, audited as System", async () => {
    const assignments = await app.prisma.roleAssignment.findMany({
      where: { userId: manager.user.id },
    });
    expect(assignments).toHaveLength(1);
    const [assignment] = assignments;
    expect(assignment).toMatchObject({
      tenantId: tenantA.tenant.id,
      accessRoleId: SYSTEM_ROLE_IDS.MANAGER,
      scopeType: "TENANT",
      salonIds: [],
      employeeIds: [],
    });

    const audits = await app.prisma.auditLog.findMany({
      where: { entity: "RoleAssignment", entityId: assignment.id },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0].userId).toBeNull();
    expect(audits[0].action).toBe("CREATE");
    expect(audits[0].newValue).toEqual(
      expectedAuditValue(
        manager.user.id,
        SYSTEM_ROLE_IDS.MANAGER,
        SYSTEM_ROLE_NAMES.MANAGER,
        "MANAGER",
      ),
    );
  });
});

describe("legacy-role backfill edge cases (AC-75-4..AC-75-8, D-07, D-28)", () => {
  let app: FastifyInstance;
  let tenant: Awaited<ReturnType<typeof seedTestData>>;
  let manager: Awaited<ReturnType<typeof createUserWithEmployee>>;
  let inactiveEmployee: Awaited<ReturnType<typeof createUserWithEmployee>>;
  let anonymized: Awaited<ReturnType<typeof createUserWithEmployee>>;
  let preAssigned: Awaited<ReturnType<typeof createUserWithEmployee>>;
  let withoutEmployee: { id: string };
  let customerRoleId: string;
  let preAssignedRowBefore: unknown;

  /** The four eligible users and the system role each must end up on. */
  let eligible: { label: string; userId: string; roleId: string; legacyRole: LegacyRole }[];
  /** The users that must gain nothing. */
  let skipped: { label: string; userId: string }[];

  let usersBefore: { id: string; role: string; updatedAt: Date }[];
  let systemRolesBefore: { id: string; createdAt: Date; updatedAt: Date }[];
  let expectedCounts: MigrationCounts;
  let notices: string[];
  let reasonAuditsBeforeFirstRun: number;
  let reasonAuditsAfterFirstRun: number;
  let tablesAfterFirstRun: { assignments: number; audits: number; roles: number };
  let tablesAfterSecondRun: { assignments: number; audits: number; roles: number };
  let secondRunError: unknown;

  async function countReasonAudits(): Promise<number> {
    return app.prisma.auditLog.count({
      where: { entity: "RoleAssignment", newValue: { path: ["reason"], equals: MIGRATION_REASON } },
    });
  }

  async function countTables() {
    return {
      assignments: await app.prisma.roleAssignment.count(),
      audits: await app.prisma.auditLog.count(),
      roles: await app.prisma.accessRole.count(),
    };
  }

  beforeAll(async () => {
    app = await getTestApp();
    // seedTestData creates one legacy ADMIN and one legacy EMPLOYEE, each with an Employee.
    tenant = await seedTestData(app, "75b-mig-edge");
    const tenantId = tenant.tenant.id;
    manager = await createUserWithEmployee(app, tenantId, "Manager", "MANAGER");
    inactiveEmployee = await createUserWithEmployee(app, tenantId, "Inaktiv", "EMPLOYEE", {
      isActive: false,
    });
    anonymized = await createUserWithEmployee(app, tenantId, "Anonymisiert", "MANAGER", {
      anonymized: true,
    });
    preAssigned = await createUserWithEmployee(app, tenantId, "Vorbelegt", "EMPLOYEE");
    withoutEmployee = await app.prisma.user.create({
      data: {
        email: `ohne-mitarbeiter-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 4),
        role: "ADMIN",
        isActive: true,
      },
    });

    const salon = await app.prisma.salon.create({
      data: {
        tenantId,
        name: "Salon Migration",
        openingHours: DEFAULT_SALON_OPENING_HOURS,
        isActive: true,
      },
    });
    const customerRoleName = `Kundenrolle ${Date.now().toString(36)}`;
    const customerRole = await app.prisma.accessRole.create({
      data: {
        tenantId,
        name: customerRoleName,
        nameKey: roleNameKey(customerRoleName),
        permissions: normalizeRolePermissions(["shift:plan:ZUGEWIESEN"]),
      },
    });
    customerRoleId = customerRole.id;
    const preAssignedRow = await app.prisma.roleAssignment.create({
      data: {
        tenantId,
        userId: preAssigned.user.id,
        accessRoleId: customerRoleId,
        scopeType: "SALONS",
        salonIds: [salon.id],
        employeeIds: [],
      },
    });
    preAssignedRowBefore = preAssignedRow;

    eligible = [
      {
        label: "legacy ADMIN",
        userId: tenant.adminUser.id,
        roleId: SYSTEM_ROLE_IDS.ADMIN,
        legacyRole: "ADMIN",
      },
      {
        label: "legacy MANAGER",
        userId: manager.user.id,
        roleId: SYSTEM_ROLE_IDS.MANAGER,
        legacyRole: "MANAGER",
      },
      {
        label: "legacy EMPLOYEE",
        userId: tenant.empUser.id,
        roleId: SYSTEM_ROLE_IDS.EMPLOYEE,
        legacyRole: "EMPLOYEE",
      },
      {
        label: "inactive legacy EMPLOYEE",
        userId: inactiveEmployee.user.id,
        roleId: SYSTEM_ROLE_IDS.EMPLOYEE,
        legacyRole: "EMPLOYEE",
      },
    ];
    skipped = [
      { label: "anonymized", userId: anonymized.user.id },
      { label: "without Employee", userId: withoutEmployee.id },
      { label: "pre-assigned", userId: preAssigned.user.id },
    ];

    usersBefore = await app.prisma.user.findMany({
      select: { id: true, role: true, updatedAt: true },
      orderBy: { id: "asc" },
    });
    systemRolesBefore = await app.prisma.accessRole.findMany({
      where: { id: { in: Object.values(SYSTEM_ROLE_IDS) } },
      select: { id: true, createdAt: true, updatedAt: true },
      orderBy: { id: "asc" },
    });

    // First run through a raw pg client, so the NOTICE is visible. The expectation is computed
    // immediately before, over the whole worker database (leftover users of other suites count).
    expectedCounts = await countMigrationBuckets(app);
    reasonAuditsBeforeFirstRun = await countReasonAudits();
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error("DATABASE_URL is not set for this test worker");
    notices = await executeLegacyRoleMigrationCapturingNotices(databaseUrl);
    reasonAuditsAfterFirstRun = await countReasonAudits();
    tablesAfterFirstRun = await countTables();

    // Second run through the Prisma path: must change nothing (D-07). A failure is recorded, not
    // thrown, so it turns the idempotency case red by name instead of aborting the whole suite.
    secondRunError = await executeLegacyRoleMigration(app.prisma).then(
      () => null,
      (err: unknown) => err,
    );
    tablesAfterSecondRun = await countTables();
  });

  afterAll(async () => {
    try {
      await app.prisma.user.delete({ where: { id: withoutEmployee.id } });
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    try {
      // The user cascade removes every role assignment (incl. the SALONS one) first; the customer
      // role cascades with the tenant.
      await cleanupTestData(app, tenant.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("gives each eligible user exactly one TENANT assignment on the system role of their legacy role", async () => {
    for (const user of eligible) {
      const rows = await app.prisma.roleAssignment.findMany({ where: { userId: user.userId } });
      expect(rows, user.label).toHaveLength(1);
      expect(rows[0], user.label).toMatchObject({
        tenantId: tenant.tenant.id,
        accessRoleId: user.roleId,
        scopeType: "TENANT",
        salonIds: [],
        employeeIds: [],
      });
    }
  });

  it("writes exactly one System CREATE audit per created assignment, with the right legacyRole", async () => {
    for (const user of eligible) {
      const [assignment] = await app.prisma.roleAssignment.findMany({
        where: { userId: user.userId },
      });
      const audits = await app.prisma.auditLog.findMany({
        where: { entity: "RoleAssignment", entityId: assignment.id },
      });
      expect(audits, user.label).toHaveLength(1);
      expect(audits[0].userId, user.label).toBeNull();
      expect(audits[0].action, user.label).toBe("CREATE");
      const roleName =
        user.roleId === SYSTEM_ROLE_IDS.ADMIN
          ? SYSTEM_ROLE_NAMES.ADMIN
          : user.roleId === SYSTEM_ROLE_IDS.MANAGER
            ? SYSTEM_ROLE_NAMES.MANAGER
            : SYSTEM_ROLE_NAMES.EMPLOYEE;
      expect(audits[0].newValue, user.label).toEqual(
        expectedAuditValue(user.userId, user.roleId, roleName, user.legacyRole),
      );
    }
  });

  it("gives anonymized, employee-less and pre-assigned users no new row and no audit", async () => {
    for (const user of skipped) {
      const systemRows = await app.prisma.roleAssignment.findMany({
        where: { userId: user.userId, accessRoleId: { in: Object.values(SYSTEM_ROLE_IDS) } },
      });
      expect(systemRows, user.label).toEqual([]);
      const audits = await app.prisma.auditLog.findMany({
        where: { entity: "RoleAssignment", newValue: { path: ["userId"], equals: user.userId } },
      });
      expect(audits, user.label).toEqual([]);
    }
    expect(await app.prisma.roleAssignment.count({ where: { userId: anonymized.user.id } })).toBe(
      0,
    );
    expect(await app.prisma.roleAssignment.count({ where: { userId: withoutEmployee.id } })).toBe(
      0,
    );
  });

  it("leaves the pre-assigned user's customer-role SALONS row unchanged", async () => {
    const rows = await app.prisma.roleAssignment.findMany({
      where: { userId: preAssigned.user.id },
    });
    expect(rows).toEqual([preAssignedRowBefore]);
    expect(rows[0].accessRoleId).toBe(customerRoleId);
  });

  it("is idempotent: a second run creates no RoleAssignment, AuditLog or AccessRole row", () => {
    expect(secondRunError, "the second run of the migration failed").toBeNull();
    expect(tablesAfterSecondRun).toEqual(tablesAfterFirstRun);
  });

  it("keeps the system-role rows as they were (ON CONFLICT DO NOTHING)", async () => {
    const after = await app.prisma.accessRole.findMany({
      where: { id: { in: Object.values(SYSTEM_ROLE_IDS) } },
      select: { id: true, createdAt: true, updatedAt: true },
      orderBy: { id: "asc" },
    });
    expect(after).toHaveLength(3);
    expect(after).toEqual(systemRolesBefore);
  });

  it("never writes a User row: role and updatedAt identical for every user after both runs (AC-75-8)", async () => {
    const after = await app.prisma.user.findMany({
      select: { id: true, role: true, updatedAt: true },
      orderBy: { id: "asc" },
    });
    expect(after).toEqual(usersBefore);
    const fixtureIds = [...eligible, ...skipped].map((u) => u.userId);
    expect(after.filter((u) => fixtureIds.includes(u.id))).toHaveLength(fixtureIds.length);
  });

  it("reports exactly one NOTICE whose four numbers equal the documented count SELECT (docs/migrations.md)", () => {
    const parsed = notices.map(parseNotice).filter((n): n is MigrationCounts => n !== null);
    expect(notices, "expected exactly one NOTICE from the migration").toHaveLength(1);
    expect(parsed, `NOTICE did not match the expected format: ${notices[0]}`).toHaveLength(1);
    expect(parsed[0]).toEqual(expectedCounts);
    // The fixture alone guarantees these lower bounds, so the comparison above is not 0 == 0.
    expect(expectedCounts.created).toBeGreaterThanOrEqual(eligible.length);
    expect(expectedCounts.withoutEmployee).toBeGreaterThanOrEqual(1);
    expect(expectedCounts.anonymized).toBeGreaterThanOrEqual(1);
    expect(expectedCounts.alreadyAssigned).toBeGreaterThanOrEqual(1);
    // "created" is also what the audit trail shows: one reason-tagged audit row per assignment.
    expect(reasonAuditsAfterFirstRun - reasonAuditsBeforeFirstRun).toBe(expectedCounts.created);
  });

  it("after the migration the documented count SELECT shows nothing left to create (post-deploy check)", async () => {
    const after = await countMigrationBuckets(app);
    expect(after).toEqual({
      created: 0,
      withoutEmployee: expectedCounts.withoutEmployee,
      anonymized: expectedCounts.anonymized,
      alreadyAssigned: expectedCounts.alreadyAssigned + expectedCounts.created,
    });
  });

  it("the documented consistency SELECT reports a column/assignment divergence and nothing else for the fixture", async () => {
    const rows = await app.prisma.$queryRawUnsafe<
      { id: string; column_role: string; derived_role: string }[]
    >(readDocumentedSql("75b-consistency-select"));
    const fixtureIds = new Set([...eligible, ...skipped].map((u) => u.userId));
    const fixtureRows = rows.filter((r) => fixtureIds.has(r.id));
    // Only the pre-assigned user diverges: legacy EMPLOYEE in the column, but a stored customer
    // role with a ZUGEWIESEN permission derives MANAGER. Every migrated user agrees by
    // construction (the migration assigns the system role of the unchanged column).
    expect(fixtureRows).toEqual([
      { id: preAssigned.user.id, column_role: "EMPLOYEE", derived_role: "MANAGER" },
    ]);
  });
});
