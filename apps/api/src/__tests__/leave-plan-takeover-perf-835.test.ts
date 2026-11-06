/**
 * Issue #835 (plan 835-11, Task 0; D-835-36/37) — what the takeover of a 40-wish plan costs, with and
 * without closed months. The live saldo starts after the LAST closed month (`overtime-balance.ts`),
 * and only without any closed month from the hire date, so the cost of the saldo recompute inside
 * the approval core depends on the tenure state of the persons:
 *   (a) persons whose months are closed through the previous month — closed with the REAL closer
 *       (`POST /overtime/close-month`, never a hand-written snapshot);
 *   (b) persons without a closed month and a hire date in 2024 — the worst case (a new tenant in its
 *       first year, no close has ever run).
 * Both cases take over 40 wishes (40 persons, one Mo-Fr week each, plan year = next calendar year) in
 * one request and print the wall time. The ceilings are regression guards, not the measurement; the
 * measured numbers are recorded in the 835-11 SUMMARY.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import pg from "pg";
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
import { dateStrInTz, getTenantTimezone } from "../contexts/working-time-account";

const MANAGE = "leave-plan:manage:ZUGEWIESEN";
const APPROVE = "leave-request:approve:ZUGEWIESEN";
const READ = "leave-request:read:ZUGEWIESEN";
const CLOSE = "month-close:close:ZUGEWIESEN";
const YEAR = new Date().getFullYear() + 1;
const WISHES = 40;
const DAY_MS = 24 * 60 * 60 * 1000;

type Person = { userId: string; employeeId: string };

/**
 * Counts every statement the pg driver sends (the Prisma adapter runs on it): a load-independent
 * cost measure next to the wall time, which depends on what else the machine does.
 */
let statementCount = 0;
const originalQuery = pg.Client.prototype.query;
function countStatements(): void {
  pg.Client.prototype.query = function patched(this: unknown, ...args: unknown[]) {
    statementCount += 1;
    return (originalQuery as (...a: unknown[]) => unknown).apply(this, args);
  } as typeof pg.Client.prototype.query;
}

describe("Issue #835 - takeover wall time of 40 wishes (plan 835-11)", () => {
  let app: FastifyInstance;
  let one: Awaited<ReturnType<typeof seedTestData>>;
  let takerToken: string;
  let taker: Person;
  let closerToken: string;

  function authed(token: string) {
    return { authorization: `Bearer ${token}` };
  }

  async function rawPerson(label: string, hireDate: Date): Promise<Person> {
    const email = `${label}-${crypto.randomBytes(3).toString("hex")}@example.invalid`;
    const user = await app.prisma.user.create({
      data: { email, passwordHash: await bcrypt.hash("test1234", 4), isActive: true },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: one.tenant.id,
        userId: user.id,
        employeeNumber: `P${crypto.randomBytes(4).toString("hex")}`,
        firstName: label,
        lastName: "Perf835",
        hireDate,
      },
    });
    await app.prisma.workSchedule.create({
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
        validFrom: hireDate,
      },
    });
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: one.tenant.id,
        employeeId: employee.id,
        salonId: one.salonId,
        kind: "HOME",
        validFrom: new Date("2024-01-01T00:00:00Z"),
        validUntil: null,
        weekdays: [],
      },
    });
    await seedEntitlementYears(app, {
      employeeId: employee.id,
      leaveTypeId: one.vacationType.id,
      years: [YEAR],
      totalDays: 30,
    });
    return { userId: user.id, employeeId: employee.id };
  }

  async function actor(label: string, permissions: string[]) {
    const person = await rawPerson(label, new Date("2024-01-01"));
    const name = `Perf835 ${crypto.randomBytes(3).toString("hex")}`;
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
        userId: person.userId,
        accessRoleId: role.id,
        scopeType: "TENANT",
        salonIds: [],
        employeeIds: [],
      },
    });
    const user = await app.prisma.user.findUniqueOrThrow({ where: { id: person.userId } });
    return { ...person, token: await tokenWithoutSignIn(app, user.email) };
  }

  /** The three tenant-local months before the current one, oldest first. */
  async function lastThreeMonths(): Promise<Array<{ year: number; month: number }>> {
    const tz = await getTenantTimezone(app.prisma, one.tenant.id);
    const [y, m] = dateStrInTz(new Date(), tz).split("-").map(Number);
    const months: Array<{ year: number; month: number }> = [];
    for (let back = 3; back >= 1; back -= 1) {
      const index = y * 12 + (m - 1) - back;
      months.push({ year: Math.floor(index / 12), month: (index % 12) + 1 });
    }
    return months;
  }

  async function freshPlanWithWishes(people: Person[]): Promise<string> {
    await app.prisma.leavePlan.updateMany({
      where: { tenantId: one.tenant.id, salonId: one.salonId, year: YEAR, status: "OPEN" },
      data: { status: "TAKEN_OVER", takenOverAt: new Date(), takenOverByUserId: taker.userId },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/leave/plans",
      headers: authed(takerToken),
      payload: { salonId: one.salonId, year: YEAR },
    });
    expect(res.statusCode, res.body).toBe(201);
    const planId = (res.json() as { plan: { id: string } }).plan.id;
    const first = new Date(Date.UTC(YEAR, 1, 1));
    const monday = new Date(first.getTime() + ((8 - first.getUTCDay()) % 7) * DAY_MS);
    const friday = new Date(monday.getTime() + 4 * DAY_MS);
    for (const person of people) {
      await app.prisma.leavePlanWish.create({
        data: {
          tenantId: one.tenant.id,
          planId,
          employeeId: person.employeeId,
          startDate: monday,
          endDate: friday,
          createdByUserId: taker.userId,
        },
      });
    }
    return planId;
  }

  async function timedTakeover(planId: string): Promise<number> {
    statementCount = 0;
    const started = Date.now();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/leave/plans/${planId}/takeover`,
      headers: authed(takerToken),
      payload: {},
    });
    const seconds = (Date.now() - started) / 1000;
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { created: unknown[]; refused: unknown[]; planStatus: string };
    expect(body.refused).toEqual([]);
    expect(body.created).toHaveLength(WISHES);
    expect(body.planStatus).toBe("TAKEN_OVER");
    return seconds;
  }

  function report(label: string, seconds: number) {
    const perWish = seconds / WISHES;
    console.warn(
      `[835-11] ${label}: ${seconds.toFixed(1)} s for ${WISHES} wishes = ${perWish.toFixed(3)} s/wish, ` +
        `100 wishes ~ ${(perWish * 100).toFixed(1)} s, ` +
        `${(statementCount / WISHES).toFixed(0)} statements/wish`,
    );
  }

  beforeAll(async () => {
    app = await getTestApp();
    countStatements();
    one = await seedTestData(app, "tkperf835");
    const t = await actor("taker", [MANAGE, APPROVE, READ]);
    taker = { userId: t.userId, employeeId: t.employeeId };
    takerToken = t.token;
    closerToken = (await actor("closer", [CLOSE, READ])).token;
  });

  afterAll(async () => {
    pg.Client.prototype.query = originalQuery;
    try {
      await app.prisma.roleAssignment.deleteMany({ where: { tenantId: one.tenant.id } });
      await cleanupTestData(app, one.tenant.id);
    } catch (err) {
      console.error("leave-plan-takeover-perf-835 cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("(a) persons with every month closed through the previous month", async () => {
    const months = await lastThreeMonths();
    const hire = new Date(Date.UTC(months[0].year, months[0].month - 1, 1));
    const people: Person[] = [];
    for (let i = 0; i < WISHES; i += 1) people.push(await rawPerson(`closed${i}`, hire));
    for (const person of people) {
      for (const { year, month } of months) {
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/overtime/close-month",
          headers: authed(closerToken),
          payload: { employeeId: person.employeeId, year, month, confirmGaps: true },
        });
        expect(res.statusCode, res.body).toBe(201);
      }
    }
    const closed = await app.prisma.saldoSnapshot.count({
      where: {
        employeeId: { in: people.map((p) => p.employeeId) },
        periodType: "MONTHLY",
        superseded: false,
      },
    });
    expect(closed).toBe(WISHES * months.length);

    const planId = await freshPlanWithWishes(people);
    const seconds = await timedTakeover(planId);
    report("(a) closed months", seconds);
    expect(seconds).toBeLessThan(60);
  }, 900_000);

  it("(b) persons without any closed month (hire date 2024-01-01), the worst case", async () => {
    const people: Person[] = [];
    for (let i = 0; i < WISHES; i += 1) {
      people.push(await rawPerson(`open${i}`, new Date("2024-01-01")));
    }
    const planId = await freshPlanWithWishes(people);
    const seconds = await timedTakeover(planId);
    report("(b) no closed month", seconds);
    expect(seconds).toBeLessThan(60);
  }, 600_000);
});
