/**
 * Issue #617 - the one fixture of the Monatsexport tests: nine synthetic persons in one tenant, each
 * exercising a different way the month figures and the DATEV day counts are produced (closed month in
 * both snapshot conventions, open month with every leave kind, SHIFT_BASED, an unlabelled
 * MONTHLY_HOURS contract, a confirmed § 9 credit, an orphan § 9 day, an exit inside the month, an
 * Azubi with a Berufsschule day).
 *
 * The export month is September 2026 and `Date` is faked to mid-October (the month AFTER the export
 * month) by the callers. Employee numbers and names are deterministic so the DATEV file produced for
 * the fixture can be compared byte for byte; ids and the seed tenant never appear in the DATEV file
 * (the two seed employees carry random numbers and are normalised by `normalizeDatevText`).
 */
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import {
  seedTestData,
  grantSystemRole,
  configureDatevKanzlei,
  salonIdForEmployee,
  numericEmployeeNumber,
} from "./setup";
import { legacySaldoSnapshotPeriodBounds, saldoSnapshotPeriodBounds } from "./test-dates";
import { leaveTypeFields, type RequestableCode } from "../contexts/absence/leave-type";

export const EXPORT_YEAR = 2026;
export const EXPORT_MONTH = 9;
/** Mid-day UTC instant in the month after the export month (never UTC midnight). */
export const FAKE_NOW = new Date("2026-10-15T10:00:00.000Z");

export type FixturePerson = { id: string; employeeNumber: string; lastName: string };

export type MonthlyExportFixture = {
  seed: Awaited<ReturnType<typeof seedTestData>>;
  tenantId: string;
  salonId: string;
  adminToken: string;
  adminUserId: string;
  people: Record<"p1" | "p2" | "p3" | "p4" | "p5" | "p6" | "p7" | "p8" | "p9", FixturePerson>;
  /** Stored carryOver of the two closed-month persons (p1 legacy convention, p2 converted). */
  closedCarryOver: { p1: number; p2: number };
};

type ScheduleKind = "FIXED" | "MONTHLY_NULL" | "SHIFT_BASED";

async function createPerson(
  app: FastifyInstance,
  opts: {
    tenantId: string;
    salonId: string;
    key: string;
    hireDate: string;
    exitDate?: string;
    schedule: ScheduleKind;
    classification?: "AZUBI";
  },
): Promise<FixturePerson> {
  const passwordHash = await bcrypt.hash("test1234", 4);
  const unique = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const user = await app.prisma.user.create({
    data: {
      email: `${opts.key}-${unique}@example.invalid`,
      passwordHash,
      role: "EMPLOYEE",
      isActive: true,
    },
  });
  // Deterministic: the DATEV file carries number and name.
  const employeeNumber = numericEmployeeNumber();
  const lastName = `P617${opts.key}`;
  const employee = await app.prisma.employee.create({
    data: {
      tenantId: opts.tenantId,
      userId: user.id,
      employeeNumber,
      firstName: `Vorname${opts.key}`,
      lastName,
      hireDate: new Date(`${opts.hireDate}T00:00:00Z`),
      ...(opts.exitDate ? { exitDate: new Date(`${opts.exitDate}T00:00:00Z`) } : {}),
      ...(opts.classification ? { classification: opts.classification } : {}),
      breakOver6hOverride: 0,
      breakOver9hOverride: 0,
    },
  });
  await grantSystemRole(app.prisma, {
    tenantId: opts.tenantId,
    userId: user.id,
    role: "EMPLOYEE",
  });
  const validFrom = new Date(`${opts.hireDate}T00:00:00Z`);
  if (opts.schedule === "FIXED") {
    await app.prisma.workSchedule.create({
      data: {
        employeeId: employee.id,
        type: "FIXED_SCHEDULE",
        weeklyHours: 40,
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
        workDays: [1, 2, 3, 4, 5],
        validFrom,
      },
    });
  } else if (opts.schedule === "MONTHLY_NULL") {
    await app.prisma.workSchedule.create({
      data: {
        employeeId: employee.id,
        type: "MONTHLY_HOURS",
        weeklyHours: 0,
        monthlyHours: null,
        workDays: [1, 2, 3, 4, 5],
        validFrom,
      },
    });
  } else {
    await app.prisma.workSchedule.create({
      data: {
        employeeId: employee.id,
        type: "SHIFT_BASED",
        weeklyHours: 40,
        contractWorkDaysPerWeek: 5,
        usualWorkDays: [1, 2, 3, 4, 5],
        validFrom,
      },
    });
  }
  await app.prisma.employeeSalonAssignment.create({
    data: {
      tenantId: opts.tenantId,
      employeeId: employee.id,
      salonId: opts.salonId,
      kind: "HOME",
      validFrom,
      validUntil: null,
      weekdays: [],
    },
  });
  await app.prisma.overtimeAccount.create({ data: { employeeId: employee.id, balanceHours: 0 } });
  return { id: employee.id, employeeNumber, lastName };
}

async function entry(
  app: FastifyInstance,
  employeeId: string,
  dateStr: string,
  netMinutes = 450,
): Promise<void> {
  const start = new Date(`${dateStr}T07:00:00Z`);
  await app.prisma.timeEntry.create({
    data: {
      employeeId,
      date: new Date(`${dateStr}T00:00:00Z`),
      startTime: start,
      endTime: new Date(start.getTime() + (netMinutes + 30) * 60_000),
      breakMinutes: 30,
      type: "WORK",
      salonId: await salonIdForEmployee(app.prisma, employeeId),
    },
  });
}

async function leave(
  app: FastifyInstance,
  employeeId: string,
  leaveTypeId: string,
  start: string,
  end: string,
  days: number,
  extra: {
    attest?: boolean;
    deletedAt?: Date;
    overtimeCompMinutes?: number;
  } = {},
): Promise<string> {
  const row = await app.prisma.leaveRequest.create({
    data: {
      employeeId,
      leaveTypeId,
      startDate: new Date(`${start}T00:00:00Z`),
      endDate: new Date(`${end}T00:00:00Z`),
      days,
      status: "APPROVED",
      ...(extra.attest
        ? {
            attestPresent: true,
            attestValidFrom: new Date(`${start}T00:00:00Z`),
            attestValidTo: new Date(`${end}T00:00:00Z`),
          }
        : {}),
      ...(extra.deletedAt ? { deletedAt: extra.deletedAt } : {}),
      ...(extra.overtimeCompMinutes ? { overtimeCompMinutes: extra.overtimeCompMinutes } : {}),
    },
  });
  return row.id;
}

async function confirmedCredit(
  app: FastifyInstance,
  employeeId: string,
  sickRequestId: string,
  vacationRequestId: string,
  start: string,
  end: string,
  days: number,
): Promise<void> {
  await app.prisma.section9Credit.create({
    data: {
      employeeId,
      sickRequestId,
      vacationRequestId,
      overlapStart: new Date(`${start}T00:00:00Z`),
      overlapEnd: new Date(`${end}T00:00:00Z`),
      status: "CONFIRMED",
      creditedStart: new Date(`${start}T00:00:00Z`),
      creditedEnd: new Date(`${end}T00:00:00Z`),
      creditedDays: days,
      attestSource: "EAU",
      attestValidFrom: new Date(`${start}T00:00:00Z`),
      attestValidTo: new Date(`${end}T00:00:00Z`),
      reason: "Fixture 617",
      reviewedAt: new Date(),
    },
  });
}

/** Seeds the nine-person fixture. The caller has already faked `Date` to `FAKE_NOW`. */
export async function seedMonthlyExportFixture(
  app: FastifyInstance,
  suffix = "mx617",
): Promise<MonthlyExportFixture> {
  const seed = await seedTestData(app, suffix);
  const tenantId = seed.tenant.id;
  const salonId = seed.salonId;
  await configureDatevKanzlei(app, tenantId);

  const typeIds: Record<string, string> = { VACATION: seed.vacationType.id };
  for (const code of [
    "SICK",
    "SICK_CHILD",
    "OVERTIME_COMP",
    "SPECIAL",
    "EDUCATION",
    "UNPAID",
    "MATERNITY",
    "PARENTAL",
  ] as RequestableCode[]) {
    const created = await app.prisma.leaveType.create({
      data: { tenantId, ...leaveTypeFields(code), color: "#888888" },
    });
    typeIds[code] = created.id;
  }

  const mk = (
    key: string,
    schedule: ScheduleKind,
    extra: { exitDate?: string; classification?: "AZUBI" } = {},
  ) => createPerson(app, { tenantId, salonId, key, hireDate: "2025-06-01", schedule, ...extra });

  const p1 = await mk("1", "FIXED");
  const p2 = await mk("2", "FIXED");
  const p3 = await mk("3", "FIXED");
  const p4 = await mk("4", "SHIFT_BASED");
  const p5 = await mk("5", "MONTHLY_NULL");
  const p6 = await mk("6", "FIXED");
  const p7 = await mk("7", "FIXED", { exitDate: "2026-09-15" });
  const p8 = await mk("8", "FIXED", { classification: "AZUBI" });
  const p9 = await mk("9", "FIXED");

  // P1 / P2: closed September, LEGACY and CONVERTED period convention; carryOver differs from the
  // balance so the Gesamtsaldo is distinguishable from the month's Saldo.
  const closedBy = seed.adminUser.id;
  const p1Figures = {
    workedMinutes: 10530,
    expectedMinutes: 10560,
    balanceMinutes: -30,
    carryOver: 777,
  };
  const p2Figures = {
    workedMinutes: 10200,
    expectedMinutes: 10080,
    balanceMinutes: 120,
    carryOver: 90,
  };
  for (const day of ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"]) {
    await entry(app, p1.id, day);
  }
  await entry(app, p2.id, "2026-09-01");
  await entry(app, p2.id, "2026-09-02");
  await app.prisma.saldoSnapshot.create({
    data: {
      employeeId: p1.id,
      periodType: "MONTHLY",
      ...(() => {
        const b = legacySaldoSnapshotPeriodBounds(EXPORT_YEAR, EXPORT_MONTH);
        return { periodStart: b.start, periodEnd: b.end };
      })(),
      ...p1Figures,
      closedAt: new Date(),
      closedBy,
    },
  });
  await app.prisma.saldoSnapshot.create({
    data: {
      employeeId: p2.id,
      periodType: "MONTHLY",
      ...(() => {
        const b = saldoSnapshotPeriodBounds(new Date("2026-09-01T00:00:00Z"));
        return { periodStart: b.start, periodEnd: b.end };
      })(),
      ...p2Figures,
      closedAt: new Date(),
      closedBy,
    },
  });

  // P3: open month with every leave kind.
  for (const day of [
    "2026-09-01",
    "2026-09-02",
    "2026-09-03",
    "2026-09-04",
    "2026-09-09",
    "2026-09-10",
    "2026-09-11",
  ]) {
    await entry(app, p3.id, day);
  }
  await leave(app, p3.id, typeIds.VACATION, "2026-09-07", "2026-09-08", 2);
  await leave(app, p3.id, typeIds.SICK, "2026-09-15", "2026-09-16", 2, { attest: true });
  await leave(app, p3.id, typeIds.SICK_CHILD, "2026-09-17", "2026-09-17", 1);
  await leave(app, p3.id, typeIds.OVERTIME_COMP, "2026-09-21", "2026-09-21", 1, {
    overtimeCompMinutes: 480,
  });
  await leave(app, p3.id, typeIds.SPECIAL, "2026-09-22", "2026-09-22", 1);
  await leave(app, p3.id, typeIds.EDUCATION, "2026-09-28", "2026-09-28", 1);
  await leave(app, p3.id, typeIds.UNPAID, "2026-09-29", "2026-09-29", 1);

  // P4: SHIFT_BASED, open month.
  for (const day of ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"]) {
    await entry(app, p4.id, day);
  }
  await leave(app, p4.id, typeIds.VACATION, "2026-09-14", "2026-09-18", 5);

  // P5: MONTHLY_HOURS with monthlyHours null (unlabelled); maternity / parental days.
  for (const day of ["2026-09-01", "2026-09-02", "2026-09-03"]) {
    await entry(app, p5.id, day);
  }
  await leave(app, p5.id, typeIds.MATERNITY, "2026-09-07", "2026-09-08", 2);
  await leave(app, p5.id, typeIds.PARENTAL, "2026-09-09", "2026-09-09", 1);

  // P6: a confirmed § 9 credit inside an approved vacation.
  for (const day of ["2026-09-01", "2026-09-02", "2026-09-03"]) {
    await entry(app, p6.id, day);
  }
  const p6Vacation = await leave(app, p6.id, typeIds.VACATION, "2026-09-21", "2026-09-25", 5);
  const p6Sick = await leave(app, p6.id, typeIds.SICK, "2026-09-23", "2026-09-24", 2, {
    attest: true,
  });
  await confirmedCredit(app, p6.id, p6Sick, p6Vacation, "2026-09-23", "2026-09-24", 2);

  // P7: exits on the 15th; two entries lie after the exit day (DATEV sums them, the account clamps).
  for (const day of [
    "2026-09-01",
    "2026-09-02",
    "2026-09-03",
    "2026-09-04",
    "2026-09-07",
    "2026-09-08",
    "2026-09-17",
    "2026-09-18",
  ]) {
    await entry(app, p7.id, day);
  }

  // P8: Azubi with a Berufsschule day (imposed absence).
  for (const day of ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-07"]) {
    await entry(app, p8.id, day);
  }
  await app.prisma.absence.create({
    data: {
      employeeId: p8.id,
      type: "VOCATIONAL_SCHOOL",
      source: "PATTERN",
      startDate: new Date("2026-09-09T00:00:00Z"),
      endDate: new Date("2026-09-09T00:00:00Z"),
      days: 1,
      createdBy: p8.id,
    },
  });

  // P9: orphan § 9 days - the credit is CONFIRMED but its sickness request is soft-deleted.
  for (const day of ["2026-09-01", "2026-09-02"]) {
    await entry(app, p9.id, day);
  }
  const p9Vacation = await leave(app, p9.id, typeIds.VACATION, "2026-09-14", "2026-09-15", 2);
  const p9Sick = await leave(app, p9.id, typeIds.SICK, "2026-09-14", "2026-09-15", 2, {
    attest: true,
    deletedAt: new Date("2026-09-20T10:00:00Z"),
  });
  await confirmedCredit(app, p9.id, p9Sick, p9Vacation, "2026-09-14", "2026-09-15", 2);

  return {
    seed,
    tenantId,
    salonId,
    adminToken: seed.adminToken,
    adminUserId: seed.adminUser.id,
    people: { p1, p2, p3, p4, p5, p6, p7, p8, p9 },
    closedCarryOver: { p1: p1Figures.carryOver, p2: p2Figures.carryOver },
  };
}

/**
 * Replaces the random employee numbers of the two seed employees (`A-...`, `E-...`) by fixed tokens,
 * so a DATEV file of the fixture is comparable between two runs.
 */
export function normalizeDatevText(text: string, fixture: MonthlyExportFixture): string {
  return text
    .split(fixture.seed.adminEmployee.employeeNumber)
    .join("SEED-ADMIN")
    .split(fixture.seed.employee.employeeNumber)
    .join("SEED-EMP");
}
