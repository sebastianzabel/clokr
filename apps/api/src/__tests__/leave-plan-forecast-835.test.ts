/**
 * Issue #835 (AC-6; D-835-04/11/25) — the entitlement forecast of the planner: remaining days of
 * the year minus PENDING days minus the person's wishes priced like filed requests, a warning when
 * negative, no entitlement row written by the read, and no forecast outside the reader's reach.
 *
 * Fixture (fake clock 2026-11-03, installed BEFORE the app boots; plan year 2027): tenant one with
 * its default salon S, tenant two with its own salon, one open plan P_S. Persons homed in S, all
 * with a Monday-Friday schedule unless noted: EMP (the seeded employee, system role EMPLOYEE;
 * entitlement 30, 5 used, a PENDING request of 3 days), SB (SHIFT_BASED, 4 contract days per week),
 * NEG (entitlement 2), NR (no entitlement row for 2027), and ENT (holds leave-entitlement:read over
 * the whole tenant). No person names.
 *
 * Mutation proof (Phase 835-06, 2026-11-06) — recorded here, not re-run by CI; each change was
 * reverted with cp afterwards (diff against the backup empty):
 * M1 forecast.ts: `extraSiblings` left out of the pricing call -> red: the SHIFT_BASED case
 *    (1 failed | 6 passed).
 * M2 forecast.ts: `pendingDays` not subtracted -> red: the stored-basis case (1 failed | 6 passed).
 * M3 planner-read.ts: the visibility test removed (forecast for everybody) -> red: the plain
 *    employee case (1 failed | 6 passed).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  seedEntitlementYears,
  tokenWithoutSignIn,
} from "./setup";
import { roleNameKey, normalizeRolePermissions } from "../contexts/platform/access-role";

const ENTITLEMENT_READ = "leave-entitlement:read:ZUGEWIESEN";
const READ = "leave-request:read:ZUGEWIESEN";
const CREATE_OWN = "leave-request:create:EIGENE";
const YEAR = 2027;

type ForecastDto = {
  entitlementBasis: "STORED" | "COMPUTED";
  remainingDays: number;
  pendingDays: number;
  wishDays: number;
  forecastDays: number;
  forecastNegative: boolean;
} | null;
type PlannerDto = { persons: Array<{ employeeId: string; forecast: ForecastDto }> };

describe("Issue #835 - leave plan forecast (priced like filed requests)", () => {
  let app: FastifyInstance;
  let one: Awaited<ReturnType<typeof seedTestData>>;
  let two: Awaited<ReturnType<typeof seedTestData>>;
  let planS: string;
  const tokens: Record<string, string> = {};
  const ids: Record<string, { userId: string; employeeId: string }> = {};

  function authed(token: string) {
    return { authorization: `Bearer ${token}` };
  }
  function day(value: string): Date {
    return new Date(`${value}T00:00:00Z`);
  }

  async function homeIn(employeeId: string) {
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: one.tenant.id,
        employeeId,
        salonId: one.salonId,
        kind: "HOME",
        validFrom: day("2024-01-01"),
        validUntil: null,
        weekdays: [],
      },
    });
  }

  async function schedule(employeeId: string, shiftBased = false) {
    const existing = await app.prisma.workSchedule.findFirst({ where: { employeeId } });
    if (existing) await app.prisma.workSchedule.deleteMany({ where: { employeeId } });
    await app.prisma.workSchedule.create({
      data: shiftBased
        ? {
            employeeId,
            type: "SHIFT_BASED",
            weeklyHours: 38,
            contractWorkDaysPerWeek: 4,
            workDays: [2, 3, 4, 5],
            validFrom: new Date("2024-01-01"),
          }
        : {
            employeeId,
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
  }

  async function person(
    label: string,
    permissions: string[],
    options: { totalDays?: number | null; shiftBased?: boolean } = {},
  ) {
    const email = `${label}-${crypto.randomBytes(3).toString("hex")}@example.invalid`;
    const user = await app.prisma.user.create({
      data: { email, passwordHash: await bcrypt.hash("test1234", 4), isActive: true },
    });
    const row = await app.prisma.employee.create({
      data: {
        tenantId: one.tenant.id,
        userId: user.id,
        employeeNumber: `P${crypto.randomBytes(4).toString("hex")}`,
        firstName: label,
        lastName: "Fore835",
        hireDate: new Date("2024-01-01"),
      },
    });
    if (permissions.length > 0) {
      const name = `Fore835 ${crypto.randomBytes(3).toString("hex")}`;
      const role = await app.prisma.accessRole.create({
        data: {
          tenantId: one.tenant.id,
          name,
          nameKey: roleNameKey(name),
          permissions: normalizeRolePermissions(permissions),
        },
      });
      await app.prisma.roleAssignment.create({
        data: {
          tenantId: one.tenant.id,
          userId: user.id,
          accessRoleId: role.id,
          scopeType: "TENANT",
          salonIds: [],
          employeeIds: [],
        },
      });
    }
    await homeIn(row.id);
    await schedule(row.id, options.shiftBased === true);
    if (options.totalDays !== null) {
      await seedEntitlementYears(app, {
        employeeId: row.id,
        leaveTypeId: one.vacationType.id,
        years: [YEAR],
        totalDays: options.totalDays ?? 30,
      });
    }
    const token = permissions.length > 0 ? await tokenWithoutSignIn(app, email) : "";
    return { userId: user.id, employeeId: row.id, token };
  }

  function wish(label: string, startDate: string, endDate: string, halfDay = false) {
    return app.prisma.leavePlanWish.create({
      data: {
        tenantId: one.tenant.id,
        planId: planS,
        employeeId: ids[label].employeeId,
        startDate: day(startDate),
        endDate: day(endDate),
        halfDay,
        createdByUserId: ids[label].userId,
      },
    });
  }

  async function read(label: string): Promise<PlannerDto> {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/leave/plans/${planS}`,
      headers: authed(tokens[label]),
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as PlannerDto;
  }

  function forecastOf(dto: PlannerDto, label: string): ForecastDto {
    const found = dto.persons.find((p) => p.employeeId === ids[label].employeeId);
    expect(found, `person ${label} in the planner`).toBeDefined();
    return found!.forecast;
  }

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // A PAST date on purpose: audit rows written under a fake clock stay in the worker database, and a future stamp is
    // counted by usual-work-days-backfill-route-481 (it counts every leave audit with createdAt >= now).
    vi.setSystemTime(new Date("2026-11-03T10:00:00.000Z"));
    app = await getTestApp();
    one = await seedTestData(app, "lf835a");
    two = await seedTestData(app, "lf835b");

    // EMP is the seeded employee (system role EMPLOYEE), homed in S.
    await homeIn(one.employee.id);
    await schedule(one.employee.id);
    await seedEntitlementYears(app, {
      employeeId: one.employee.id,
      leaveTypeId: one.vacationType.id,
      years: [YEAR],
      totalDays: 30,
    });
    await app.prisma.leaveEntitlement.updateMany({
      where: { employeeId: one.employee.id, year: YEAR },
      data: { usedDays: 5 },
    });
    ids.emp = { userId: one.empUser.id, employeeId: one.employee.id };
    tokens.emp = one.empToken;

    const roster: Array<[string, string[], { totalDays?: number | null; shiftBased?: boolean }]> = [
      ["ent", [ENTITLEMENT_READ, READ, CREATE_OWN], {}],
      ["sb", [CREATE_OWN], { shiftBased: true }],
      ["neg", [CREATE_OWN], { totalDays: 2 }],
      ["nr", [CREATE_OWN], { totalDays: null }],
    ];
    for (const [label, permissions, options] of roster) {
      const p = await person(label, permissions, options);
      ids[label] = { userId: p.userId, employeeId: p.employeeId };
      tokens[label] = p.token;
    }

    planS = (
      await app.prisma.leavePlan.create({
        data: {
          tenantId: one.tenant.id,
          salonId: one.salonId,
          year: YEAR,
          openedByUserId: ids.ent.userId,
        },
      })
    ).id;

    // EMP: a PENDING request of 3 days (Mon-Wed 5-7 April).
    await app.prisma.leaveRequest.create({
      data: {
        employeeId: ids.emp.employeeId,
        leaveTypeId: one.vacationType.id,
        startDate: day("2027-04-05"),
        endDate: day("2027-04-07"),
        days: 3,
        status: "PENDING",
      },
    });
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await app.prisma.roleAssignment.deleteMany({ where: { tenantId: one.tenant.id } });
      await cleanupTestData(app, one.tenant.id);
      await cleanupTestData(app, two.tenant.id);
    } catch (err) {
      console.error("leave-plan-forecast-835 cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("subtracts the PENDING days and the wishes from the remaining days (stored basis)", async () => {
    // Two Mo-Fr wishes: 5 workdays (1-5 February) and 2 workdays (8-9 February).
    const w1 = await wish("emp", "2027-02-01", "2027-02-05");
    const w2 = await wish("emp", "2027-02-08", "2027-02-09");
    const entitlementBefore = await app.prisma.leaveEntitlement.findFirstOrThrow({
      where: { employeeId: ids.emp.employeeId, year: YEAR },
    });
    try {
      const dto = await read("ent");
      expect(forecastOf(dto, "emp")).toEqual({
        entitlementBasis: "STORED",
        remainingDays: 25,
        pendingDays: 3,
        wishDays: 7,
        forecastDays: 15,
        forecastNegative: false,
      });
      // The read writes nothing to the entitlement.
      const entitlementAfter = await app.prisma.leaveEntitlement.findFirstOrThrow({
        where: { employeeId: ids.emp.employeeId, year: YEAR },
      });
      expect(entitlementAfter).toEqual(entitlementBefore);
    } finally {
      await app.prisma.leavePlanWish.deleteMany({ where: { id: { in: [w1.id, w2.id] } } });
    }
  });

  it("prices two wishes of one SHIFT_BASED week like two requests filed one after another", async () => {
    // 4 contract days: Mo-Mi costs 3, Do-Sa of the same week then costs 1 (not 3).
    const w1 = await wish("sb", "2027-02-01", "2027-02-03");
    const w2 = await wish("sb", "2027-02-04", "2027-02-06");
    try {
      const forecast = forecastOf(await read("ent"), "sb");
      expect(forecast).toMatchObject({ wishDays: 4, remainingDays: 30, forecastDays: 26 });
    } finally {
      await app.prisma.leavePlanWish.deleteMany({ where: { id: { in: [w1.id, w2.id] } } });
    }
  });

  it("uses the regular entitlement without a stored row and creates no row", async () => {
    const rowsBefore = await app.prisma.leaveEntitlement.count({
      where: { employeeId: ids.nr.employeeId },
    });
    expect(rowsBefore).toBe(0);
    const w = await wish("nr", "2027-02-01", "2027-02-02");
    try {
      const forecast = forecastOf(await read("ent"), "nr");
      expect(forecast).toMatchObject({
        entitlementBasis: "COMPUTED",
        pendingDays: 0,
        wishDays: 2,
      });
      expect(forecast!.remainingDays).toBeGreaterThan(0);
      expect(forecast!.forecastDays).toBe(forecast!.remainingDays - 2);
      expect(
        await app.prisma.leaveEntitlement.count({ where: { employeeId: ids.nr.employeeId } }),
      ).toBe(0);
    } finally {
      await app.prisma.leavePlanWish.deleteMany({ where: { id: w.id } });
    }
  });

  it("warns with forecastNegative when the wishes exceed the remaining days - and still accepts the wish", async () => {
    // NEG owns 2 days; a Mo-Fr wish of 5 days is accepted (a warning, never a refusal).
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/leave/plans/${planS}/wishes`,
      headers: authed(tokens.neg),
      payload: { startDate: "2027-02-01", endDate: "2027-02-05" },
    });
    expect(res.statusCode, res.body).toBe(201);
    const forecast = forecastOf(await read("neg"), "neg");
    expect(forecast).toMatchObject({
      remainingDays: 2,
      wishDays: 5,
      forecastDays: -3,
      forecastNegative: true,
    });
  });

  it("serves a plain employee the forecast of the own row only", async () => {
    const dto = await read("emp");
    expect(forecastOf(dto, "emp")).not.toBeNull();
    for (const label of ["sb", "neg", "nr", "ent"]) {
      expect(forecastOf(dto, label), label).toBeNull();
    }
  });

  it("serves a holder of leave-entitlement:read over the tenant every person's forecast", async () => {
    const dto = await read("ent");
    for (const label of ["emp", "sb", "neg", "nr", "ent"]) {
      expect(forecastOf(dto, label), label).not.toBeNull();
    }
  });

  it("serves a 30-person plan in a bounded time (wall time recorded in the SUMMARY)", async () => {
    // 25 more persons with one wish each: 30 persons in the plan, every forecast priced.
    for (let i = 0; i < 25; i++) {
      const label = `bulk${i}`;
      const p = await person(label, []);
      ids[label] = { userId: p.userId, employeeId: p.employeeId };
      await wish(label, "2027-06-07", "2027-06-11");
    }
    // Date is faked in this file; `performance.now()` is the real clock.
    const started = performance.now();
    const dto = await read("ent");
    const elapsed = Math.round(performance.now() - started);
    console.info(
      `leave-plan-forecast-835: planner read of ${dto.persons.length} persons: ${elapsed} ms`,
    );
    expect(dto.persons.length).toBeGreaterThanOrEqual(30);
    expect(forecastOf(dto, "bulk0")).toMatchObject({ wishDays: 5 });
    // A regression ceiling, not a benchmark: a salon-sized plan must stay far below the test timeout.
    expect(elapsed).toBeLessThan(15_000);
  });
});
