import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  seedEntitlementYears,
} from "./setup";
import type { FastifyInstance } from "fastify";

/**
 * Issue #478 — a request in CANCELLATION_REQUESTED is still active leave (CLAUDE.md "Leave
 * Cancellation Flow"), so the overlap guards count it like APPROVED. SICK/SICK_CHILD over it stays
 * allowed (§ 9 BUrlG), sick over sick and sick over PENDING stay blocked.
 */
describe("Overlap guard and CANCELLATION_REQUESTED (Issue #478)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  const OVERLAP = "Überschneidung mit bestehendem Antrag";

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "ov478");
    await seedEntitlementYears(app, {
      employeeId: data.employee.id,
      leaveTypeId: data.vacationType.id,
      years: [2030],
    });
  });

  afterAll(async () => {
    try {
      await app.prisma.section9Credit.deleteMany({ where: { employeeId: data.employee.id } });
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  const post = (payload: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: { authorization: `Bearer ${data.empToken}` },
      payload,
    });

  const review = (id: string, status: string) =>
    app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${id}/review`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { status },
    });

  /** An approved request moved into CANCELLATION_REQUESTED the way the storno flow leaves it. */
  async function cancellationRequested(type: string, startDate: string, endDate: string) {
    const created = await post({ type, startDate, endDate });
    expect(created.statusCode).toBe(201);
    const id = JSON.parse(created.body).id as string;
    expect((await review(id, "APPROVED")).statusCode).toBe(200);
    await app.prisma.leaveRequest.update({
      where: { id },
      data: { status: "CANCELLATION_REQUESTED" },
    });
    return id;
  }

  it("a vacation over a CANCELLATION_REQUESTED vacation is refused with 409", async () => {
    await cancellationRequested("VACATION", "2030-03-04", "2030-03-08");
    const res = await post({ type: "VACATION", startDate: "2030-03-06", endDate: "2030-03-12" });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe(OVERLAP);
  });

  it("a SICK request over a CANCELLATION_REQUESTED vacation stays allowed (§ 9 BUrlG)", async () => {
    await cancellationRequested("VACATION", "2030-04-01", "2030-04-05");
    expect(
      (await post({ type: "SICK", startDate: "2030-04-02", endDate: "2030-04-03" })).statusCode,
    ).toBe(201);
    expect(
      (await post({ type: "SICK_CHILD", startDate: "2030-04-04", endDate: "2030-04-04" }))
        .statusCode,
    ).toBe(201);
  });

  it("approving that sick request still opens the § 9 case against the CANCELLATION_REQUESTED vacation", async () => {
    await cancellationRequested("VACATION", "2030-05-06", "2030-05-10");
    const sick = await post({ type: "SICK", startDate: "2030-05-07", endDate: "2030-05-08" });
    expect(sick.statusCode).toBe(201);
    const sickId = JSON.parse(sick.body).id as string;
    expect((await review(sickId, "APPROVED")).statusCode).toBe(200);
    const credits = await app.prisma.section9Credit.findMany({
      where: { employeeId: data.employee.id },
    });
    expect(credits.some((c) => c.sickRequestId === sickId)).toBe(true);
  });

  it("sick over sick and sick over a PENDING vacation stay blocked", async () => {
    expect(
      (await post({ type: "SICK", startDate: "2030-06-03", endDate: "2030-06-05" })).statusCode,
    ).toBe(201);
    const sickOnSick = await post({ type: "SICK", startDate: "2030-06-04", endDate: "2030-06-06" });
    expect(sickOnSick.statusCode).toBe(409);

    expect(
      (await post({ type: "VACATION", startDate: "2030-06-17", endDate: "2030-06-21" })).statusCode,
    ).toBe(201);
    const sickOnPending = await post({
      type: "SICK",
      startDate: "2030-06-18",
      endDate: "2030-06-19",
    });
    expect(sickOnPending.statusCode).toBe(409);
  });

  it("two half days on the same date stay an overlap (owner decision 25.10.2026)", async () => {
    expect(
      (
        await post({
          type: "VACATION",
          startDate: "2030-07-01",
          endDate: "2030-07-01",
          halfDay: true,
        })
      ).statusCode,
    ).toBe(201);
    const second = await post({
      type: "VACATION",
      startDate: "2030-07-01",
      endDate: "2030-07-01",
      halfDay: true,
    });
    expect(second.statusCode).toBe(409);
  });

  it("/correct moving an approved vacation into a CANCELLATION_REQUESTED one is refused with 409 OVERLAP", async () => {
    const other = await cancellationRequested("VACATION", "2030-09-16", "2030-09-20");
    const mine = await post({ type: "VACATION", startDate: "2030-09-02", endDate: "2030-09-06" });
    const mineId = JSON.parse(mine.body).id as string;
    expect((await review(mineId, "APPROVED")).statusCode).toBe(200);
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${mineId}/correct`,
      headers: { authorization: `Bearer ${data.adminToken}`, "user-agent": "vitest-agent/1.0" },
      payload: {
        reason: "Korrektur nach Rückfrage",
        startDate: "2030-09-02",
        endDate: "2030-09-17",
      },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe(OVERLAP);
    expect(other).toBeTruthy();
  });
});
