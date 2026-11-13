/**
 * Issue #835 (AC-8; D-835-16, D-835-27) — SHIFT_BASED parity: the takeover of a plan gives the
 * SAME result as filing the same requests one by one in start-date order through the routes.
 *
 * D-835-16: a SHIFT_BASED vacation request is priced as its MARGINAL cost on its ISO weeks against
 * the person's earlier-created counted requests; the takeover therefore must create (and approve)
 * the requests of one person in calendar order. D-835-27: siblings are ordered by `createdAt`, so
 * the takeover waits one tick after every create and `createdAt` is strictly increasing.
 *
 * Comparison keys per request (matched by start date): the stored `days`, `daysProvisional`, the
 * CREATE audit `days`, and the VACATION `usedDays` delta of the person's entitlement.
 *
 * Fixture (REAL clock; the plan year is next calendar year, every Monday is built from 1 January of
 * it and skips holidays of the tenant state): two identical SHIFT_BASED persons A and B (contract
 * 4 days, `workDays` Tu-Fr, entitlement 200 days, homed in S, no roster), an ADMIN who is neither.
 * A files through `POST /leave/requests` and the admin approves through `PATCH .../review`; B's
 * wishes are taken over by the same admin. No person names.
 *
 * Same-millisecond control: five rounds, each with a fresh plan and seven single-day wishes of one
 * person in ONE ISO week (a week has seven days, the plan's wording of "ten" is not reachable for
 * one person), entered in reverse order; after every takeover the requests' `createdAt` are
 * strictly increasing in start order and the week's total price is the contract's four days.
 *
 * Mutation proof (Phase 835-07, 2026-11-06) — recorded here, not re-run by CI; reverted with cp:
 * M1 takeover.ts: `waitOneTick` removed -> NOT red (2 of 2 runs green): a create plus its approval takes
 *    far longer than a millisecond on a real database, so the tie the wait guards against cannot be
 *    provoked here. The control pins the observable property (strictly increasing stamps in calendar
 *    order) and would turn red on a tie; the wait itself is defence in depth, not separately proven.
 * M2 takeover.ts: the wish order changed to descending start date -> red: the parity case (the
 *    Do-Sa request is created first and priced 3, the Mo-Mi request 1).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  closeTestApp,
  cleanupTestData,
  createTestSalon,
  grantSystemRole,
  tokenWithoutSignIn,
  auditRowsFor,
} from "./setup";
import { getHolidays, STATE_MAP } from "../contexts/platform/holidays";

const YEAR = new Date().getFullYear() + 1;
const DAY_MS = 24 * 60 * 60 * 1000;

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(day: string, days: number): string {
  return iso(new Date(new Date(`${day}T00:00:00Z`).getTime() + days * DAY_MS));
}

const holidays = new Set<string>(getHolidays(YEAR, STATE_MAP.NIEDERSACHSEN).map((h) => h.date));

/** The first Monday on or after `from` whose whole Mo-So week is holiday free. */
function holidayFreeMondayFrom(from: string): string {
  let candidate = from;
  const start = new Date(`${candidate}T00:00:00Z`);
  candidate = addDays(candidate, (8 - start.getUTCDay()) % 7);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const span = Array.from({ length: 7 }, (_, d) => addDays(candidate, d));
    if (!span.some((day) => holidays.has(day))) return candidate;
    candidate = addDays(candidate, 7);
  }
  throw new Error("no holiday-free week found");
}

// Weeks for the parity case (two weeks apart) and for the five control rounds (a week apart).
const PARITY_WEEK_1 = holidayFreeMondayFrom(`${YEAR}-02-01`);
const PARITY_WEEK_3 = holidayFreeMondayFrom(addDays(PARITY_WEEK_1, 14));
const CONTROL_WEEKS: string[] = [];
for (let i = 0, from = addDays(PARITY_WEEK_3, 14); i < 5; i += 1) {
  const monday = holidayFreeMondayFrom(from);
  CONTROL_WEEKS.push(monday);
  from = addDays(monday, 7);
}

type Range = { startDate: string; endDate: string; halfDay: boolean };

// The parity requests: Mo-Mi + Do-Sa of ONE ISO week (the owner example, priced 3 + 1) and a half
// day in a third week.
const PARITY_RANGES: Range[] = [
  { startDate: PARITY_WEEK_1, endDate: addDays(PARITY_WEEK_1, 2), halfDay: false },
  { startDate: addDays(PARITY_WEEK_1, 3), endDate: addDays(PARITY_WEEK_1, 5), halfDay: false },
  { startDate: PARITY_WEEK_3, endDate: PARITY_WEEK_3, halfDay: true },
];

describe("Issue #835 - SHIFT_BASED parity of the takeover with filing one by one", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let salonId: string;
  let vacationTypeId: string;
  let adminToken: string;
  let adminUserId: string;

  function authed(token: string) {
    return { authorization: `Bearer ${token}` };
  }

  async function shiftBasedPerson(label: string) {
    const prisma = app.prisma;
    const email = `${label}-${crypto.randomBytes(3).toString("hex")}@example.invalid`;
    const user = await prisma.user.create({
      data: { email, passwordHash: await bcrypt.hash("test1234", 4), isActive: true },
    });
    const employee = await prisma.employee.create({
      data: {
        tenantId,
        userId: user.id,
        employeeNumber: `P${crypto.randomBytes(4).toString("hex")}`,
        firstName: label,
        lastName: "Parity835",
        hireDate: new Date("2024-01-01"),
      },
    });
    await grantSystemRole(prisma, { tenantId, userId: user.id, role: "EMPLOYEE" });
    await prisma.workSchedule.create({
      data: {
        employeeId: employee.id,
        type: "SHIFT_BASED",
        weeklyHours: 38,
        contractWorkDaysPerWeek: 4,
        workDays: [2, 3, 4, 5],
        validFrom: new Date("2024-01-01"),
      },
    });
    await prisma.overtimeAccount.create({ data: { employeeId: employee.id, balanceHours: 0 } });
    await prisma.employeeSalonAssignment.create({
      data: {
        tenantId,
        employeeId: employee.id,
        salonId,
        kind: "HOME",
        validFrom: new Date("2024-01-01T00:00:00Z"),
        validUntil: null,
        weekdays: [],
      },
    });
    await prisma.leaveEntitlement.create({
      data: {
        employeeId: employee.id,
        leaveTypeId: vacationTypeId,
        year: YEAR,
        totalDays: 200,
        usedDays: 0,
      },
    });
    return {
      userId: user.id,
      employeeId: employee.id,
      token: await tokenWithoutSignIn(app, email),
    };
  }

  async function openPlan(): Promise<string> {
    await app.prisma.leavePlan.updateMany({
      where: { tenantId, salonId, year: YEAR, status: "OPEN" },
      data: { status: "TAKEN_OVER", takenOverAt: new Date(), takenOverByUserId: adminUserId },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/leave/plans",
      headers: authed(adminToken),
      payload: { salonId, year: YEAR },
    });
    expect(res.statusCode, res.body).toBe(201);
    return (res.json() as { plan: { id: string } }).plan.id;
  }

  async function addWish(planId: string, employeeId: string, range: Range) {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/leave/plans/${planId}/wishes`,
      headers: authed(adminToken),
      payload: { employeeId, ...range },
    });
    expect(res.statusCode, res.body).toBe(201);
  }

  async function takeOver(planId: string) {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/leave/plans/${planId}/takeover`,
      headers: authed(adminToken),
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as {
      created: Array<{ wishId: string; leaveRequestId: string }>;
      pending: unknown[];
      refused: unknown[];
      planStatus: string;
    };
  }

  async function usedDays(employeeId: string): Promise<number> {
    const row = await app.prisma.leaveEntitlement.findUniqueOrThrow({
      where: {
        employeeId_leaveTypeId_year: { employeeId, leaveTypeId: vacationTypeId, year: YEAR },
      },
    });
    return Number(row.usedDays);
  }

  /** The stored facts of a person's requests keyed by start date. */
  async function factsOf(employeeId: string) {
    const rows = await app.prisma.leaveRequest.findMany({
      where: { employeeId, deletedAt: null },
      orderBy: { startDate: "asc" },
      select: {
        id: true,
        startDate: true,
        endDate: true,
        halfDay: true,
        days: true,
        daysProvisional: true,
        status: true,
        createdAt: true,
      },
    });
    const facts = [];
    for (const row of rows) {
      const create = await auditRowsFor(app, "LeaveRequest", row.id, "CREATE");
      expect(create).toHaveLength(1);
      facts.push({
        start: iso(row.startDate),
        end: iso(row.endDate),
        halfDay: row.halfDay,
        days: Number(row.days),
        daysProvisional: row.daysProvisional,
        status: row.status,
        createAuditDays: (create[0]!.newValue as { days: number }).days,
        createdAt: row.createdAt.getTime(),
      });
    }
    return facts;
  }

  beforeAll(async () => {
    app = await getTestApp();
    const prisma = app.prisma;
    const suffix = `p835-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const tenant = await prisma.tenant.create({
      data: { name: `P835 ${suffix}`, slug: `p835-${suffix}`, federalState: "NIEDERSACHSEN" },
    });
    tenantId = tenant.id;
    salonId = (await createTestSalon(prisma, tenantId)).id;
    await prisma.tenantConfig.create({ data: { tenantId } });
    vacationTypeId = (
      await prisma.leaveType.create({
        data: { tenantId, code: "VACATION", name: "Urlaub", isPaid: true, requiresApproval: true },
      })
    ).id;
    await prisma.leaveType.create({
      data: { tenantId, code: "SICK", name: "Krankheit", isPaid: true, requiresApproval: true },
    });

    const adminEmail = `admin-${suffix}@example.invalid`;
    const adminUser = await prisma.user.create({
      data: { email: adminEmail, passwordHash: await bcrypt.hash("test1234", 4), isActive: true },
    });
    await prisma.employee.create({
      data: {
        tenantId,
        userId: adminUser.id,
        employeeNumber: `ADM${crypto.randomBytes(3).toString("hex")}`,
        firstName: "admin",
        lastName: "Parity835",
        hireDate: new Date("2024-01-01"),
      },
    });
    await grantSystemRole(prisma, { tenantId, userId: adminUser.id, role: "ADMIN" });
    adminUserId = adminUser.id;
    adminToken = await tokenWithoutSignIn(app, adminEmail);
  });

  afterAll(async () => {
    try {
      await app.prisma.roleAssignment.deleteMany({ where: { tenantId } });
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("leave-plan-takeover-parity-835 cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("the takeover equals filing one by one in start order: days, provisional flag, entitlement and audit days (owner example 3 + 1 included)", async () => {
    const a = await shiftBasedPerson("a-parity");
    const b = await shiftBasedPerson("b-parity");

    // A: filed one by one through the routes, each approved before the next is filed.
    for (const range of PARITY_RANGES) {
      const posted = await app.inject({
        method: "POST",
        url: "/api/v1/leave/requests",
        headers: authed(a.token),
        payload: { type: "VACATION", ...range },
      });
      expect(posted.statusCode, posted.body).toBe(201);
      const reviewed = await app.inject({
        method: "PATCH",
        url: `/api/v1/leave/requests/${(posted.json() as { id: string }).id}/review`,
        headers: authed(adminToken),
        payload: { status: "APPROVED" },
      });
      expect(reviewed.statusCode, reviewed.body).toBe(200);
    }

    // B: the same three wishes (entered out of order), one takeover.
    const planId = await openPlan();
    for (const index of [2, 0, 1]) await addWish(planId, b.employeeId, PARITY_RANGES[index]!);
    const body = await takeOver(planId);
    expect(body.refused).toEqual([]);
    expect(body.pending).toEqual([]);
    expect(body.created).toHaveLength(3);
    expect(body.planStatus).toBe("TAKEN_OVER");

    const factsA = await factsOf(a.employeeId);
    const factsB = await factsOf(b.employeeId);
    expect(factsA).toHaveLength(3);
    const key = ({ createdAt: _createdAt, ...rest }: (typeof factsA)[number]) => rest;
    expect(factsB.map(key)).toEqual(factsA.map(key));
    expect(factsB.every((f) => f.status === "APPROVED")).toBe(true);

    // The owner example: Mo-Mi costs 3, Do-Sa of the SAME week costs 1 (not 3).
    expect(factsB[0]!.days).toBe(3);
    expect(factsB[1]!.days).toBe(1);
    expect(await usedDays(b.employeeId)).toBe(await usedDays(a.employeeId));
    expect(await usedDays(b.employeeId)).toBeGreaterThan(0);

    // D-835-27: the sibling order the pricing sees is the calendar order.
    for (let i = 1; i < factsB.length; i += 1) {
      expect(factsB[i]!.createdAt).toBeGreaterThan(factsB[i - 1]!.createdAt);
    }
  }, 240_000);

  it("same-millisecond control: five fresh plans of seven single-day wishes in one week keep createdAt strictly increasing in start order", async () => {
    const c = await shiftBasedPerson("c-control");
    for (const monday of CONTROL_WEEKS) {
      const planId = await openPlan();
      const days = Array.from({ length: 7 }, (_, d) => addDays(monday, d));
      for (const day of [...days].reverse()) {
        await addWish(planId, c.employeeId, { startDate: day, endDate: day, halfDay: false });
      }
      const body = await takeOver(planId);
      expect(body.refused).toEqual([]);
      expect(body.created).toHaveLength(7);
      expect(body.planStatus).toBe("TAKEN_OVER");

      const rows = await app.prisma.leaveRequest.findMany({
        where: { employeeId: c.employeeId, startDate: { gte: new Date(`${monday}T00:00:00Z`) } },
        orderBy: { startDate: "asc" },
        select: { startDate: true, createdAt: true, days: true },
      });
      const inWeek = rows.filter((r) => days.includes(iso(r.startDate)));
      expect(inWeek.map((r) => iso(r.startDate))).toEqual(days);
      for (let i = 1; i < inWeek.length; i += 1) {
        expect(inWeek[i]!.createdAt.getTime(), `${monday} #${i}`).toBeGreaterThan(
          inWeek[i - 1]!.createdAt.getTime(),
        );
      }
      // Marginal pricing in calendar order: the week costs the contract's four days in total.
      expect(inWeek.reduce((sum, r) => sum + Number(r.days), 0)).toBe(4);
    }
  }, 240_000);
});
