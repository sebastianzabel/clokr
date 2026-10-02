import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  seedEntitlementYears,
} from "./setup";
import { futureDateStr, nextWeekdayStr, addDaysStr } from "./test-dates";
import type { FastifyInstance } from "fastify";

/**
 * Issue #449 (D-1): a half-day leave request may only cover a single calendar date on all
 * three write paths (POST /requests, PATCH /requests/:id, PATCH /requests/:id/correct). This
 * is the RED-first regression test for the shared Zod refine — it must FAIL (the three 400
 * cases return 201/200 and write) before `leave.ts` gets the refine, and PASS afterwards.
 */
const HALF_DAY_SINGLE_DATE_MESSAGE = "Ein halber Tag ist nur für ein einzelnes Datum möglich.";

describe("Half day = single date only (Issue #449, D-1/D-2)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "hd449");
    // D-2 control books onto a window that may land in the following calendar year —
    // provision both years explicitly rather than pinning a date to dodge it.
    const thisYear = new Date().getFullYear();
    await seedEntitlementYears(app, {
      employeeId: data.employee.id,
      leaveTypeId: data.vacationType.id,
      years: [thisYear, thisYear + 1],
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  async function countEmployeeRequests(): Promise<number> {
    return app.prisma.leaveRequest.count({ where: { employeeId: data.employee.id } });
  }

  it("POST /requests rejects halfDay over a range (400, no write)", async () => {
    const start = nextWeekdayStr(futureDateStr(20));
    const end = addDaysStr(start, 3);
    const before = await countEmployeeRequests();

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: { type: "VACATION", startDate: start, endDate: end, halfDay: true },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("Validierungsfehler");
    expect(body.message).toContain(`endDate: ${HALF_DAY_SINGLE_DATE_MESSAGE}`);
    expect(body.details).toContainEqual(
      expect.objectContaining({ path: ["endDate"], message: HALF_DAY_SINGLE_DATE_MESSAGE }),
    );
    expect(await countEmployeeRequests()).toBe(before);
  });

  it("PATCH /requests/:id rejects halfDay over a range on the employee's own PENDING request (400, row unchanged)", async () => {
    const original = nextWeekdayStr(futureDateStr(30));
    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: { type: "VACATION", startDate: original, endDate: original },
    });
    expect(createRes.statusCode).toBe(201);
    const { id } = JSON.parse(createRes.body);

    const newStart = nextWeekdayStr(futureDateStr(31));
    const newEnd = addDaysStr(newStart, 2);

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${id}`,
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: { startDate: newStart, endDate: newEnd, halfDay: true },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("Validierungsfehler");
    expect(body.message).toContain(`endDate: ${HALF_DAY_SINGLE_DATE_MESSAGE}`);

    const row = await app.prisma.leaveRequest.findUniqueOrThrow({ where: { id } });
    expect(row.startDate.toISOString().slice(0, 10)).toBe(original);
    expect(row.endDate.toISOString().slice(0, 10)).toBe(original);
    expect(row.halfDay).toBe(false);
    expect(Number(row.days)).toBe(1);
  });

  it("PATCH /requests/:id/correct rejects halfDay over a range on an APPROVED request (400, row unchanged, no LEAVE_CORRECTED audit)", async () => {
    const original = nextWeekdayStr(futureDateStr(40));
    const req = await app.prisma.leaveRequest.create({
      data: {
        employeeId: data.employee.id,
        leaveTypeId: data.vacationType.id,
        startDate: new Date(`${original}T00:00:00Z`),
        endDate: new Date(`${original}T00:00:00Z`),
        days: 1,
        halfDay: false,
        status: "APPROVED",
        reviewedBy: "system",
        reviewedAt: new Date(),
      },
    });

    const newStart = nextWeekdayStr(futureDateStr(41));
    const newEnd = addDaysStr(newStart, 3);

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${req.id}/correct`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        startDate: newStart,
        endDate: newEnd,
        halfDay: true,
        reason: "Korrektur nach Rückfrage",
      },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("Validierungsfehler");
    expect(body.message).toContain(`endDate: ${HALF_DAY_SINGLE_DATE_MESSAGE}`);

    const row = await app.prisma.leaveRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(row.startDate.toISOString().slice(0, 10)).toBe(original);
    expect(row.endDate.toISOString().slice(0, 10)).toBe(original);
    expect(row.halfDay).toBe(false);

    const correctedAudits = await app.prisma.auditLog.count({
      where: { entity: "LeaveRequest", entityId: req.id, action: "LEAVE_CORRECTED" },
    });
    expect(correctedAudits).toBe(0);
  });

  it("control: single-day halfDay POST still returns 201 with days 0.5", async () => {
    const day = nextWeekdayStr(futureDateStr(50));

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: { type: "VACATION", startDate: day, endDate: day, halfDay: true },
    });

    expect(res.statusCode).toBe(201);
    expect(Number(JSON.parse(res.body).days)).toBe(0.5);
  });

  it("control: multi-day full-day POST still returns 201", async () => {
    const start = nextWeekdayStr(futureDateStr(60));
    const end = addDaysStr(start, 4);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: { type: "VACATION", startDate: start, endDate: end, halfDay: false },
    });

    expect(res.statusCode).toBe(201);
  });

  it("D-2 control: an existing PENDING multi-day half-day request can still be approved (calculation unchanged)", async () => {
    const start = nextWeekdayStr(futureDateStr(70));
    const end = addDaysStr(start, 4);
    const legacy = await app.prisma.leaveRequest.create({
      data: {
        employeeId: data.employee.id,
        leaveTypeId: data.vacationType.id,
        startDate: new Date(`${start}T00:00:00Z`),
        endDate: new Date(`${end}T00:00:00Z`),
        days: 0.5,
        halfDay: true,
        status: "PENDING",
      },
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${legacy.id}/review`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { status: "APPROVED" },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe("APPROVED");
  });
});
