/**
 * Test setup: creates a fresh Fastify app instance for integration tests.
 *
 * Uses the same database as dev (TODO: separate test DB for CI).
 * Each test suite should clean up its own data.
 */
import { buildApp } from "../app";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";

let app: FastifyInstance;

export async function getTestApp(): Promise<FastifyInstance> {
  if (!app) {
    app = await buildApp();
    await app.ready();
  }
  return app;
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
  const s = (suffix ? suffix + "-" : "") + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
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
  const adminPasswordHash = await bcrypt.hash("test1234", 10);
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
  const empPasswordHash = await bcrypt.hash("test1234", 10);
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

  await prisma.absence.deleteMany({ where: { employeeId: { in: employeeIds } } });
  await prisma.leaveRequest.deleteMany({ where: { employeeId: { in: employeeIds } } });
  await prisma.leaveEntitlement.deleteMany({ where: { employeeId: { in: employeeIds } } });
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
  await prisma.companyShutdown.deleteMany({ where: { tenantId } });
  await prisma.tenantConfig.deleteMany({ where: { tenantId } });
  await prisma.tenant.delete({ where: { id: tenantId } });
}
