/**
 * Issue #80 (D-09e, D-10, D-11, D-13, D-18) — the next-day cron that tells managers about an
 * unacknowledged cross-salon § 4 ArbZG violation of a previous day, once per recipient, employee
 * and day.
 *
 * A multi-entry day cannot exist in the database while the partial unique index
 * `TimeEntry_employeeId_date_unique_not_deleted` holds, so the closed-WORK-entry read of the
 * facade (`getWorkedEntriesInRange`, T2) is mocked for the constructed days only: for the test
 * employee and day the constructed two-salon rows replace the real row; every other employee and
 * day delegates to the real implementation. Everything else is real: tenant, salons, employees,
 * role assignments, DayBreakAck rows, notifications.
 *
 * Fixture names are neutral labels, never person names.
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import bcrypt from "bcryptjs";
import crypto, { randomUUID } from "node:crypto";
import { fromZonedTime } from "date-fns-tz";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, cleanupTestData, createTestSalon } from "./setup";
import { daysAgoStrInTz } from "./test-dates";
import { normalizeRolePermissions, roleNameKey } from "../contexts/platform";

vi.mock("../contexts/time-tracking/facade/time-entries", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../contexts/time-tracking/facade/time-entries")>();
  return { ...original, getWorkedEntriesInRange: vi.fn(original.getWorkedEntriesInRange) };
});

import { getWorkedEntriesInRange } from "../contexts/time-tracking/facade/time-entries";

const TZ = "Europe/Berlin";
const PASSWORD = "test1234";
const NOTIFICATION_TYPE = "BREAK_CROSS_SALON_VIOLATION";
const MANAGER_PERMISSIONS = ["time-entry:update:ZUGEWIESEN", "time-entry:read:ZUGEWIESEN"];

type T2Row = Awaited<ReturnType<typeof getWorkedEntriesInRange>>[number];

function dateOf(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

/** A tenant-local wall-clock time on `day` as the UTC instant the database stores. */
function localInstant(day: string, hhmm: string): Date {
  return fromZonedTime(`${day}T${hhmm}:00`, TZ);
}

describe("Issue #80 — next-day cross-salon § 4 notification (Feature 10)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let salonA: string;
  let salonB: string;
  let salonC = "";
  let adminUserId: string;
  let seq = 0;
  const salonName: Record<string, string> = {};
  /** employeeId -> constructed T2 rows (replace the employee's real rows on those days). */
  const constructed = new Map<string, T2Row[]>();

  const yesterday = () => daysAgoStrInTz(new Date(), 1, TZ);

  function row(
    employeeId: string,
    day: string,
    salonId: string,
    start: string,
    end: string,
    breakMinutes = 0,
  ): T2Row {
    return {
      id: randomUUID(),
      employeeId,
      date: dateOf(day),
      startTime: localInstant(day, start),
      endTime: localInstant(day, end),
      breakMinutes,
      breakStatus: "CONFIRMED",
      isLocked: false,
      salonId,
    } as T2Row;
  }

  function addRows(employeeId: string, rows: T2Row[]): T2Row[] {
    constructed.set(employeeId, [...(constructed.get(employeeId) ?? []), ...rows]);
    return rows;
  }

  /** 8 h net across two salons with a 30 min travel gap: a § 4 shortfall (08:00-12:00 A, 12:30-16:30 B). */
  function twoSalonDay(employeeId: string, day: string): T2Row[] {
    return addRows(employeeId, [
      row(employeeId, day, salonA, "08:00", "12:00"),
      row(employeeId, day, salonB, "12:30", "16:30"),
    ]);
  }

  async function createUser(label: string, role: "EMPLOYEE" | "ADMIN" | "MANAGER" = "EMPLOYEE") {
    const s = `${label}-${++seq}-${Date.now().toString(36)}`;
    return app.prisma.user.create({
      data: {
        email: `csbn-${s}@test.de`,
        passwordHash: await bcrypt.hash(PASSWORD, 4),
        role,
        isActive: true,
      },
    });
  }

  async function createEmployee(
    label: string,
    opts: { role?: "EMPLOYEE" | "ADMIN"; exempt?: boolean } = {},
  ) {
    const user = await createUser(label, opts.role ?? "EMPLOYEE");
    const employee = await app.prisma.employee.create({
      data: {
        tenantId,
        userId: user.id,
        employeeNumber: `CSBN-${label}-${seq}-${Date.now().toString(36)}`.slice(0, 30),
        firstName: "Fixture",
        lastName: label,
        hireDate: new Date("2024-01-01T00:00:00Z"),
        isTimeTrackingExempt: opts.exempt ?? false,
      },
    });
    return { user, employee };
  }

  /** A manager holding the update/read ZUGEWIESEN permissions over exactly `salonIds`. */
  async function createScopedManager(label: string, salonIds: string[]) {
    const { user, employee } = await createEmployee(label);
    await assignScopedRole(user.id, salonIds);
    return { user, employee };
  }

  async function assignScopedRole(userId: string, salonIds: string[]) {
    const name = `CSBN ${crypto.randomBytes(3).toString("hex")}`;
    const role = await app.prisma.accessRole.create({
      data: {
        tenantId,
        name,
        nameKey: roleNameKey(name),
        permissions: normalizeRolePermissions(MANAGER_PERMISSIONS),
      },
    });
    await app.prisma.roleAssignment.create({
      data: {
        tenantId,
        userId,
        accessRoleId: role.id,
        scopeType: "SALONS",
        salonIds,
        employeeIds: [],
      },
    });
  }

  function notificationsFor(userId: string, employeeId: string, day: string) {
    return app.prisma.notification.findMany({
      where: {
        userId,
        type: NOTIFICATION_TYPE,
        relatedType: "EmployeeDay",
        relatedId: `${employeeId}:${day}`,
      },
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    const prisma = app.prisma;
    const s = `csbn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
    const tenant = await prisma.tenant.create({
      data: { name: `CrossSalonNotify ${s}`, slug: s, federalState: "NIEDERSACHSEN" },
    });
    tenantId = tenant.id;
    salonName.A = "Salon Alpha";
    salonName.B = "Salon Beta";
    salonName.C = "Salon Gamma";
    salonA = (await createTestSalon(prisma, tenantId, { name: salonName.A })).id;
    salonB = (await createTestSalon(prisma, tenantId, { name: salonName.B })).id;
    salonC = (await createTestSalon(prisma, tenantId, { name: salonName.C })).id;
    await prisma.tenantConfig.create({
      data: { tenantId, defaultVacationDays: 30, timezone: TZ },
    });
    // The tenant-wide holder: an ADMIN with no stored assignment resolves through the system role.
    const admin = await createEmployee("admin", { role: "ADMIN", exempt: true });
    adminUserId = admin.user.id;

    const actual = await vi.importActual<
      typeof import("../contexts/time-tracking/facade/time-entries")
    >("../contexts/time-tracking/facade/time-entries");
    vi.mocked(getWorkedEntriesInRange).mockImplementation(async (db, scope, from, to) => {
      const real = await actual.getWorkedEntriesInRange(db, scope, from, to);
      const inScope = (id: string) =>
        scope.kind === "employee"
          ? scope.employeeId === id
          : scope.kind === "employees"
            ? scope.employeeIds.includes(id)
            : true;
      const extra: T2Row[] = [];
      for (const [employeeId, rows] of constructed) {
        if (!inScope(employeeId)) continue;
        for (const r of rows) if (r.date >= from && r.date <= to) extra.push(r);
      }
      if (extra.length === 0) return real;
      const replaced = real.filter(
        (r) =>
          !extra.some(
            (c) => c.employeeId === r.employeeId && c.date.getTime() === r.date.getTime(),
          ),
      );
      return [...replaced, ...extra];
    });
  }, 120_000);

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("cross-salon-break-notifications-80 cleanup:", err);
    }
    await closeTestApp();
  });

  beforeEach(() => {
    constructed.clear();
  });

  describe("tracer: tenant-wide manager, full detail, once (D-09e, D-10, D-13)", () => {
    it("notifies the tenant-wide manager about yesterday's violation with salons, times and a deep link", async () => {
      const x = await createEmployee("tracer-x");
      const day = yesterday();
      twoSalonDay(x.employee.id, day);

      await app.tryCrossSalonBreakCheck();

      const rows = await notificationsFor(adminUserId, x.employee.id, day);
      expect(rows).toHaveLength(1);
      const n = rows[0];
      expect(n.type).toBe(NOTIFICATION_TYPE);
      expect(n.relatedType).toBe("EmployeeDay");
      expect(n.relatedId).toBe(`${x.employee.id}:${day}`);
      expect(n.link).toBe(`/team/time-entries?employeeId=${x.employee.id}&date=${day}`);
      expect(n.message.startsWith("Fixture tracer-x:")).toBe(true);
      expect(n.message).toContain("salonübergreifend");
      expect(n.message).toContain(salonName.A);
      expect(n.message).toContain(salonName.B);
      expect(n.message).toContain("08:00");
      expect(n.message).toContain("16:30");
    });

    it("never notifies the employee about their own day", async () => {
      const x = await createEmployee("tracer-self");
      const day = yesterday();
      twoSalonDay(x.employee.id, day);

      await app.tryCrossSalonBreakCheck();

      const own = await app.prisma.notification.count({
        where: { userId: x.user.id, type: NOTIFICATION_TYPE },
      });
      expect(own).toBe(0);
    });

    it("sends once: a second run creates no further row", async () => {
      const x = await createEmployee("tracer-twice");
      const day = yesterday();
      twoSalonDay(x.employee.id, day);

      await app.tryCrossSalonBreakCheck();
      await app.tryCrossSalonBreakCheck();

      expect(await notificationsFor(adminUserId, x.employee.id, day)).toHaveLength(1);
    });
  });

  // Task 2 cases are appended below.
  void createScopedManager;
  void salonC;
});
