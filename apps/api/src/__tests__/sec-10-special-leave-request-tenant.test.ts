/**
 * fix(sec-10 / #223): POST /api/v1/leave/requests validated a client-supplied
 * `specialLeaveRuleId` via an unfiltered `specialLeaveRule.findUnique({ where: { id } })`.
 * SpecialLeaveRule has its own tenantId — this let a tenant reference (and successfully
 * consume) another tenant's special-leave rule, e.g. to bypass its own tenant's configured
 * `defaultDays` cap. Fixed with a combined `findFirst({ where: { id, tenantId } })`, the same
 * shape sec-05/sec-06 already established for the sibling PUT/DELETE /special-leave/rules/:id
 * routes.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";
import { getHolidays, STATE_MAP } from "../utils/holidays";
import { futureDateStr, nextWeekdayStr, dbDateStr, utcMidnight } from "./test-dates";

const DAY_MS = 24 * 60 * 60 * 1000;

/** A weekday at least `daysOut` days out that carries no NIEDERSACHSEN public holiday. */
function nextHolidayFreeWeekday(daysOut: number): string {
  let candidate = nextWeekdayStr(futureDateStr(daysOut));
  const MAX_ADVANCES = 30;
  for (let i = 0; i < MAX_ADVANCES; i++) {
    const year = Number(candidate.slice(0, 4));
    const holidayDates = new Set(getHolidays(year, STATE_MAP.NIEDERSACHSEN).map((h) => h.date));
    if (!holidayDates.has(candidate)) return candidate;
    candidate = nextWeekdayStr(dbDateStr(new Date(utcMidnight(candidate).getTime() + DAY_MS)));
  }
  throw new Error("nextHolidayFreeWeekday: exceeded MAX_ADVANCES");
}

describe("POST /api/v1/leave/requests — SpecialLeaveRule tenant isolation (#223)", () => {
  let app: FastifyInstance;
  let tenantA: Awaited<ReturnType<typeof seedTestData>>;
  let tenantB: Awaited<ReturnType<typeof seedTestData>>;
  let tenantBRuleId: string;

  beforeAll(async () => {
    app = await getTestApp();
    tenantA = await seedTestData(app, "sec10-a");
    tenantB = await seedTestData(app, "sec10-b");

    const rule = await app.prisma.specialLeaveRule.create({
      data: {
        tenantId: tenantB.tenant.id,
        name: "Sec10 TenantB Sonderregel",
        defaultDays: 3,
        isActive: true,
      },
    });
    tenantBRuleId = rule.id;
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantA.tenant.id);
    } catch (err) {
      console.error("Cleanup tenantA failed:", err);
    }
    try {
      await cleanupTestData(app, tenantB.tenant.id);
    } catch (err) {
      console.error("Cleanup tenantB failed:", err);
    }
  });

  it("tenantA employee referencing tenantB's specialLeaveRuleId → 400, rule not consumed cross-tenant", async () => {
    const day = nextHolidayFreeWeekday(3);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: { authorization: `Bearer ${tenantA.empToken}` },
      payload: {
        type: "SPECIAL",
        startDate: day,
        endDate: day,
        specialLeaveRuleId: tenantBRuleId,
      },
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: "Ungültiger oder deaktivierter Sonderurlaubs-Anlass",
    });

    // No LeaveRequest referencing the foreign rule may have been created.
    const leaked = await app.prisma.leaveRequest.findMany({
      where: { employeeId: tenantA.employee.id, specialLeaveRuleId: tenantBRuleId },
    });
    expect(leaked).toHaveLength(0);
  });

  it("tenantB employee referencing their OWN specialLeaveRuleId still succeeds (no regression)", async () => {
    const day = nextHolidayFreeWeekday(10);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: { authorization: `Bearer ${tenantB.empToken}` },
      payload: {
        type: "SPECIAL",
        startDate: day,
        endDate: day,
        specialLeaveRuleId: tenantBRuleId,
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.specialLeaveRuleId).toBe(tenantBRuleId);
  });
});
