/**
 * Phase 104-05: Section9Credit auto-detection on the leave-review approve path (D-09/D-13).
 *
 * This is the phase's central state-machine test file — plans 104-06 and 104-08 extend it
 * with confirm/reject transitions and Karenztage interaction respectively. Kept in
 * `describe()` blocks per detection step so later plans can append their own blocks
 * without re-reading this file's fixtures.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
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

describe("Section9Credit notifications and listing — Phase 104-05 Task 3", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let other: Awaited<ReturnType<typeof seedTestData>>;
  let managerToken: string;
  let creditId: string;
  let vacId: string;
  let sickId: string;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "s9cn");
    other = await seedTestData(app, "s9cn2");

    // A MANAGER user in `data`'s tenant — seedTestData only provisions ADMIN + EMPLOYEE.
    const s = "s9cn-mgr-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const managerUser = await app.prisma.user.create({
      data: {
        email: `mgr-${s}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "MANAGER",
        isActive: true,
      },
    });
    await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: managerUser.id,
        employeeNumber: `MGR-${s}`,
        firstName: "Manager",
        lastName: "Test",
        hireDate: new Date("2024-01-01"),
      },
    });
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: `mgr-${s}@test.de`, password: "test1234" },
    });
    managerToken = JSON.parse(loginRes.body).accessToken as string;

    // One § 9 credit, created by the admin approving the SICK request — the admin is
    // therefore the "actor" the manager-notification fan-out must exclude (Test 2).
    const vac = await app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: { type: "VACATION", startDate: "2031-02-03", endDate: "2031-02-07" },
    });
    expect(vac.statusCode).toBe(201);
    vacId = JSON.parse(vac.body).id as string;
    const vacApprove = await app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${vacId}/review`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { status: "APPROVED" },
    });
    expect(vacApprove.statusCode).toBe(200);

    const sick = await app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: { type: "SICK", startDate: "2031-02-05", endDate: "2031-02-06" },
    });
    expect(sick.statusCode).toBe(201);
    sickId = JSON.parse(sick.body).id as string;
    const sickApprove = await app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${sickId}/review`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { status: "APPROVED" },
    });
    expect(sickApprove.statusCode).toBe(200);

    const credit = await app.prisma.section9Credit.findFirstOrThrow({
      where: { sickRequestId: sickId },
    });
    creditId = credit.id;
  });

  afterAll(async () => {
    try {
      await app.prisma.section9Credit.deleteMany({ where: { employeeId: data.employee.id } });
      await cleanupTestData(app, data.tenant.id);
      await cleanupTestData(app, other.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
  });

  it("Test 1: creates one in-app notification to the employee, type SECTION9_AU_PENDING_EMPLOYEE", async () => {
    const notes = await app.prisma.notification.findMany({
      where: {
        userId: data.empUser.id,
        type: "SECTION9_AU_PENDING_EMPLOYEE",
        relatedType: "Section9Credit",
        relatedId: creditId,
      },
    });
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toContain("AU nachreichen");
    expect(notes[0].message).toContain("Urlaubstage");
  });

  it("Test 2: notifies every MANAGER/ADMIN in the tenant except the acting approver", async () => {
    const managerNotes = await app.prisma.notification.findMany({
      where: {
        type: "SECTION9_AU_PENDING_MANAGER",
        relatedType: "Section9Credit",
        relatedId: creditId,
      },
    });
    // Only the newly created MANAGER — the admin approved the request and must be excluded.
    expect(managerNotes.map((n) => n.userId)).toEqual([expect.any(String)]);
    expect(managerNotes.some((n) => n.userId === data.adminUser.id)).toBe(false);
    // Phase 104 review WR-05: the fan-out filter used `tenantId: employeeUser?.tenantId`.
    // In Prisma an undefined filter value means "omit this filter" — a missing employee row
    // would have broadcast this sickness period (and a deep link) to EVERY ADMIN/MANAGER in
    // EVERY tenant. Pin the tenant scope explicitly.
    expect(managerNotes.some((n) => n.userId === other.adminUser.id)).toBe(false);
  });

  // Phase 104 follow-up (owner-reported, not in REVIEW.md): both § 9 notification bodies
  // rendered dates ISO-style ("2031-02-05 – 2031-02-06") while everything else user-facing in
  // this app uses German DD.MM.YYYY. Verified live in the bell before the fix.
  it("Test 2b: the notification texts render dates German (DD.MM.YYYY), never ISO", async () => {
    const notes = await app.prisma.notification.findMany({
      where: { relatedType: "Section9Credit", relatedId: creditId },
    });
    expect(notes.length).toBeGreaterThanOrEqual(2); // employee + at least one manager
    for (const n of notes) {
      expect(n.message).toContain("05.02.2031 – 06.02.2031");
      expect(n.message).not.toContain("2031-02-05");
    }
  });

  it("Test 3: GET /section9?status=AU_PENDING returns the tenant's open cases for a MANAGER", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/leave/section9?status=AU_PENDING",
      headers: { authorization: `Bearer ${managerToken}` },
    });
    expect(res.statusCode).toBe(200);
    const rows = JSON.parse(res.body) as Array<{
      id: string;
      employeeName: string;
      overlapStart: string;
      overlapEnd: string;
      sickRequest: { id: string };
      vacationRequest: { id: string };
    }>;
    const row = rows.find((r) => r.id === creditId);
    expect(row).toBeDefined();
    expect(row!.employeeName).toBe(`${data.employee.firstName} ${data.employee.lastName}`);
    expect(row!.sickRequest.id).toBe(sickId);
    expect(row!.vacationRequest.id).toBe(vacId);
    expect(row!.overlapStart).toBe("2031-02-05");
    expect(row!.overlapEnd).toBe("2031-02-06");
  });

  // Phase 104 code review WR-04: `status` was cast into the Prisma where clause with
  // `status as never` and never validated, so any value outside the enum made Prisma throw
  // a PrismaClientValidationError → global handler → 500 echoing the full Prisma text
  // (model name, field list, expected enum members) back to the caller.
  it("Test 3b (WR-04): an unknown ?status= is a 400 Validierungsfehler, never a 500 leaking Prisma internals", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/leave/section9?status=bogus",
      headers: { authorization: `Bearer ${managerToken}` },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe("Validierungsfehler");
    // No Prisma internals anywhere in the response.
    expect(res.body).not.toContain("Section9Credit");
    expect(res.body).not.toContain("prisma");
    expect(res.body).not.toContain("Invalid `");
  });

  it("Test 4: an EMPLOYEE calling GET /section9 receives only their own cases", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/leave/section9",
      headers: { authorization: `Bearer ${data.empToken}` },
    });
    expect(res.statusCode).toBe(200);
    const rows = JSON.parse(res.body) as Array<{ employeeId: string }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.employeeId === data.employee.id)).toBe(true);
  });

  it("Test 5: a MANAGER from another tenant receives an empty list — never another tenant's rows", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/leave/section9",
      headers: { authorization: `Bearer ${other.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const rows = JSON.parse(res.body) as Array<unknown>;
    expect(rows).toEqual([]);
  });

  it("Test 6: requesting a single case by id from another tenant returns 404 + CROSS_TENANT_ACCESS_DENIED audit", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/leave/section9/${creditId}`,
      headers: { authorization: `Bearer ${other.adminToken}` },
    });
    expect(res.statusCode).toBe(404);

    const audit = await app.prisma.auditLog.findFirst({
      where: {
        action: "CROSS_TENANT_ACCESS_DENIED",
        entity: "Section9Credit",
        entityId: creditId,
      },
    });
    expect(audit).not.toBeNull();
  });
});

describe("confirm — Phase 104-06 Task 1", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "s9cf");
  });

  afterAll(async () => {
    try {
      await app.prisma.section9Credit.deleteMany({ where: { employeeId: data.employee.id } });
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
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

  async function getEntitlement(year: number) {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/leave/entitlements/${data.employee.id}?year=${year}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    const rows = JSON.parse(res.body) as Array<{ leaveType?: { name: string }; usedDays?: number }>;
    return rows.find((r) => r.leaveType?.name === "Urlaub");
  }

  async function confirmCredit(id: string, body: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: `/api/v1/leave/section9/${id}/confirm`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: body,
    });
  }

  async function creditFor(sickId: string) {
    return app.prisma.section9Credit.findFirstOrThrow({ where: { sickRequestId: sickId } });
  }

  async function vacAndSick(vacRange: [string, string], sickRange: [string, string]) {
    const vac = await createRequest({
      type: "VACATION",
      startDate: vacRange[0],
      endDate: vacRange[1],
    });
    expect(vac.statusCode).toBe(201);
    const vacId = JSON.parse(vac.body).id as string;
    expect((await approve(vacId)).statusCode).toBe(200);

    const sick = await createRequest({
      type: "SICK",
      startDate: sickRange[0],
      endDate: sickRange[1],
    });
    expect(sick.statusCode).toBe(201);
    const sickId = JSON.parse(sick.body).id as string;
    expect((await approve(sickId)).statusCode).toBe(200);

    return { vacId, sickId };
  }

  let test1CreditId: string;

  it("Test 1: full overlap — creditedDays 5, usedDays decreases by 5, vacation stays APPROVED unchanged", async () => {
    const { vacId, sickId } = await vacAndSick(
      ["2026-02-02", "2026-02-06"],
      ["2026-02-02", "2026-02-06"],
    );
    // usedDays AFTER the vacation approval (i.e. right before confirming the credit) — the
    // confirm's effect is relative to this booked state, not to the state before the
    // vacation request existed at all.
    const before = await getEntitlement(2026);
    const usedBefore = Number(before?.usedDays ?? 0);

    const credit = await creditFor(sickId);
    test1CreditId = credit.id;

    const res = await confirmCredit(credit.id, {
      attestSource: "EAU",
      attestValidFrom: "2026-02-02",
      attestValidTo: "2026-02-06",
      reason: "AU vollständig für die gesamte Woche eingereicht",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { creditedDays: number; status: string };
    expect(body.creditedDays).toBe(5);
    expect(body.status).toBe("CONFIRMED");

    const after = await getEntitlement(2026);
    expect(Number(after?.usedDays ?? 0)).toBe(usedBefore - 5);

    const vacationRow = await app.prisma.leaveRequest.findUniqueOrThrow({ where: { id: vacId } });
    expect(vacationRow.status).toBe("APPROVED");
    expect(Number(vacationRow.days)).toBe(5);
  });

  it("Test 2 (D-07 partial AU): AU valid only Wed–Thu of a Mon–Fri overlap credits exactly 2", async () => {
    const { sickId } = await vacAndSick(["2026-02-09", "2026-02-13"], ["2026-02-09", "2026-02-13"]);
    const before = await getEntitlement(2026);
    const usedBefore = Number(before?.usedDays ?? 0);

    const credit = await creditFor(sickId);

    const res = await confirmCredit(credit.id, {
      attestSource: "PAPIER",
      attestValidFrom: "2026-02-11",
      attestValidTo: "2026-02-12",
      reason: "AU deckt nur Mittwoch/Donnerstag ab",
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).creditedDays).toBe(2);

    const after = await getEntitlement(2026);
    expect(Number(after?.usedDays ?? 0)).toBe(usedBefore - 2);
  });

  it("Test 3: an AU wider than the overlap is clamped to the overlap, not the wider AU range", async () => {
    const { sickId } = await vacAndSick(["2026-02-18", "2026-02-19"], ["2026-02-18", "2026-02-19"]);
    const before = await getEntitlement(2026);
    const usedBefore = Number(before?.usedDays ?? 0);

    const credit = await creditFor(sickId);

    // AU valid the whole preceding week too — a certificate cannot return days that were
    // never vacation.
    const res = await confirmCredit(credit.id, {
      attestSource: "EAU",
      attestValidFrom: "2026-02-09",
      attestValidTo: "2026-02-19",
      reason: "AU deckt auch die Vorwoche ab, aber nur Mi/Do waren Urlaub",
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).creditedDays).toBe(2);

    const after = await getEntitlement(2026);
    expect(Number(after?.usedDays ?? 0)).toBe(usedBefore - 2);
  });

  it("Test 4 (D-08): half-day vacation overlapped by full-day sickness credits exactly 0.5", async () => {
    const vac = await createRequest({
      type: "VACATION",
      startDate: "2026-02-25",
      endDate: "2026-02-25",
      halfDay: true,
    });
    expect(vac.statusCode).toBe(201);
    const vacId = JSON.parse(vac.body).id as string;
    expect((await approve(vacId)).statusCode).toBe(200);

    const sick = await createRequest({
      type: "SICK",
      startDate: "2026-02-25",
      endDate: "2026-02-26",
    });
    expect(sick.statusCode).toBe(201);
    const sickId = JSON.parse(sick.body).id as string;
    expect((await approve(sickId)).statusCode).toBe(200);

    const credit = await creditFor(sickId);
    const res = await confirmCredit(credit.id, {
      attestSource: "EAU",
      attestValidFrom: "2026-02-25",
      attestValidTo: "2026-02-26",
      reason: "AU für den halben Urlaubstag und den Folgetag",
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).creditedDays).toBe(0.5);
  });

  it("Test 5 (D-13 ordering): confirming while the sick request is still PENDING returns 409, no entitlement change", async () => {
    const vac = await createRequest({
      type: "VACATION",
      startDate: "2026-03-23",
      endDate: "2026-03-23",
    });
    expect(vac.statusCode).toBe(201);
    const vacId = JSON.parse(vac.body).id as string;
    expect((await approve(vacId)).statusCode).toBe(200);

    const sick = await createRequest({
      type: "SICK",
      startDate: "2026-03-23",
      endDate: "2026-03-23",
    });
    expect(sick.statusCode).toBe(201);
    const sickId = JSON.parse(sick.body).id as string;
    // deliberately NOT approved — no auto-detected credit exists yet (D-13). Manually create
    // one, mirroring 104-05 Test 5's technique, to exercise the confirm-time D-13 guard directly.
    const credit = await app.prisma.section9Credit.create({
      data: {
        employeeId: data.employee.id,
        sickRequestId: sickId,
        vacationRequestId: vacId,
        overlapStart: new Date("2026-03-23"),
        overlapEnd: new Date("2026-03-23"),
      },
    });

    const before = await getEntitlement(2026);

    const res = await confirmCredit(credit.id, {
      attestSource: "EAU",
      attestValidFrom: "2026-03-23",
      attestValidTo: "2026-03-23",
      reason: "sollte abgelehnt werden, da Krankmeldung noch PENDING ist",
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toContain("genehmigt");

    const after = await getEntitlement(2026);
    expect(Number(after?.usedDays ?? 0)).toBe(Number(before?.usedDays ?? 0));
  });

  it("Test 6 (D-12 no four-eyes): the same manager who approved the sick request can confirm — no 403", async () => {
    const { sickId } = await vacAndSick(["2026-03-02", "2026-03-02"], ["2026-03-02", "2026-03-02"]);
    const credit = await creditFor(sickId);

    // data.adminToken approved BOTH the vacation and the sick request above, and confirms here too.
    const res = await confirmCredit(credit.id, {
      attestSource: "EAU",
      attestValidFrom: "2026-03-02",
      attestValidTo: "2026-03-02",
      reason: "gleicher Manager bestätigt die AU — kein Vier-Augen-Prinzip",
    });
    expect(res.statusCode).toBe(200);
    expect(res.statusCode).not.toBe(403);
  });

  // Phase 104 code review WR-01: the confirm handler guarded credit.status and
  // sickRequest.status but never vacationRequest.status. The credit is detected at
  // SICK-approval time, when the vacation was APPROVED; between then and the confirm the
  // vacation can be cancelled — and the cancel path already gives the days back. Confirming
  // afterwards ran reverseVacationDays() a SECOND time (double credit) and booked a § 9
  // credit against a vacation that legally no longer exists.
  it("Test 6b (WR-01): confirming a credit whose vacation is no longer APPROVED returns 409 and books nothing", async () => {
    const { vacId, sickId } = await vacAndSick(
      ["2026-05-11", "2026-05-13"],
      ["2026-05-11", "2026-05-13"],
    );
    const credit = await creditFor(sickId);

    const confirmBody = {
      attestSource: "EAU" as const,
      attestValidFrom: "2026-05-11",
      attestValidTo: "2026-05-13",
      reason: "AU liegt vor, der Urlaub ist aber zwischenzeitlich storniert worden",
    };

    // CANCELLATION_REQUESTED: the leave is still active today, but approving that
    // cancellation later would decrement the same days a second time.
    // CANCELLED: the days are already back — a second reverseVacationDays() would
    // over-credit outright.
    for (const blockedStatus of ["CANCELLATION_REQUESTED", "CANCELLED"] as const) {
      await app.prisma.leaveRequest.update({
        where: { id: vacId },
        data: { status: blockedStatus },
      });

      // Read the baseline WITH the vacation already in the blocked state — selfHealUsedDays
      // recomputes usedDays on every entitlement read, so a baseline taken while the request
      // was still APPROVED would measure the cancellation, not the confirm attempt.
      const before = await getEntitlement(2026);

      const res = await confirmCredit(credit.id, confirmBody);
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).error).toContain("nicht mehr genehmigt");

      // Nothing booked, and the credit itself stays AU_PENDING.
      const after = await getEntitlement(2026);
      expect(Number(after?.usedDays ?? 0)).toBe(Number(before?.usedDays ?? 0));
      const row = await app.prisma.section9Credit.findUniqueOrThrow({ where: { id: credit.id } });
      expect(row.status).toBe("AU_PENDING");
    }

    // Restored to APPROVED, the very same call succeeds — the guard blocks exactly the
    // cancelled states and nothing else.
    await app.prisma.leaveRequest.update({ where: { id: vacId }, data: { status: "APPROVED" } });
    const usedBefore = Number((await getEntitlement(2026))?.usedDays ?? 0);
    const ok = await confirmCredit(credit.id, confirmBody);
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body).creditedDays).toBe(3);
    expect(Number((await getEntitlement(2026))?.usedDays ?? 0)).toBe(usedBefore - 3);
  });

  it("Test 7 (D-27): attestSource accepts only EAU/PAPIER; reason is mandatory (missing OR null)", async () => {
    const { sickId } = await vacAndSick(["2026-03-09", "2026-03-09"], ["2026-03-09", "2026-03-09"]);
    const credit = await creditFor(sickId);

    const badSource = await confirmCredit(credit.id, {
      attestSource: "SONSTIGES",
      attestValidFrom: "2026-03-09",
      attestValidTo: "2026-03-09",
      reason: "gültiger Grund",
    });
    expect(badSource.statusCode).toBe(400);

    const missingReason = await confirmCredit(credit.id, {
      attestSource: "EAU",
      attestValidFrom: "2026-03-09",
      attestValidTo: "2026-03-09",
    });
    expect(missingReason.statusCode).toBe(400);

    // The Zod gotcha (CLAUDE.md): the frontend sends an explicit `null` for an omitted field.
    const nullReason = await confirmCredit(credit.id, {
      attestSource: "EAU",
      attestValidFrom: "2026-03-09",
      attestValidTo: "2026-03-09",
      reason: null,
    });
    expect(nullReason.statusCode).toBe(400);

    // None of the invalid attempts confirmed the credit.
    const stillPending = await app.prisma.section9Credit.findUniqueOrThrow({
      where: { id: credit.id },
    });
    expect(stillPending.status).toBe("AU_PENDING");
  });

  it("Test 8 (R9 / D-19): confirming into an origin year whose Stichtag has passed sets carryOverReason=ILLNESS with the extended deadline", async () => {
    // 2024: seed a real LeaveEntitlement row so recalculateCarryOver's `prev` lookup (it
    // reads year-1 to compute year's carriedOverDays/deadline) has something to find — without
    // it, recalculateCarryOver(..., 2025) silently no-ops and no row 2025 is ever created.
    await app.prisma.leaveEntitlement.create({
      data: {
        employeeId: data.employee.id,
        leaveTypeId: data.vacationType.id,
        year: 2024,
        totalDays: 30,
        usedDays: 0,
      },
    });
    const { sickId } = await vacAndSick(["2024-09-02", "2024-09-06"], ["2024-09-02", "2024-09-06"]);
    const credit = await creditFor(sickId);

    const res = await confirmCredit(credit.id, {
      attestSource: "EAU",
      attestValidFrom: "2024-09-02",
      attestValidTo: "2024-09-06",
      reason: "AU für die gesamte Woche 2024, Übertragsfrist längst abgelaufen",
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).creditedDays).toBe(5);

    // originYear (2024) + 1 = 2025 — the row recalculateCarryOver just wrote/recomputed for
    // year 2025 has carryOverDeadline = 2025-03-31 (tenant default), which by "now" (this
    // test suite runs no earlier than 2026) has already passed — the R9 branch must fire.
    const carryRow = await app.prisma.leaveEntitlement.findUniqueOrThrow({
      where: {
        employeeId_leaveTypeId_year: {
          employeeId: data.employee.id,
          leaveTypeId: data.vacationType.id,
          year: 2025,
        },
      },
    });
    expect(carryRow.carryOverReason).toBe("ILLNESS");
    // Phase 104 review WR-09: the § 9 path now builds this deadline in UTC (Date.UTC), so the
    // expectation is pinned in UTC too. Previously both sides used the local-time constructor,
    // which is identical only because the containers run TZ=UTC — the assertion silently
    // depended on the runner's timezone. 15 Monate nach Ende des Ursprungsjahres 2024.
    expect(carryRow.carryOverDeadline?.toISOString()).toBe(
      new Date(Date.UTC(2026, 2, 31, 23, 59, 59)).toISOString(),
    );
    expect(carryRow.carryOverNote).toContain("§ 9 BUrlG");
    expect(carryRow.carryOverNote).toContain("C-214/10");
  });

  it("Test 9 (R9 negative): confirming into an origin year whose Stichtag has NOT passed leaves carryOverReason null at the tenant default", async () => {
    const { sickId } = await vacAndSick(["2026-03-16", "2026-03-16"], ["2026-03-16", "2026-03-16"]);
    const credit = await creditFor(sickId);

    const res = await confirmCredit(credit.id, {
      attestSource: "EAU",
      attestValidFrom: "2026-03-16",
      attestValidTo: "2026-03-16",
      reason: "AU für 2026, Übertragsfrist für 2027 noch nicht abgelaufen",
    });
    expect(res.statusCode).toBe(200);

    // originYear (2026) + 1 = 2027 — its Stichtag (2027-03-31) has NOT passed relative to
    // any realistic test-execution date, so the ILLNESS override must not fire.
    const carryRow = await app.prisma.leaveEntitlement.findUniqueOrThrow({
      where: {
        employeeId_leaveTypeId_year: {
          employeeId: data.employee.id,
          leaveTypeId: data.vacationType.id,
          year: 2027,
        },
      },
    });
    expect(carryRow.carryOverReason).toBeNull();
    expect(carryRow.carryOverDeadline?.toISOString()).toBe(
      new Date(2027, 2, 31, 23, 59, 59).toISOString(),
    );
  });

  it("Test 10 (D-17): the SECTION9_CREDIT_CONFIRMED audit row carries both request ids, the credited range, creditedDays, attestSource and the reason", async () => {
    const audit = await app.prisma.auditLog.findFirst({
      where: {
        action: "SECTION9_CREDIT_CONFIRMED",
        entity: "Section9Credit",
        entityId: test1CreditId,
      },
    });
    expect(audit).not.toBeNull();
    const newValue = audit!.newValue as {
      sickRequestId: string;
      vacationRequestId: string;
      creditedStart: string;
      creditedEnd: string;
      creditedDays: number;
      attestSource: string;
      reason: string;
      note: string;
    };
    const credit = await app.prisma.section9Credit.findUniqueOrThrow({
      where: { id: test1CreditId },
    });
    expect(newValue.sickRequestId).toBe(credit.sickRequestId);
    expect(newValue.vacationRequestId).toBe(credit.vacationRequestId);
    expect(newValue.creditedStart).toBe("2026-02-02");
    expect(newValue.creditedEnd).toBe("2026-02-06");
    expect(newValue.creditedDays).toBe(5);
    expect(newValue.attestSource).toBe("EAU");
    expect(newValue.reason).toBe("AU vollständig für die gesamte Woche eingereicht");
    expect(newValue.note).toBe("§ 9 BUrlG, nicht angerechnet");
  });

  it("Test 11 (idempotence): confirming an already-CONFIRMED credit returns 409 and does not credit twice", async () => {
    const before = await getEntitlement(2026);

    const res = await confirmCredit(test1CreditId, {
      attestSource: "EAU",
      attestValidFrom: "2026-02-02",
      attestValidTo: "2026-02-06",
      reason: "erneuter Versuch, sollte 409 liefern",
    });
    expect(res.statusCode).toBe(409);

    const after = await getEntitlement(2026);
    expect(Number(after?.usedDays ?? 0)).toBe(Number(before?.usedDays ?? 0));
  });

  it("Test 12 (cross-year half-day refusal): a half-day vacation whose credited range crosses a year boundary is refused with 400", async () => {
    const sickType = await app.prisma.leaveType.findFirstOrThrow({
      where: { tenantId: data.tenant.id, name: "Krankmeldung" },
    });

    const vac = await app.prisma.leaveRequest.create({
      data: {
        employeeId: data.employee.id,
        leaveTypeId: data.vacationType.id,
        startDate: new Date("2026-12-28"),
        endDate: new Date("2027-01-02"),
        days: 0.5,
        halfDay: true,
        status: "APPROVED",
      },
    });
    const sick = await app.prisma.leaveRequest.create({
      data: {
        employeeId: data.employee.id,
        leaveTypeId: sickType.id,
        startDate: new Date("2026-12-30"),
        endDate: new Date("2027-01-01"),
        days: 3,
        status: "APPROVED",
      },
    });
    const credit = await app.prisma.section9Credit.create({
      data: {
        employeeId: data.employee.id,
        sickRequestId: sick.id,
        vacationRequestId: vac.id,
        overlapStart: new Date("2026-12-30"),
        overlapEnd: new Date("2027-01-01"),
      },
    });

    const res = await confirmCredit(credit.id, {
      attestSource: "EAU",
      attestValidFrom: "2026-12-30",
      attestValidTo: "2027-01-01",
      reason: "sollte wegen Jahreswechsel bei Halbtags-Urlaub abgelehnt werden",
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("Jahreswechsel");

    const stillPending = await app.prisma.section9Credit.findUniqueOrThrow({
      where: { id: credit.id },
    });
    expect(stillPending.status).toBe("AU_PENDING");
  });

  // Phase 104 code review IN-05: reverseVacationDays books via updateMany, which affects 0
  // rows when no LeaveEntitlement exists for the target year (e.g. an origin year predating
  // the employee's first entitlement row) — and selfHealUsedDays never creates the missing
  // row either. The handler still answered 200 { status: "CONFIRMED", creditedDays } and
  // notified "+N Tage gutgeschrieben" although nothing was credited anywhere.
  it("Test 13 (IN-05): confirming into a year without a LeaveEntitlement row is refused with 409, not silently booked", async () => {
    const sickType = await app.prisma.leaveType.findFirstOrThrow({
      where: { tenantId: data.tenant.id, name: "Krankmeldung" },
    });

    // 2029 deliberately has no entitlement row for this employee.
    const noRow = await app.prisma.leaveEntitlement.findUnique({
      where: {
        employeeId_leaveTypeId_year: {
          employeeId: data.employee.id,
          leaveTypeId: data.vacationType.id,
          year: 2029,
        },
      },
    });
    expect(noRow).toBeNull();

    const vac = await app.prisma.leaveRequest.create({
      data: {
        employeeId: data.employee.id,
        leaveTypeId: data.vacationType.id,
        startDate: new Date("2029-03-05"), // Monday
        endDate: new Date("2029-03-07"), // Wednesday
        days: 3,
        status: "APPROVED",
      },
    });
    const sick = await app.prisma.leaveRequest.create({
      data: {
        employeeId: data.employee.id,
        leaveTypeId: sickType.id,
        startDate: new Date("2029-03-05"),
        endDate: new Date("2029-03-07"),
        days: 3,
        status: "APPROVED",
      },
    });
    const credit = await app.prisma.section9Credit.create({
      data: {
        employeeId: data.employee.id,
        sickRequestId: sick.id,
        vacationRequestId: vac.id,
        overlapStart: new Date("2029-03-05"),
        overlapEnd: new Date("2029-03-07"),
      },
    });

    const res = await confirmCredit(credit.id, {
      attestSource: "EAU",
      attestValidFrom: "2029-03-05",
      attestValidTo: "2029-03-07",
      reason: "AU liegt vor, aber für 2029 existiert kein Urlaubsanspruch",
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toContain("2029");

    // The whole transaction rolled back: the Vorgang is still open and re-confirmable once
    // the Urlaubsanspruch exists, and no entitlement row was conjured up.
    const stillOpen = await app.prisma.section9Credit.findUniqueOrThrow({
      where: { id: credit.id },
    });
    expect(stillOpen.status).toBe("AU_PENDING");
    expect(stillOpen.creditedDays).toBeNull();
    expect(stillOpen.reviewedAt).toBeNull();
  });
});

describe("reject and reopen — Phase 104-06 Task 2", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "s9rr");
  });

  afterAll(async () => {
    try {
      await app.prisma.section9Credit.deleteMany({ where: { employeeId: data.employee.id } });
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
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

  async function getEntitlement(year: number) {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/leave/entitlements/${data.employee.id}?year=${year}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    const rows = JSON.parse(res.body) as Array<{ leaveType?: { name: string }; usedDays?: number }>;
    return rows.find((r) => r.leaveType?.name === "Urlaub");
  }

  async function reject(id: string, body: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: `/api/v1/leave/section9/${id}/reject`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: body,
    });
  }

  async function reopen(id: string) {
    return app.inject({
      method: "POST",
      url: `/api/v1/leave/section9/${id}/reopen`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {},
    });
  }

  async function confirmCredit(id: string, body: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: `/api/v1/leave/section9/${id}/confirm`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: body,
    });
  }

  async function vacAndSick(dateStr: string) {
    const vac = await createRequest({ type: "VACATION", startDate: dateStr, endDate: dateStr });
    expect(vac.statusCode).toBe(201);
    const vacId = JSON.parse(vac.body).id as string;
    expect((await approve(vacId)).statusCode).toBe(200);

    const sick = await createRequest({ type: "SICK", startDate: dateStr, endDate: dateStr });
    expect(sick.statusCode).toBe(201);
    const sickId = JSON.parse(sick.body).id as string;
    expect((await approve(sickId)).statusCode).toBe(200);

    const credit = await app.prisma.section9Credit.findFirstOrThrow({
      where: { sickRequestId: sickId },
    });
    return { vacId, sickId, creditId: credit.id };
  }

  it("Test 1: rejecting sets status REJECTED, stores the reason, sets reviewedBy/reviewedAt, leaves usedDays unchanged", async () => {
    const { creditId } = await vacAndSick("2026-04-13");
    const before = await getEntitlement(2026);
    const usedBefore = Number(before?.usedDays ?? 0);

    const res = await reject(creditId, { reason: "Keine AU eingereicht" });
    expect(res.statusCode).toBe(200);

    const row = await app.prisma.section9Credit.findUniqueOrThrow({ where: { id: creditId } });
    expect(row.status).toBe("REJECTED");
    expect(row.reason).toBe("Keine AU eingereicht");
    expect(row.reviewedBy).toBe(data.adminUser.id);
    expect(row.reviewedAt).not.toBeNull();

    const after = await getEntitlement(2026);
    expect(Number(after?.usedDays ?? 0)).toBe(usedBefore);
  });

  it("Test 2: rejecting without a reason, or with reason: null, returns 400", async () => {
    const { creditId } = await vacAndSick("2026-04-20");

    const missing = await reject(creditId, {});
    expect(missing.statusCode).toBe(400);

    // The Zod gotcha (CLAUDE.md): the frontend sends an explicit `null` for an omitted field.
    const nullReason = await reject(creditId, { reason: null });
    expect(nullReason.statusCode).toBe(400);

    // Phase 104 follow-up (owner-reported): min(1) alone only covered the EMPTY-string case.
    // An explicit null fell through to Zod's ENGLISH default invalid_type text
    // ("reason: Invalid input: expected string, received null") — the same mistake was
    // reported in two different languages depending on how the field was cleared. All three
    // spellings must answer with the identical German sentence, and reason stays MANDATORY
    // (D-11) — never .optional(), never .nullable().
    const empty = await reject(creditId, { reason: "" });
    expect(empty.statusCode).toBe(400);
    const germanMessage = "reason: Begründung ist erforderlich";
    for (const res of [missing, nullReason, empty]) {
      const body = JSON.parse(res.body) as { error: string; message: string };
      expect(body.error).toBe("Validierungsfehler");
      expect(body.message).toBe(germanMessage);
      expect(body.message).not.toContain("Invalid input");
      expect(body.message).not.toContain("expected string");
    }

    const row = await app.prisma.section9Credit.findUniqueOrThrow({ where: { id: creditId } });
    expect(row.status).toBe("AU_PENDING");
  });

  it("Test 3 + 4: a REJECTED credit can be re-opened and confirmed, applying in full, with a reconstructible audit sequence", async () => {
    const { creditId } = await vacAndSick("2026-04-27");
    const before = await getEntitlement(2026);
    const usedBefore = Number(before?.usedDays ?? 0);

    expect((await reject(creditId, { reason: "AU fehlt noch" })).statusCode).toBe(200);

    const reopenRes = await reopen(creditId);
    expect(reopenRes.statusCode).toBe(200);
    const reopened = await app.prisma.section9Credit.findUniqueOrThrow({ where: { id: creditId } });
    expect(reopened.status).toBe("AU_PENDING");
    // Reason stays on the row (Revisionssicherheit) — the earlier rejection's justification
    // is not overwritten by the reopen.
    expect(reopened.reason).toBe("AU fehlt noch");
    expect(reopened.reviewedBy).toBeNull();
    expect(reopened.reviewedAt).toBeNull();

    const confirmRes = await confirmCredit(creditId, {
      attestSource: "EAU",
      attestValidFrom: "2026-04-27",
      attestValidTo: "2026-04-27",
      reason: "AU jetzt nachgereicht",
    });
    expect(confirmRes.statusCode).toBe(200);
    expect(JSON.parse(confirmRes.body).creditedDays).toBe(1);

    const after = await getEntitlement(2026);
    expect(Number(after?.usedDays ?? 0)).toBe(usedBefore - 1);

    // Test 4: the full detected → rejected → reopened → confirmed sequence is reconstructible.
    const audits = await app.prisma.auditLog.findMany({
      where: { entity: "Section9Credit", entityId: creditId },
      orderBy: { createdAt: "asc" },
    });
    expect(audits.map((a) => a.action)).toEqual([
      "SECTION9_CREDIT_DETECTED",
      "SECTION9_CREDIT_REJECTED",
      "SECTION9_CREDIT_REOPENED",
      "SECTION9_CREDIT_CONFIRMED",
    ]);
  });

  it("Test 5 (D-11): rejecting a CONFIRMED credit returns 409 — a booked credit cannot be rejected away", async () => {
    const { creditId } = await vacAndSick("2026-05-04");
    expect(
      (
        await confirmCredit(creditId, {
          attestSource: "EAU",
          attestValidFrom: "2026-05-04",
          attestValidTo: "2026-05-04",
          reason: "AU liegt vor",
        })
      ).statusCode,
    ).toBe(200);

    const res = await reject(creditId, { reason: "zu spät" });
    expect(res.statusCode).toBe(409);

    const row = await app.prisma.section9Credit.findUniqueOrThrow({ where: { id: creditId } });
    expect(row.status).toBe("CONFIRMED");
  });

  it("Test 6 (D-10): no scheduled job anywhere closes, expires or auto-rejects an AU_PENDING credit", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const pluginsDir = path.resolve(__dirname, "../plugins");
    const files = fs.readdirSync(pluginsDir).filter((f) => f.endsWith(".ts"));
    for (const file of files) {
      const content = fs.readFileSync(path.join(pluginsDir, file), "utf-8");
      expect(content).not.toContain("section9Credit");
    }
  });
});

describe("display surface — Phase 104-10 Task 1", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let colleagueToken: string;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "s9ds");

    // A second EMPLOYEE in the SAME tenant, neither the credit's owner nor a manager —
    // the exact viewer shape Test 3's masking check needs (showDetails === false).
    const s = "s9ds-col-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const colleagueUser = await app.prisma.user.create({
      data: {
        email: `col-${s}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: colleagueUser.id,
        employeeNumber: `COL-${s}`,
        firstName: "Kolleg",
        lastName: "Test",
        hireDate: new Date("2024-01-01"),
      },
    });
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: `col-${s}@test.de`, password: "test1234" },
    });
    colleagueToken = JSON.parse(loginRes.body).accessToken as string;

    // Phase 104 review IN-05 (deliberate fixture change, not a relaxed assertion): the confirm
    // path now REFUSES to book a credit into a year that has no LeaveEntitlement row, instead
    // of decrementing nothing and reporting success anyway. This suite's fixtures live in 2033
    // 2033, which seedTestData does not provision — so before the fix these confirms were
    // silently booking into thin air. Provision the row so the display assertions run against
    // a state that is actually bookable. (2036 is provisioned by Test 5 itself, which already
    // discovered the same fixture requirement.)
    await app.prisma.leaveEntitlement.create({
      data: {
        employeeId: data.employee.id,
        leaveTypeId: data.vacationType.id,
        year: 2033,
        totalDays: 30,
        usedDays: 0,
      },
    });
  });

  afterAll(async () => {
    try {
      await app.prisma.section9Credit.deleteMany({ where: { employeeId: data.employee.id } });
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
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

  async function confirmCredit(id: string, body: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: `/api/v1/leave/section9/${id}/confirm`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: body,
    });
  }

  async function calendar(year: number, month: number, token: string) {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/leave/calendar?year=${year}&month=${month}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body) as Array<{
      id: string;
      typeCode: string | null;
      section9?: string | null;
      section9Days?: string[];
    }>;
  }

  async function vacAndSick(vacRange: [string, string], sickRange: [string, string]) {
    const vac = await createRequest({
      type: "VACATION",
      startDate: vacRange[0],
      endDate: vacRange[1],
    });
    expect(vac.statusCode).toBe(201);
    const vacId = JSON.parse(vac.body).id as string;
    expect((await approve(vacId)).statusCode).toBe(200);

    const sick = await createRequest({
      type: "SICK",
      startDate: sickRange[0],
      endDate: sickRange[1],
    });
    expect(sick.statusCode).toBe(201);
    const sickId = JSON.parse(sick.body).id as string;
    expect((await approve(sickId)).statusCode).toBe(200);

    const credit = await app.prisma.section9Credit.findFirstOrThrow({
      where: { sickRequestId: sickId },
    });
    return { vacId, sickId, creditId: credit.id };
  }

  it("Test 1: a CONFIRMED credit marks the SICK entry section9=CONFIRMED and the VACATION entry section9=SUPERSEDED", async () => {
    const { vacId, sickId, creditId } = await vacAndSick(
      ["2033-03-02", "2033-03-06"],
      ["2033-03-03", "2033-03-04"],
    );
    expect(
      (
        await confirmCredit(creditId, {
          attestSource: "EAU",
          attestValidFrom: "2033-03-03",
          attestValidTo: "2033-03-04",
          reason: "AU liegt vor",
        })
      ).statusCode,
    ).toBe(200);

    const entries = await calendar(2033, 3, data.adminToken);
    const sickEntry = entries.find((e) => e.id === sickId);
    const vacEntry = entries.find((e) => e.id === vacId);
    expect(sickEntry?.section9).toBe("CONFIRMED");
    expect(sickEntry?.section9Days).toEqual(["2033-03-03", "2033-03-04"]);
    expect(vacEntry?.section9).toBe("SUPERSEDED");
  });

  it("Test 2: an AU_PENDING credit marks the SICK entry section9=AU_PENDING; the vacation entry is NOT superseded", async () => {
    const { vacId, sickId } = await vacAndSick(
      ["2033-04-04", "2033-04-08"],
      ["2033-04-05", "2033-04-06"],
    );

    const entries = await calendar(2033, 4, data.adminToken);
    const sickEntry = entries.find((e) => e.id === sickId);
    const vacEntry = entries.find((e) => e.id === vacId);
    expect(sickEntry?.section9).toBe("AU_PENDING");
    expect(sickEntry?.section9Days).toEqual(["2033-04-05", "2033-04-06"]);
    expect(vacEntry?.section9 ?? null).toBeNull();
  });

  it("Test 3: a colleague without detail visibility receives section9=null and section9Days=[] — masking mirrors typeCode", async () => {
    const { sickId } = await vacAndSick(["2033-05-02", "2033-05-06"], ["2033-05-03", "2033-05-04"]);

    const entries = await calendar(2033, 5, colleagueToken);
    const sickEntry = entries.find((e) => e.id === sickId);
    expect(sickEntry).toBeDefined();
    expect(sickEntry?.typeCode).toBeNull();
    expect(sickEntry?.section9 ?? null).toBeNull();
    expect(sickEntry?.section9Days ?? []).toEqual([]);
  });

  it("Test 4: GET /leave/requests rows carry section9Status and section9CreditId", async () => {
    const { vacId, sickId, creditId } = await vacAndSick(
      ["2033-06-06", "2033-06-10"],
      ["2033-06-07", "2033-06-08"],
    );
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/leave/requests",
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const rows = JSON.parse(res.body) as Array<{
      id: string;
      section9Status: string | null;
      section9CreditId: string | null;
    }>;
    const sickRow = rows.find((r) => r.id === sickId);
    const vacRow = rows.find((r) => r.id === vacId);
    expect(sickRow?.section9Status).toBe("AU_PENDING");
    expect(sickRow?.section9CreditId).toBe(creditId);
    expect(vacRow?.section9Status).toBe("AU_PENDING");
    expect(vacRow?.section9CreditId).toBe(creditId);
  });

  it("Test 5: GET /leave/entitlements/:employeeId returns section9Movements with creditId/days/from/to/label for a CONFIRMED credit", async () => {
    // deductVacationDays only ever `updateMany`s an EXISTING LeaveEntitlement row — it never
    // creates one — so a future year needs a pre-existing row before any request can book
    // against it (same fixture requirement 104-06's own R9-positive test discovered).
    await app.prisma.leaveEntitlement.create({
      data: {
        employeeId: data.employee.id,
        leaveTypeId: data.vacationType.id,
        year: 2036,
        totalDays: 30,
        usedDays: 0,
      },
    });
    const { creditId } = await vacAndSick(
      ["2036-04-06", "2036-04-10"],
      ["2036-04-08", "2036-04-09"],
    );
    expect(
      (
        await confirmCredit(creditId, {
          attestSource: "EAU",
          attestValidFrom: "2036-04-08",
          attestValidTo: "2036-04-09",
          reason: "AU liegt vor",
        })
      ).statusCode,
    ).toBe(200);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/leave/entitlements/${data.employee.id}?year=2036`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const rows = JSON.parse(res.body) as Array<{
      typeCode: string;
      section9Movements: Array<{
        creditId: string;
        days: number;
        from: string | null;
        to: string | null;
        label: string;
      }>;
    }>;
    const vacRow = rows.find((r) => r.typeCode === "VACATION");
    expect(vacRow?.section9Movements).toHaveLength(1);
    expect(vacRow?.section9Movements[0]).toMatchObject({
      creditId,
      days: 2,
      from: "2036-04-08",
      to: "2036-04-09",
    });
    expect(vacRow?.section9Movements[0].label).toBe(
      "+2 Tage gutgeschrieben (§ 9 BUrlG, Krankheit 08.04.–09.04.)",
    );
  });

  it("Test 6: an entitlement year with no credits returns section9Movements: [] and every other field unchanged", async () => {
    await app.prisma.leaveEntitlement.create({
      data: {
        employeeId: data.employee.id,
        leaveTypeId: data.vacationType.id,
        year: 2038,
        totalDays: 30,
        usedDays: 0,
      },
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/leave/entitlements/${data.employee.id}?year=2038`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const rows = JSON.parse(res.body) as Array<{
      typeCode: string;
      totalDays: number;
      usedDays: number;
      section9Movements: unknown[];
    }>;
    const vacRow = rows.find((r) => r.typeCode === "VACATION");
    expect(vacRow).toBeDefined();
    expect(vacRow?.section9Movements).toEqual([]);
    expect(Number(vacRow?.totalDays)).toBe(30);
    expect(Number(vacRow?.usedDays)).toBe(0);
  });

  it("Test 7: calendar and list additions cover multiple overlapping cases in one page load (bulk fetch, not per-row)", async () => {
    // Three independent § 9 cases in the SAME month — if the implementation queried per row,
    // this would still pass functionally, but a per-row implementation is exactly what the
    // static acceptance check (no `await app.prisma` inside a `.map()`) forbids; this test
    // proves the batch path produces correct, independent results for all three at once.
    const case1 = await vacAndSick(["2033-07-05", "2033-07-09"], ["2033-07-06", "2033-07-06"]);
    const case2 = await vacAndSick(["2033-07-12", "2033-07-16"], ["2033-07-13", "2033-07-13"]);
    const case3 = await vacAndSick(["2033-07-19", "2033-07-23"], ["2033-07-20", "2033-07-20"]);
    expect(
      (
        await confirmCredit(case1.creditId, {
          attestSource: "EAU",
          attestValidFrom: "2033-07-06",
          attestValidTo: "2033-07-06",
          reason: "AU liegt vor",
        })
      ).statusCode,
    ).toBe(200);

    const entries = await calendar(2033, 7, data.adminToken);
    expect(entries.find((e) => e.id === case1.sickId)?.section9).toBe("CONFIRMED");
    expect(entries.find((e) => e.id === case1.vacId)?.section9).toBe("SUPERSEDED");
    expect(entries.find((e) => e.id === case2.sickId)?.section9).toBe("AU_PENDING");
    expect(entries.find((e) => e.id === case2.vacId)?.section9 ?? null).toBeNull();
    expect(entries.find((e) => e.id === case3.sickId)?.section9).toBe("AU_PENDING");

    const listRes = await app.inject({
      method: "GET",
      url: "/api/v1/leave/requests",
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    const rows = JSON.parse(listRes.body) as Array<{ id: string; section9Status: string | null }>;
    expect(rows.find((r) => r.id === case1.sickId)?.section9Status).toBe("CONFIRMED");
    expect(rows.find((r) => r.id === case2.sickId)?.section9Status).toBe("AU_PENDING");
    expect(rows.find((r) => r.id === case3.sickId)?.section9Status).toBe("AU_PENDING");
  });
});
