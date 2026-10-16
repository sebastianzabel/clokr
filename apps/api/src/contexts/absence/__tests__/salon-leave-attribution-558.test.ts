/**
 * Issue #558 (D-02/D-08) — "an absence follows the Stammsalon per day" lives in ONE function of the
 * Abwesenheiten context, `filterLeaveRowsToHomeSalon()`. The dashboard's `team-upcoming-leave` (#84)
 * and the leave reads of the team pages (`/leave/requests`, `/calendar`, `/ical/team`, `/section9`)
 * all call it; there is no second attribution rule.
 *
 * The pure predicate is tested without a database; the async function runs against the test
 * database with plain row objects (it needs no LeaveRequest rows). The parity case compares every
 * decision with `homeSalonAt` called per day — the single-day Stammsalon rule the batched map must
 * equal.
 *
 * Mutation proof (Phase 558, 2026-10-16) — recorded here, not re-run by CI; the file was restored
 * with cp afterwards:
 * M1 the window clip removed (`from`/`to` ignore `window`) → red: "a row clipped by the window to
 *    days homed elsewhere is dropped" and "a row whose clipped range is empty is dropped".
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  createTestSalon,
} from "../../../__tests__/setup";
import { filterLeaveRowsToHomeSalon, isHomedInSalonOnAnyDay } from "../index";
import { homeSalonAt } from "../../platform/facade/salon-assignments";

function day(s: string): Date {
  return new Date(`${s}T00:00:00Z`);
}

describe("isHomedInSalonOnAnyDay (pure)", () => {
  const map = new Map<string, string | null>([
    ["2026-06-01", "A"],
    ["2026-06-02", "A"],
    ["2026-06-03", "B"],
    ["2026-06-04", null],
  ]);

  it("is true when some day inside the range maps to the salon", () => {
    expect(isHomedInSalonOnAnyDay(map, "A", "2026-06-01", "2026-06-04")).toBe(true);
    expect(isHomedInSalonOnAnyDay(map, "B", "2026-06-02", "2026-06-03")).toBe(true);
  });

  it("never counts days outside the range", () => {
    expect(isHomedInSalonOnAnyDay(map, "B", "2026-06-01", "2026-06-02")).toBe(false);
    expect(isHomedInSalonOnAnyDay(map, "A", "2026-06-03", "2026-06-04")).toBe(false);
  });

  it("is false for an undefined map and for a day homed nowhere", () => {
    expect(isHomedInSalonOnAnyDay(undefined, "A", "2026-06-01", "2026-06-04")).toBe(false);
    expect(isHomedInSalonOnAnyDay(map, "A", "2026-06-04", "2026-06-04")).toBe(false);
  });
});

describe("filterLeaveRowsToHomeSalon (Issue #558)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: { id: string };
  let salonB: { id: string };
  const emp: Record<string, string> = {};

  async function createEmployee(label: string) {
    const s = `${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const user = await app.prisma.user.create({
      data: {
        email: `${s}@example.invalid`,
        passwordHash: await bcrypt.hash("test1234", 4),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: s.toUpperCase().slice(0, 20),
        firstName: label,
        lastName: "Attr558",
        hireDate: new Date("2024-01-01"),
      },
    });
    return employee.id;
  }

  function home(employeeId: string, salonId: string, validFrom: string, validUntil: string | null) {
    return app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: data.tenant.id,
        employeeId,
        salonId,
        kind: "HOME",
        validFrom: day(validFrom),
        validUntil: validUntil ? day(validUntil) : null,
      },
    });
  }

  function filter<T extends { employeeId: string; startDate: Date; endDate: Date }>(
    rows: T[],
    salonId: string,
    window: { fromDay?: string; toDay?: string } = {},
  ) {
    return filterLeaveRowsToHomeSalon(app.prisma, data.tenant.id, rows, salonId, window);
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "attr558");
    salonA = await createTestSalon(app.prisma, data.tenant.id, { name: "Salon Nord" });
    salonB = await createTestSalon(app.prisma, data.tenant.id, { name: "Salon Ost" });

    // pA: always A. pX: A until 2026-06-14, B from 2026-06-15. pN: no HOME row at all.
    // pY: A until 2025-12-31, B from 2026-01-01 (year boundary).
    emp.pA = await createEmployee("pA");
    emp.pX = await createEmployee("pX");
    emp.pN = await createEmployee("pN");
    emp.pY = await createEmployee("pY");
    await home(emp.pA, salonA.id, "2024-01-01", null);
    await home(emp.pX, salonA.id, "2024-01-01", "2026-06-14");
    await home(emp.pX, salonB.id, "2026-06-15", null);
    await home(emp.pY, salonA.id, "2024-01-01", "2025-12-31");
    await home(emp.pY, salonB.id, "2026-01-01", null);
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("salon-leave-attribution-558 cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("returns [] for an empty input", async () => {
    expect(await filter([], salonA.id)).toEqual([]);
  });

  it("a row spanning a Stammsalon change is kept for A and for B", async () => {
    const rows = [
      { employeeId: emp.pX, startDate: day("2026-06-10"), endDate: day("2026-06-20"), tag: "x" },
    ];
    expect((await filter(rows, salonA.id)).map((r) => r.tag)).toEqual(["x"]);
    expect((await filter(rows, salonB.id)).map((r) => r.tag)).toEqual(["x"]);
  });

  it("a row clipped by the window to days homed elsewhere is dropped", async () => {
    const rows = [
      { employeeId: emp.pX, startDate: day("2026-06-10"), endDate: day("2026-06-20"), tag: "x" },
    ];
    // Window starts on the first B day: A is no longer attributable, B is.
    expect(await filter(rows, salonA.id, { fromDay: "2026-06-15" })).toEqual([]);
    expect(await filter(rows, salonB.id, { fromDay: "2026-06-15" })).toHaveLength(1);
    // Window ends before the change: only A.
    expect(await filter(rows, salonB.id, { toDay: "2026-06-14" })).toEqual([]);
    expect(await filter(rows, salonA.id, { toDay: "2026-06-14" })).toHaveLength(1);
  });

  it("a row whose clipped range is empty is dropped", async () => {
    const rows = [
      { employeeId: emp.pA, startDate: day("2026-06-01"), endDate: day("2026-06-03"), tag: "a" },
    ];
    expect(await filter(rows, salonA.id, { fromDay: "2026-06-04" })).toEqual([]);
    expect(await filter(rows, salonA.id, { toDay: "2026-05-31" })).toEqual([]);
    expect(await filter(rows, salonA.id)).toHaveLength(1);
  });

  it("an employee without any HOME row is dropped", async () => {
    const rows = [{ employeeId: emp.pN, startDate: day("2026-06-01"), endDate: day("2026-06-03") }];
    expect(await filter(rows, salonA.id)).toEqual([]);
    expect(await filter(rows, salonB.id)).toEqual([]);
  });

  it("preserves the input order of the kept rows", async () => {
    const rows = [
      { employeeId: emp.pA, startDate: day("2026-06-20"), endDate: day("2026-06-21"), tag: 1 },
      { employeeId: emp.pN, startDate: day("2026-06-01"), endDate: day("2026-06-02"), tag: 2 },
      { employeeId: emp.pA, startDate: day("2026-06-01"), endDate: day("2026-06-02"), tag: 3 },
      { employeeId: emp.pX, startDate: day("2026-06-05"), endDate: day("2026-06-06"), tag: 4 },
    ];
    expect((await filter(rows, salonA.id)).map((r) => r.tag)).toEqual([1, 3, 4]);
  });

  it("evaluates rows of two calendar years correctly (one map per year bucket)", async () => {
    const rows = [
      { employeeId: emp.pY, startDate: day("2025-12-20"), endDate: day("2025-12-22"), tag: "y25" },
      { employeeId: emp.pY, startDate: day("2026-01-05"), endDate: day("2026-01-06"), tag: "y26" },
    ];
    expect((await filter(rows, salonA.id)).map((r) => r.tag)).toEqual(["y25"]);
    expect((await filter(rows, salonB.id)).map((r) => r.tag)).toEqual(["y26"]);
  });

  it("parity: every decision equals homeSalonAt applied per day of the clipped range", async () => {
    const window = { fromDay: "2026-06-12", toDay: "2026-06-18" };
    const rows = [
      { employeeId: emp.pA, startDate: day("2026-06-01"), endDate: day("2026-06-30"), tag: "pA" },
      { employeeId: emp.pX, startDate: day("2026-06-10"), endDate: day("2026-06-14"), tag: "pX1" },
      { employeeId: emp.pX, startDate: day("2026-06-14"), endDate: day("2026-06-16"), tag: "pX2" },
      { employeeId: emp.pX, startDate: day("2026-06-16"), endDate: day("2026-06-25"), tag: "pX3" },
      { employeeId: emp.pN, startDate: day("2026-06-12"), endDate: day("2026-06-18"), tag: "pN" },
      { employeeId: emp.pY, startDate: day("2026-06-12"), endDate: day("2026-06-12"), tag: "pY" },
    ];
    for (const salon of [salonA, salonB]) {
      const kept = new Set((await filter(rows, salon.id, window)).map((r) => r.tag));
      for (const row of rows) {
        const startDay = row.startDate.toISOString().slice(0, 10);
        const endDay = row.endDate.toISOString().slice(0, 10);
        const from = startDay > window.fromDay ? startDay : window.fromDay;
        const to = endDay < window.toDay ? endDay : window.toDay;
        let expected = false;
        for (
          let d = from;
          d <= to;
          d = new Date(day(d).getTime() + 86_400_000).toISOString().slice(0, 10)
        ) {
          const h = await homeSalonAt(app.prisma, data.tenant.id, row.employeeId, day(d));
          if (h?.salonId === salon.id) expected = true;
        }
        expect(kept.has(row.tag), `${row.tag} for ${salon.id}`).toBe(expected);
      }
    }
  });
});
