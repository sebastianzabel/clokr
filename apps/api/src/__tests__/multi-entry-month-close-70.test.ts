/**
 * Issue #70 (Phase 70b-05, AC-70-4, D-14) — the month-close gate over a REAL two-salon day.
 *
 * `cross-salon-month-close-80.test.ts` proves the gate with constructed rows (it mocks the entry
 * read, because a multi-entry day could not be stored then). Since #70 the day exists in the
 * database, so this file proves the same gate end to end with nothing mocked: real rows written
 * through Prisma, the real `POST /overtime/close-month`, the real `POST /day-breaks` and
 * `POST /day-breaks/acks`, the real status listing.
 *
 * The day: 07:00-11:00 in salon A and 11:30-15:00 in salon B (tenant time), i.e. 7.5 h of working
 * time with a 30 min gap between two DIFFERENT salons, which is never a break (travel is working
 * time, #92) — a § 4 ArbZG shortfall. Under `blockMonthCloseOnUnconfirmedBreak` that day blocks
 * the close, is listed exactly once, and is cleared by a DayBreak recorded in the gap or by an
 * acknowledgement. The same times in ONE salon are a 30 min break (a same-salon gap of any length
 * counts, #523): no finding, nothing blocks.
 *
 * Each case uses its own employee because a successful close writes a snapshot.
 * No person names in fixtures.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { fromZonedTime } from "date-fns-tz";
import {
  getTestApp,
  closeTestApp,
  cleanupTestData,
  createTestSalon,
  grantSystemRole,
} from "./setup";
import { TEST_TZ } from "./test-dates";

const YEAR = 2026;
const MONTH = 3;
const SPLIT_DAY = "2026-03-10"; // Tuesday
const PASSWORD = "test1234";

function dateOf(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

/** Tenant-local instant for `HH:MM` on `day`. */
function at(day: string, hhmm: string): Date {
  return fromZonedTime(`${day}T${hhmm}:00`, TEST_TZ);
}

/** Mon-Fri days of March 2026 (no public holiday in Niedersachsen). */
function marchWorkdays(): string[] {
  const out: string[] = [];
  const cur = new Date("2026-03-01T00:00:00Z");
  while (cur.getUTCMonth() === 2) {
    const dow = cur.getUTCDay();
    if (dow >= 1 && dow <= 5) out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

describe("Issue #70 — the month-close gate on a real two-salon day (AC-70-4)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let adminToken: string;
  let salonA: string;
  let salonB: string;
  let seq = 0;

  /**
   * A complete month of single-salon entries (07:00-15:30, 30 min recorded break, no gap), except
   * `SPLIT_DAY`, which holds the two entries of `split`.
   */
  async function createEmployee(
    label: string,
    split: { aFrom: string; aTo: string; bFrom: string; bTo: string; bSalon: "A" | "B" },
  ): Promise<string> {
    const prisma = app.prisma;
    const s = `${label}-${++seq}-${Date.now().toString(36)}`;
    const user = await prisma.user.create({
      data: {
        email: `mec70-${s}@test.de`,
        passwordHash: await bcrypt.hash(PASSWORD, 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const emp = await prisma.employee.create({
      data: {
        tenantId,
        userId: user.id,
        employeeNumber: `MEC70-${s}`.slice(0, 30),
        firstName: "Salon",
        lastName: label,
        hireDate: new Date("2026-03-01T00:00:00Z"),
      },
    });
    await grantSystemRole(prisma, { tenantId, userId: user.id, role: "EMPLOYEE" });
    await prisma.workSchedule.create({
      data: {
        employeeId: emp.id,
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
        validFrom: new Date("2026-03-01T00:00:00Z"),
      },
    });
    await prisma.overtimeAccount.create({ data: { employeeId: emp.id, balanceHours: 0 } });

    const days = marchWorkdays();
    expect(days.length, "the month walk is not vacuous").toBe(22);
    for (const d of days) {
      if (d === SPLIT_DAY) continue;
      await prisma.timeEntry.create({
        data: {
          employeeId: emp.id,
          date: dateOf(d),
          startTime: at(d, "07:00"),
          endTime: at(d, "15:30"),
          breakMinutes: 30,
          breakStatus: "CONFIRMED",
          type: "WORK",
          salonId: salonA,
        },
      });
    }
    for (const [from, to, salonId] of [
      [split.aFrom, split.aTo, salonA],
      [split.bFrom, split.bTo, split.bSalon === "A" ? salonA : salonB],
    ] as const) {
      await prisma.timeEntry.create({
        data: {
          employeeId: emp.id,
          date: dateOf(SPLIT_DAY),
          startTime: at(SPLIT_DAY, from),
          endTime: at(SPLIT_DAY, to),
          breakMinutes: 0,
          breakStatus: "CONFIRMED",
          type: "WORK",
          salonId,
        },
      });
    }
    return emp.id;
  }

  const twoSalons = {
    aFrom: "07:00",
    aTo: "11:00",
    bFrom: "11:30",
    bTo: "15:00",
    bSalon: "B",
  } as const;
  const oneSalon = { ...twoSalons, bSalon: "A" } as const;

  function closeMonth(employeeId: string) {
    return app.inject({
      method: "POST",
      url: "/api/v1/overtime/close-month",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { employeeId, year: YEAR, month: MONTH },
    });
  }

  type StatusRow = { employeeId: string; status: string; breakFindingDays?: string[] };
  async function statusRow(employeeId: string): Promise<StatusRow> {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/overtime/close-month/status",
      headers: { authorization: `Bearer ${adminToken}` },
      query: { year: String(YEAR), month: String(MONTH) },
    });
    expect(res.statusCode, res.body).toBe(200);
    const row = (JSON.parse(res.body) as { employees: StatusRow[] }).employees.find(
      (e) => e.employeeId === employeeId,
    );
    expect(row, "employee must appear in the status response").toBeDefined();
    return row!;
  }

  const snapshots = (employeeId: string) =>
    app.prisma.saldoSnapshot.count({ where: { employeeId } });

  beforeAll(async () => {
    app = await getTestApp();
    const prisma = app.prisma;
    const s = `mec70-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
    const tenant = await prisma.tenant.create({
      data: { name: `MultiEntryClose ${s}`, slug: s, federalState: "NIEDERSACHSEN" },
    });
    tenantId = tenant.id;
    salonA = (await createTestSalon(prisma, tenantId, { name: "Salon A" })).id;
    salonB = (await createTestSalon(prisma, tenantId, { name: "Salon B" })).id;
    await prisma.tenantConfig.create({
      data: {
        tenantId,
        defaultVacationDays: 30,
        timezone: TEST_TZ,
        enforceBreakConfirmation: false,
        blockMonthCloseOnUnconfirmedBreak: true,
      },
    });
    const adminUser = await prisma.user.create({
      data: {
        email: `admin-${s}@test.de`,
        passwordHash: await bcrypt.hash(PASSWORD, 10),
        role: "ADMIN",
        isActive: true,
      },
    });
    // Exempt from time tracking: never listed in the status and never auto-closed.
    await prisma.employee.create({
      data: {
        tenantId,
        userId: adminUser.id,
        employeeNumber: `ADM-${s}`.slice(0, 30),
        firstName: "Admin",
        lastName: "MultiEntry",
        hireDate: new Date("2024-01-01T00:00:00Z"),
        isTimeTrackingExempt: true,
      },
    });
    await grantSystemRole(prisma, { tenantId, userId: adminUser.id, role: "ADMIN" });
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: adminUser.email, password: PASSWORD },
    });
    adminToken = (JSON.parse(login.body) as { accessToken: string }).accessToken;
  }, 120_000);

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("multi-entry-month-close-70 cleanup:", err);
    }
    await closeTestApp();
  });

  beforeEach(async () => {
    await app.prisma.tenantConfig.update({
      where: { tenantId },
      data: { blockMonthCloseOnUnconfirmedBreak: true, enforceBreakConfirmation: false },
    });
  });

  it("the two entries really are stored: two live rows of one day in two salons", async () => {
    const empId = await createEmployee("stored", twoSalons);
    const rows = await app.prisma.timeEntry.findMany({
      where: { employeeId: empId, date: dateOf(SPLIT_DAY), deletedAt: null },
      orderBy: [{ startTime: "asc" }, { id: "asc" }],
    });
    expect(rows.map((r) => r.salonId)).toEqual([salonA, salonB]);
  });

  it("a two-salon day over 6 h without a recorded break blocks the close and is listed once", async () => {
    const empId = await createEmployee("block", twoSalons);

    const res = await closeMonth(empId);

    expect(res.statusCode, res.body).toBe(409);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body.breakFindingCount).toBe(1);
    expect(body.breakFindingDays, "the day is listed exactly once, not once per entry").toEqual([
      SPLIT_DAY,
    ]);
    expect(body.requiresBreakFindingAck).toBe(true);
    expect(await snapshots(empId), "no snapshot is written when the close is refused").toBe(0);

    expect((await statusRow(empId)).breakFindingDays).toEqual([SPLIT_DAY]);
  });

  it("a DayBreak recorded in the gap through the real route unblocks the close", async () => {
    const empId = await createEmployee("cured", twoSalons);
    expect((await closeMonth(empId)).statusCode).toBe(409);

    const create = await app.inject({
      method: "POST",
      url: "/api/v1/day-breaks",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        employeeId: empId,
        date: SPLIT_DAY,
        startTime: at(SPLIT_DAY, "11:00").toISOString(),
        endTime: at(SPLIT_DAY, "11:30").toISOString(),
      },
    });
    expect(create.statusCode, create.body).toBe(201);

    expect((await statusRow(empId)).breakFindingDays).toEqual([]);
    const res = await closeMonth(empId);
    expect(res.statusCode, res.body).toBe(201);
    expect(await snapshots(empId)).toBe(1);
  });

  it("an acknowledgement through the real route unblocks the close as well", async () => {
    const empId = await createEmployee("acked", twoSalons);
    expect((await closeMonth(empId)).statusCode).toBe(409);

    const ack = await app.inject({
      method: "POST",
      url: "/api/v1/day-breaks/acks",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        employeeId: empId,
        date: SPLIT_DAY,
        reason: "Kundentermin ohne Unterbrechung",
      },
    });
    expect(ack.statusCode, ack.body).toBe(201);

    expect((await statusRow(empId)).breakFindingDays).toEqual([]);
    const res = await closeMonth(empId);
    expect(res.statusCode, res.body).toBe(201);
    expect(await snapshots(empId)).toBe(1);
  });

  it("the same times in ONE salon are a 30 min break: no finding, nothing blocks", async () => {
    const empId = await createEmployee("onesalon", oneSalon);
    expect((await statusRow(empId)).breakFindingDays).toEqual([]);
    const res = await closeMonth(empId);
    expect(res.statusCode, res.body).toBe(201);
    expect(await snapshots(empId)).toBe(1);
  });

  it("control: the day blocks only under the tenant flag (the gate, not the data, decides)", async () => {
    await app.prisma.tenantConfig.update({
      where: { tenantId },
      data: { blockMonthCloseOnUnconfirmedBreak: false },
    });
    const empId = await createEmployee("flagoff", twoSalons);
    // Still listed (the status shows it regardless of the flag), but the close goes through.
    expect((await statusRow(empId)).breakFindingDays).toEqual([SPLIT_DAY]);
    const res = await closeMonth(empId);
    expect(res.statusCode, res.body).toBe(201);
  });
});
