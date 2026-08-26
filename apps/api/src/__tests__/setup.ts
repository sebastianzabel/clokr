/**
 * Test setup: creates a fresh Fastify app instance for integration tests.
 *
 * Connects to the separate `clokr_test` database, provisioned by
 * `pnpm --filter @clokr/api run test:setup` (see docs/testing.md) — never the dev
 * database. Suites still share that one database within a run, so each test suite must
 * clean up its own data.
 */
import { buildApp } from "../app";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
// Re-export Prisma.JsonValue to keep it nameable in the inferred return type of
// seedTestData(). Adding `uiPreferences Json?` to User caused TS2883 because the
// inferred return type implicitly references JsonValue without a local binding.
import { Prisma } from "@clokr/db";

// Keep JsonValue reachable from this module's public types (intentional no-op type alias)
export type _SeedJsonValue = Prisma.JsonValue;

let app: FastifyInstance;

export async function getTestApp(): Promise<FastifyInstance> {
  if (!app) {
    app = await buildApp();
    await app.ready();
  }
  return app;
}

// Phase 106 (D-03): bcrypt at cost factor 10 is ~65ms of pure CPU per call, and seedTestData()
// below calls it twice per invocation (admin + employee) for the SAME constant fixture password —
// 338 raw call sites across the suite, measured (106-MEASUREMENTS.md § "Cost-driver profile"),
// none of them varying the plaintext. The resulting hash is reusable — memoising it removes the
// repeated work WITHOUT changing the cost factor, the stored hash shape, or anything
// bcrypt.compare() sees (R6: not a weakened assertion — every auth test still verifies a real
// bcrypt-produced digest at the same cost factor).
//
// A plain module-level Map only survives WITHIN one test file: Vitest's `isolate: true` rebuilds
// this module's state fresh for every file, even inside the same forked worker process (measured
// directly — this file's own `app` singleton above rebuilds once per file, not once per worker;
// see 106-MEASUREMENTS.md's "S2 — app boot" section). `process.env` is the one primitive that DOES
// survive that reset — it is how `vitest.worker-setup.ts`'s own `DATABASE_URL` assignment survives
// across every file in a worker — so it backs this cache too, making it genuinely per WORKER
// PROCESS rather than merely per file.
const fixtureHashes = new Map<string, string>();
const FIXTURE_HASH_ENV_PREFIX = "__CLOKR_TEST_FIXTURE_HASH__";

async function fixturePasswordHash(plaintext: string): Promise<string> {
  const cached = fixtureHashes.get(plaintext);
  if (cached) return cached;

  const envKey = FIXTURE_HASH_ENV_PREFIX + plaintext;
  const fromEnv = process.env[envKey];
  if (fromEnv) {
    fixtureHashes.set(plaintext, fromEnv);
    return fromEnv;
  }

  const hash = await bcrypt.hash(plaintext, 10);
  fixtureHashes.set(plaintext, hash);
  process.env[envKey] = hash;
  return hash;
}

/**
 * Noop in test runs — the app instance is shared across suites.
 * Vitest handles cleanup when the process exits.
 */
export async function closeTestApp(): Promise<void> {
  // Intentionally empty — shared singleton
}

/**
 * Seed a test tenant + admin user + employee and return auth tokens.
 * Uses a unique suffix to avoid conflicts with other tests.
 */
export async function seedTestData(testApp: FastifyInstance, suffix = "") {
  const s =
    (suffix ? suffix + "-" : "") + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const prisma = testApp.prisma;

  // Create tenant
  const tenant = await prisma.tenant.create({
    data: {
      name: `Test Tenant ${s}`,
      slug: `test-${s}`,
      federalState: "NIEDERSACHSEN",
    },
  });

  // Create tenant config
  await prisma.tenantConfig.create({
    data: {
      tenantId: tenant.id,
      defaultVacationDays: 30,
      timezone: "Europe/Berlin",
    },
  });

  // Create admin user
  const adminPasswordHash = await fixturePasswordHash("test1234");
  const adminUser = await prisma.user.create({
    data: {
      email: `admin-${s}@test.de`,
      passwordHash: adminPasswordHash,
      role: "ADMIN",
      isActive: true,
    },
  });

  // Create admin employee
  const adminEmployee = await prisma.employee.create({
    data: {
      tenantId: tenant.id,
      userId: adminUser.id,
      employeeNumber: `A-${s}`,
      firstName: "Admin",
      lastName: "Test",
      hireDate: new Date("2024-01-01"),
    },
  });

  await prisma.workSchedule.create({
    data: {
      employeeId: adminEmployee.id,
      weeklyHours: 40,
      mondayHours: 8,
      tuesdayHours: 8,
      wednesdayHours: 8,
      thursdayHours: 8,
      fridayHours: 8,
      saturdayHours: 0,
      sundayHours: 0,
      validFrom: new Date("2024-01-01"),
    },
  });

  await prisma.overtimeAccount.create({
    data: { employeeId: adminEmployee.id, balanceHours: 0 },
  });

  // Create regular employee user
  const empPasswordHash = await fixturePasswordHash("test1234");
  const empUser = await prisma.user.create({
    data: {
      email: `emp-${s}@test.de`,
      passwordHash: empPasswordHash,
      role: "EMPLOYEE",
      isActive: true,
    },
  });

  const employee = await prisma.employee.create({
    data: {
      tenantId: tenant.id,
      userId: empUser.id,
      employeeNumber: `E-${s}`,
      firstName: "Max",
      lastName: "Test",
      hireDate: new Date("2024-01-01"),
    },
  });

  await prisma.workSchedule.create({
    data: {
      employeeId: employee.id,
      weeklyHours: 40,
      mondayHours: 8,
      tuesdayHours: 8,
      wednesdayHours: 8,
      thursdayHours: 8,
      fridayHours: 8,
      saturdayHours: 0,
      sundayHours: 0,
      validFrom: new Date("2024-01-01"),
    },
  });

  await prisma.overtimeAccount.create({
    data: { employeeId: employee.id, balanceHours: 0 },
  });

  // Create leave type for vacation
  const vacationType = await prisma.leaveType.create({
    data: {
      tenantId: tenant.id,
      name: "Urlaub",
      isPaid: true,
      requiresApproval: true,
      color: "#3B82F6",
    },
  });

  // Create leave entitlement for current year
  const currentYear = new Date().getFullYear();
  await prisma.leaveEntitlement.create({
    data: {
      employeeId: employee.id,
      leaveTypeId: vacationType.id,
      year: currentYear,
      totalDays: 30,
      usedDays: 0,
    },
  });

  // Login as admin to get token
  const loginRes = await testApp.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: `admin-${s}@test.de`, password: "test1234" },
  });
  const { accessToken: adminToken } = JSON.parse(loginRes.body);

  // Login as employee
  const empLoginRes = await testApp.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: `emp-${s}@test.de`, password: "test1234" },
  });
  const { accessToken: empToken } = JSON.parse(empLoginRes.body);

  return {
    tenant,
    adminUser,
    adminEmployee,
    adminToken,
    empUser,
    employee,
    empToken,
    vacationType,
  };
}

/**
 * Clean up test data for a specific tenant.
 * MUST be called inside try/catch in afterAll to guarantee cleanup on test failure:
 *
 * afterAll(async () => {
 *   try {
 *     await cleanupTestData(testApp, tenant.id);
 *   } catch (err) {
 *     console.error("Test cleanup failed:", err);
 *   }
 * });
 */
export async function cleanupTestData(testApp: FastifyInstance, tenantId: string) {
  const prisma = testApp.prisma;

  // Delete in dependency order
  const employees = await prisma.employee.findMany({
    where: { tenantId },
    select: { id: true, userId: true },
  });
  const employeeIds = employees.map((e) => e.id);
  const userIds = employees.map((e) => e.userId);

  await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.employeeAvailability.deleteMany({ where: { employeeId: { in: employeeIds } } });
  await prisma.employeeShiftPattern.deleteMany({ where: { employeeId: { in: employeeIds } } });
  await prisma.employeeVocationalSchoolPattern.deleteMany({
    where: { employeeId: { in: employeeIds } },
  });
  await prisma.shift.deleteMany({ where: { employeeId: { in: employeeIds } } });
  await prisma.absence.deleteMany({ where: { employeeId: { in: employeeIds } } });
  // Phase 104-05: Section9Credit's two LeaveRequest FKs (sickRequest/vacationRequest) are
  // onDelete: Restrict — must be deleted before leaveRequest.deleteMany, or the delete below
  // fails silently (afterAll only console.error's cleanup failures) and leaks fixture rows
  // into clokr_test, breaking the next run's unique-constraint assumptions (see 104-04-SUMMARY.md).
  await prisma.section9Credit.deleteMany({ where: { employeeId: { in: employeeIds } } });
  await prisma.leaveRequest.deleteMany({ where: { employeeId: { in: employeeIds } } });
  await prisma.leaveEntitlement.deleteMany({ where: { employeeId: { in: employeeIds } } });
  await prisma.saldoSnapshot.deleteMany({ where: { employeeId: { in: employeeIds } } });
  await prisma.timeEntry.deleteMany({ where: { employeeId: { in: employeeIds } } });
  await prisma.overtimeTransaction.deleteMany({
    where: { overtimeAccount: { employeeId: { in: employeeIds } } },
  });
  await prisma.overtimeAccount.deleteMany({ where: { employeeId: { in: employeeIds } } });
  await prisma.overtimePlan.deleteMany({ where: { employeeId: { in: employeeIds } } });
  await prisma.invitation.deleteMany({ where: { employeeId: { in: employeeIds } } });
  await prisma.workSchedule.deleteMany({ where: { employeeId: { in: employeeIds } } });
  await prisma.employee.deleteMany({ where: { tenantId } });
  await prisma.refreshToken.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.otpToken.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.leaveType.deleteMany({ where: { tenantId } });
  await prisma.publicHoliday.deleteMany({ where: { tenantId } });
  await prisma.coverageRule.deleteMany({ where: { tenantId } });
  await prisma.shiftTemplate.deleteMany({ where: { tenantId } });
  await prisma.companyShutdown.deleteMany({ where: { tenantId } });
  await prisma.terminalApiKey.deleteMany({ where: { tenantId } });
  await prisma.tenantConfig.deleteMany({ where: { tenantId } });
  await prisma.tenant.delete({ where: { id: tenantId } });
}
