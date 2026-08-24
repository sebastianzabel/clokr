/**
 * Phase 104-05: Section9Credit auto-detection on the leave-review approve path (D-09/D-13).
 *
 * This is the phase's central state-machine test file — plans 104-06 and 104-08 extend it
 * with confirm/reject transitions and Karenztage interaction respectively. Kept in
 * `describe()` blocks per detection step so later plans can append their own blocks
 * without re-reading this file's fixtures.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

describe("Section9Credit detection (AU_PENDING) — Phase 104-05", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "s9c");
  });

  afterAll(async () => {
    try {
      // Section9Credit's two LeaveRequest FKs are onDelete: Restrict — must be cleared
      // before cleanupTestData's leaveRequest.deleteMany, or rows leak into clokr_test
      // (same failure class 104-04 hit; setup.ts's cleanupTestData now also does this
      // generically, but this suite creates credits directly via prisma too, so an
      // explicit belt-and-braces delete here costs nothing).
      await app.prisma.section9Credit.deleteMany({ where: { employeeId: data.employee.id } });
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  async function createRequest(payload: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: { authorization: `Bearer ${data.empToken}` },
      payload,
    });
  }

  async function approve(id: string) {
    return app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${id}/review`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { status: "APPROVED" },
    });
  }

  async function getEntitlement() {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/leave/entitlements/${data.employee.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    const rows = JSON.parse(res.body) as Array<{ leaveType?: { name: string }; usedDays?: number }>;
    return rows.find((r) => r.leaveType?.name === "Urlaub");
  }

  it("Test 1: approving a SICK request overlapping an APPROVED vacation creates exactly one AU_PENDING credit", async () => {
    const vac = await createRequest({
      type: "VACATION",
      startDate: "2026-06-01",
      endDate: "2026-06-05",
    });
    expect(vac.statusCode).toBe(201);
    const vacId = JSON.parse(vac.body).id as string;
    expect((await approve(vacId)).statusCode).toBe(200);

    const sick = await createRequest({
      type: "SICK",
      startDate: "2026-06-03",
      endDate: "2026-06-04",
    });
    expect(sick.statusCode).toBe(201);
    const sickId = JSON.parse(sick.body).id as string;
    expect((await approve(sickId)).statusCode).toBe(200);

    const credits = await app.prisma.section9Credit.findMany({
      where: { sickRequestId: sickId },
    });
    expect(credits).toHaveLength(1);
    expect(credits[0].status).toBe("AU_PENDING");
    expect(credits[0].vacationRequestId).toBe(vacId);
    expect(credits[0].overlapStart.toISOString().split("T")[0]).toBe("2026-06-03");
    expect(credits[0].overlapEnd.toISOString().split("T")[0]).toBe("2026-06-04");
  });

  it("Test 2: creating the credit does NOT change LeaveEntitlement.usedDays (D-09: effect-free)", async () => {
    const vac = await createRequest({
      type: "VACATION",
      startDate: "2026-07-06",
      endDate: "2026-07-10",
    });
    expect(vac.statusCode).toBe(201);
    const vacId = JSON.parse(vac.body).id as string;
    expect((await approve(vacId)).statusCode).toBe(200);

    const usedAfterVacationApproval = Number((await getEntitlement())?.usedDays ?? 0);

    const sick = await createRequest({
      type: "SICK",
      startDate: "2026-07-08",
      endDate: "2026-07-09",
    });
    expect(sick.statusCode).toBe(201);
    const sickId = JSON.parse(sick.body).id as string;
    expect((await approve(sickId)).statusCode).toBe(200);

    const credits = await app.prisma.section9Credit.findMany({ where: { sickRequestId: sickId } });
    expect(credits).toHaveLength(1);

    const usedAfterSickApproval = Number((await getEntitlement())?.usedDays ?? 0);
    expect(usedAfterSickApproval).toBe(usedAfterVacationApproval);
  });

  it("Test 3: the vacation LeaveRequest row is byte-identical before and after credit creation (D-05)", async () => {
    const vac = await createRequest({
      type: "VACATION",
      startDate: "2026-08-24",
      endDate: "2026-08-28",
    });
    expect(vac.statusCode).toBe(201);
    const vacId = JSON.parse(vac.body).id as string;
    expect((await approve(vacId)).statusCode).toBe(200);

    const before = await app.prisma.leaveRequest.findUniqueOrThrow({ where: { id: vacId } });

    const sick = await createRequest({
      type: "SICK",
      startDate: "2026-08-26",
      endDate: "2026-08-27",
    });
    expect(sick.statusCode).toBe(201);
    const sickId = JSON.parse(sick.body).id as string;
    expect((await approve(sickId)).statusCode).toBe(200);

    const after = await app.prisma.leaveRequest.findUniqueOrThrow({ where: { id: vacId } });
    expect(Number(after.days)).toBe(Number(before.days));
    expect(after.startDate).toEqual(before.startDate);
    expect(after.endDate).toEqual(before.endDate);
    expect(after.status).toBe(before.status);
    expect(after.updatedAt).toEqual(before.updatedAt);
  });

  it("Test 4: a SICK request overlapping TWO separate approved requests creates TWO credits", async () => {
    const vacA = await createRequest({
      type: "VACATION",
      startDate: "2026-09-07",
      endDate: "2026-09-08",
    });
    expect(vacA.statusCode).toBe(201);
    const vacAId = JSON.parse(vacA.body).id as string;
    expect((await approve(vacAId)).statusCode).toBe(200);

    const vacB = await createRequest({
      type: "VACATION",
      startDate: "2026-09-10",
      endDate: "2026-09-11",
    });
    expect(vacB.statusCode).toBe(201);
    const vacBId = JSON.parse(vacB.body).id as string;
    expect((await approve(vacBId)).statusCode).toBe(200);

    // Spans Mon–Fri (09-07..09-11), overlapping vacA (Mon–Tue) and vacB (Thu–Fri), skipping
    // Wed (09-09) which is deliberately left free of any approved request.
    const sick = await createRequest({
      type: "SICK",
      startDate: "2026-09-07",
      endDate: "2026-09-11",
    });
    expect(sick.statusCode).toBe(201);
    const sickId = JSON.parse(sick.body).id as string;
    expect((await approve(sickId)).statusCode).toBe(200);

    const credits = await app.prisma.section9Credit.findMany({
      where: { sickRequestId: sickId },
      orderBy: { overlapStart: "asc" },
    });
    expect(credits).toHaveLength(2);
    expect(credits[0].vacationRequestId).toBe(vacAId);
    expect(credits[1].vacationRequestId).toBe(vacBId);
  });

  it("Test 5: a pre-existing credit for the same (sickRequestId, vacationRequestId) pair is not duplicated", async () => {
    const vac = await createRequest({
      type: "VACATION",
      startDate: "2026-10-05",
      endDate: "2026-10-09",
    });
    expect(vac.statusCode).toBe(201);
    const vacId = JSON.parse(vac.body).id as string;
    expect((await approve(vacId)).statusCode).toBe(200);

    const sick = await createRequest({
      type: "SICK",
      startDate: "2026-10-07",
      endDate: "2026-10-08",
    });
    expect(sick.statusCode).toBe(201);
    const sickId = JSON.parse(sick.body).id as string;

    // Simulate a pre-existing credit for this exact pair (e.g. a retried/duplicate approve
    // dispatch) — the API only allows approving a PENDING request once, so this is the
    // direct way to exercise the dedupe guard inside the approve handler itself.
    await app.prisma.section9Credit.create({
      data: {
        employeeId: data.employee.id,
        sickRequestId: sickId,
        vacationRequestId: vacId,
        overlapStart: new Date("2026-10-07"),
        overlapEnd: new Date("2026-10-08"),
      },
    });

    expect((await approve(sickId)).statusCode).toBe(200);

    const credits = await app.prisma.section9Credit.findMany({
      where: { sickRequestId: sickId, vacationRequestId: vacId },
    });
    expect(credits).toHaveLength(1);
  });

  it("Test 6: a SICK request with no overlap creates no credit at all", async () => {
    const sick = await createRequest({
      type: "SICK",
      startDate: "2026-11-02",
      endDate: "2026-11-04",
    });
    expect(sick.statusCode).toBe(201);
    const sickId = JSON.parse(sick.body).id as string;
    expect((await approve(sickId)).statusCode).toBe(200);

    const credits = await app.prisma.section9Credit.findMany({ where: { sickRequestId: sickId } });
    expect(credits).toHaveLength(0);
  });

  it("Test 7 (D-13 ordering): no Section9Credit exists while the sick request is still PENDING", async () => {
    const vac = await createRequest({
      type: "VACATION",
      startDate: "2026-12-07",
      endDate: "2026-12-11",
    });
    expect(vac.statusCode).toBe(201);
    const vacId = JSON.parse(vac.body).id as string;
    expect((await approve(vacId)).statusCode).toBe(200);

    const sick = await createRequest({
      type: "SICK",
      startDate: "2026-12-09",
      endDate: "2026-12-10",
    });
    expect(sick.statusCode).toBe(201);
    const sickId = JSON.parse(sick.body).id as string;
    // deliberately NOT approved

    const credits = await app.prisma.section9Credit.findMany({ where: { sickRequestId: sickId } });
    expect(credits).toHaveLength(0);
  });

  it("Test 8: a SECTION9_CREDIT_DETECTED audit row exists with both request ids and overlap dates", async () => {
    // 2030, deliberately far beyond any year this suite's earlier tests touch (2026/2026 only)
    // — autoCarryOver only looks one year back, so with no 2029 LeaveEntitlement row ever
    // created, no entitlement-limit check can interfere with this audit-payload assertion.
    const vac = await createRequest({
      type: "VACATION",
      startDate: "2030-01-07",
      endDate: "2030-01-11",
    });
    expect(vac.statusCode).toBe(201);
    const vacId = JSON.parse(vac.body).id as string;
    expect((await approve(vacId)).statusCode).toBe(200);

    const sick = await createRequest({
      type: "SICK",
      startDate: "2030-01-09",
      endDate: "2030-01-10",
    });
    expect(sick.statusCode).toBe(201);
    const sickId = JSON.parse(sick.body).id as string;
    expect((await approve(sickId)).statusCode).toBe(200);

    const credit = await app.prisma.section9Credit.findFirstOrThrow({
      where: { sickRequestId: sickId },
    });
    const audit = await app.prisma.auditLog.findFirst({
      where: { action: "SECTION9_CREDIT_DETECTED", entity: "Section9Credit", entityId: credit.id },
    });
    expect(audit).not.toBeNull();
    const newValue = audit!.newValue as {
      sickRequestId: string;
      vacationRequestId: string;
      overlapStart: string;
      overlapEnd: string;
    };
    expect(newValue.sickRequestId).toBe(sickId);
    expect(newValue.vacationRequestId).toBe(vacId);
    expect(newValue.overlapStart).toBe("2030-01-09");
    expect(newValue.overlapEnd).toBe("2030-01-10");
  });
});
