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
import { leaveTypeFields } from "../contexts/absence/leave-type";
import {
  DEFAULT_SALON_OPENING_HOURS,
  findDefaultSalon,
  type SalonOpeningHours,
} from "../contexts/platform";

// Keep JsonValue reachable from this module's public types (intentional no-op type alias)
export type _SeedJsonValue = Prisma.JsonValue;

/**
 * Test-only lever that moves the year `seedTestData` provisions the fixture
 * LeaveEntitlement for. Absent or 0, this file behaves exactly as before.
 *
 * This is the calendar-axis counterpart to CLOKR_TEST_FAKE_CLOCK
 * (vitest.clock-setup.ts), which can only shift the time of day within today
 * and is structurally incapable of simulating a year rollover. Setting
 * CLOKR_TEST_SEED_YEAR_OFFSET=1 reproduces 2027-01-01 for the one thing that
 * actually depends on the year: whether the entitlement row a test books onto
 * exists at all.
 *
 * A non-zero offset is EXPECTED to break unrelated suites that legitimately
 * book into the live current year. It is a per-file diagnostic lever, never a
 * suite-wide mode.
 */
export const SEED_YEAR_OFFSET = Number(process.env.CLOKR_TEST_SEED_YEAR_OFFSET ?? 0);

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
 * Phase 325 (issue #325), D-17: create one salon for a fixture tenant. Accepts a
 * `Prisma.TransactionClient`-compatible client so both `app.prisma` and a `tx` inside a
 * transaction work. `isActive: false` also sets `deactivatedAt` (mirrors the real write path's
 * isActive<->deactivatedAt invariant, see `contexts/platform/facade/salons.ts`'s `createSalon`).
 * `createdAt` is accepted for deterministic ordering fixtures (e.g. proving "earliest active
 * salon wins" against a second, later-created salon).
 */
export async function createTestSalon(
  db: Prisma.TransactionClient,
  tenantId: string,
  overrides?: {
    name?: string;
    openingHours?: SalonOpeningHours;
    isActive?: boolean;
    createdAt?: Date;
  },
) {
  const isActive = overrides?.isActive ?? true;
  return db.salon.create({
    data: {
      tenantId,
      name: overrides?.name ?? "Test Salon",
      openingHours: overrides?.openingHours ?? DEFAULT_SALON_OPENING_HOURS,
      isActive,
      deactivatedAt: isActive ? null : new Date(),
      ...(overrides?.createdAt ? { createdAt: overrides.createdAt } : {}),
    },
  });
}

/**
 * Phase 325 (issue #325), D-17/research Pitfall 1: resolve the salon a fixture shift/appointment
 * for `employeeId` should use — always the SAME tenant as that employee's, by construction (never
 * a hardcoded id, never another fixture's salon). Uses the production default-salon rule
 * (`findDefaultSalon`) so a two-tenant test cannot accidentally cross-wire a salon. Throws when
 * the employee's tenant has no active salon — the fixture is missing a `createTestSalon()` call
 * right after its `tenant.create`.
 */
export async function salonIdForEmployee(
  db: Prisma.TransactionClient,
  employeeId: string,
): Promise<string> {
  const employee = await db.employee.findUniqueOrThrow({
    where: { id: employeeId },
    select: { tenantId: true },
  });
  const salon = await findDefaultSalon(db, employee.tenantId);
  if (!salon) {
    throw new Error(
      `salonIdForEmployee: employee ${employeeId} — fixture tenant has no active salon — call createTestSalon() after its tenant.create`,
    );
  }
  return salon.id;
}

/**
 * Phase 325 (issue #325), D-17: the pre-325 body of `seedTestData`, now called by it. Kept
 * module-private — the two overload signatures below are what callers see.
 */
async function seedTenantFixture(testApp: FastifyInstance, suffix = "") {
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

  // Create leave type for vacation. Phase 97 (T2): leaveTypeFields() pairs code and name
  // structurally, so this shared fixture — the highest-leverage one, reused across the whole
  // suite — cannot produce a row without a code.
  const vacationType = await prisma.leaveType.create({
    data: { tenantId: tenant.id, ...leaveTypeFields("VACATION"), color: "#3B82F6" },
  });

  // Create leave entitlement for current year
  const currentYear = new Date().getFullYear() + SEED_YEAR_OFFSET;
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
 * Seed a test tenant + admin user + employee and return auth tokens — plus, by default, one
 * active default salon for the tenant (Phase 325, issue #325, D-17), mirroring the real-tenant
 * invariant that every tenant has a salon (64b D-18). Pass `{ withDefaultSalon: false }` to opt
 * out for the handful of tests whose own docblock states "seedTestData does not create a Salon"
 * (`salons.test.ts`, `settings-store-hours-salon-mirror.test.ts`, and the tracer describe-block of
 * `salon-migration.test.ts`) — those tests build an exact salon topology of their own, and an
 * unconditional default salon would either flip a salon-count assertion or make the migration
 * replay test's own `INSERT` a silent no-op (see 325-RESEARCH.md Q4/Pitfall 2).
 *
 * Two overloads so `Awaited<ReturnType<typeof seedTestData>>` — used all over the existing
 * ~38-file default-path suite — resolves from the LAST overload and therefore always sees
 * `salonId: string`; only a caller that explicitly writes `{ withDefaultSalon: false }` inline
 * sees the narrower `salonId: null` type.
 */
export async function seedTestData(
  testApp: FastifyInstance,
  suffix: string,
  options: { withDefaultSalon: false },
): Promise<Awaited<ReturnType<typeof seedTenantFixture>> & { salonId: null }>;
export async function seedTestData(
  testApp: FastifyInstance,
  suffix?: string,
  options?: { withDefaultSalon?: true },
): Promise<Awaited<ReturnType<typeof seedTenantFixture>> & { salonId: string }>;
export async function seedTestData(
  testApp: FastifyInstance,
  suffix = "",
  options: { withDefaultSalon?: boolean } = {},
): Promise<Awaited<ReturnType<typeof seedTenantFixture>> & { salonId: string | null }> {
  const base = await seedTenantFixture(testApp, suffix);
  if (options.withDefaultSalon === false) {
    return { ...base, salonId: null };
  }
  const salon = await createTestSalon(testApp.prisma, base.tenant.id, { name: base.tenant.name });
  return { ...base, salonId: salon.id };
}

/**
 * Issue #256 (Befund 3): the DATEV export refuses to build a file without a
 * Berater-/Mandantennummer (HTTP 409, DATEV_KANZLEI_MISSING_ERROR).
 *
 * `seedTestData` deliberately leaves both columns null — "not configured" is exactly the
 * state that guard exists for, and a seed that quietly pre-filled them would make the
 * guard impossible to test. Every fixture that wants a SUCCESSFUL export therefore says
 * so explicitly, through this helper.
 */
export async function configureDatevKanzlei(
  testApp: FastifyInstance,
  tenantId: string,
  values: { beraterNr: number; mandantenNr: number } = { beraterNr: 28547, mandantenNr: 90909 },
) {
  await testApp.prisma.tenantConfig.update({
    where: { tenantId },
    data: { datevBeraterNr: values.beraterNr, datevMandantenNr: values.mandantenNr },
  });
}

/**
 * Idempotently ensure a `LeaveEntitlement` row exists for `employeeId` /
 * `leaveTypeId` for every year in `years`, in addition to whatever
 * `seedTestData` already provisioned for the live (or offset) current year.
 *
 * Issue #136 (batch B): `seedTestData` above seeds exactly ONE entitlement
 * row, for `new Date().getFullYear() + SEED_YEAR_OFFSET`, while several test
 * files book vacation deductions onto their own hardcoded fixture years
 * (2025/2026/2029/…). Those rows exist only while the live year happens to
 * match the literal — this helper provisions them explicitly so the fixture
 * is inert to the calendar, without rewriting the (often weekday-load-bearing,
 * see the plan's D-2) date literals themselves. Upsert, not create, so a
 * caller can safely re-request a year `seedTestData` (or a prior call) has
 * already provisioned.
 */
export async function seedEntitlementYears(
  app: FastifyInstance,
  opts: {
    employeeId: string;
    leaveTypeId: string;
    years: number[];
    totalDays?: number; // default 30, matching seedTestData
  },
): Promise<void> {
  const prisma = app.prisma;
  const totalDays = opts.totalDays ?? 30;
  for (const year of opts.years) {
    await prisma.leaveEntitlement.upsert({
      where: {
        employeeId_leaveTypeId_year: {
          employeeId: opts.employeeId,
          leaveTypeId: opts.leaveTypeId,
          year,
        },
      },
      create: {
        employeeId: opts.employeeId,
        leaveTypeId: opts.leaveTypeId,
        year,
        totalDays,
        usedDays: 0,
      },
      update: {},
    });
  }
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
  // Phase 64b (issue #64): Salon.tenant is onDelete: Restrict (D-01) — must be deleted before
  // prisma.tenant.delete below, or the delete fails and leaks fixture rows into the shared test
  // database. Phase 325 (issue #325): seedTestData() now creates a default salon for its tenant
  // (opt-out via `{ withDefaultSalon: false }`); Shift/PhorestAppointment -> Salon are ALSO
  // onDelete: Restrict, but the shift.deleteMany above already runs before this, so no reordering
  // was needed.
  await prisma.salon.deleteMany({ where: { tenantId } });
  await prisma.tenant.delete({ where: { id: tenantId } });
}
