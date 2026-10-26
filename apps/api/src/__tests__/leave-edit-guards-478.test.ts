import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  seedEntitlementYears,
  grantSystemRole,
} from "./setup";
import { prepareLeaveCorrection } from "../contexts/absence/leave-correction";
import { addedDayRanges } from "../contexts/absence/leave-correction";

/**
 * Issue #478 follow-up (review of PR #752): the PENDING edit and the approval share the create-side
 * guards, a pure shortening never collides, and a § 9 credit over a CANCELLATION_REQUESTED vacation
 * can be confirmed (a later approved cancellation supersedes it, #662). Dates are fixed in 2031.
 */
describe("Leave edit, approve, correct and § 9 confirm guards (Issue #478)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let secondAdminToken: string;
  const OVERLAP = "Überschneidung mit bestehendem Antrag";

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "eg478");
    await seedEntitlementYears(app, {
      employeeId: data.employee.id,
      leaveTypeId: data.vacationType.id,
      years: [2031],
    });
    const user = await app.prisma.user.create({
      data: {
        email: `second-admin-478-${Date.now().toString(36)}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `ADM478-${Date.now().toString(36)}`,
        firstName: "Zweite",
        lastName: "Freigabe",
        hireDate: new Date("2024-01-01"),
      },
    });
    await grantSystemRole(app.prisma, { tenantId: data.tenant.id, userId: user.id, role: "ADMIN" });
    secondAdminToken = app.jwt.sign({
      sub: user.id,
      tenantId: data.tenant.id,
      employeeId: employee.id,
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

  const empAuth = () => ({ authorization: `Bearer ${data.empToken}` });
  const adminAuth = () => ({ authorization: `Bearer ${data.adminToken}` });

  async function create(payload: Record<string, unknown>): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: empAuth(),
      payload,
    });
    expect(res.statusCode, res.body).toBe(201);
    return JSON.parse(res.body).id as string;
  }
  const review = (id: string, status = "APPROVED", token = adminAuth()) =>
    app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${id}/review`,
      headers: typeof token === "string" ? { authorization: `Bearer ${token}` } : token,
      payload: { status },
    });
  async function approved(type: string, startDate: string, endDate: string) {
    const id = await create({ type, startDate, endDate });
    expect((await review(id)).statusCode).toBe(200);
    return id;
  }
  const edit = (id: string, startDate: string, endDate: string) =>
    app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${id}`,
      headers: empAuth(),
      payload: { startDate, endDate, halfDay: false },
    });
  const correct = (id: string, startDate: string, endDate: string) =>
    app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${id}/correct`,
      headers: { ...adminAuth(), "user-agent": "vitest-agent/1.0" },
      payload: { reason: "Korrektur nach Rückfrage", startDate, endDate },
    });
  const setStatus = (id: string, status: "CANCELLATION_REQUESTED") =>
    app.prisma.leaveRequest.update({ where: { id }, data: { status } });
  const usedDays = async () =>
    Number(
      (
        await app.prisma.leaveEntitlement.findFirstOrThrow({
          where: { employeeId: data.employee.id, leaveTypeId: data.vacationType.id, year: 2031 },
        })
      ).usedDays,
    );

  // ── 1. § 9 confirm over CANCELLATION_REQUESTED ───────────────────────────────────────────────
  it("confirms a credit whose vacation is CANCELLATION_REQUESTED; a later approved cancellation supersedes it without a double credit", async () => {
    const usedBefore = await usedDays();
    const vacId = await approved("VACATION", "2031-03-03", "2031-03-14");
    const sickId = await approved("SICK", "2031-03-12", "2031-03-14");
    const credit = await app.prisma.section9Credit.findFirstOrThrow({
      where: { sickRequestId: sickId },
    });
    const cancel = await app.inject({
      method: "DELETE",
      url: `/api/v1/leave/requests/${vacId}`,
      headers: empAuth(),
      payload: { reason: "Urlaub entfällt" },
    });
    expect(cancel.statusCode, cancel.body).toBe(200);
    expect((await app.prisma.leaveRequest.findUniqueOrThrow({ where: { id: vacId } })).status).toBe(
      "CANCELLATION_REQUESTED",
    );

    // RED before the fix: 409 "nicht mehr genehmigt".
    const confirm = await app.inject({
      method: "POST",
      url: `/api/v1/leave/section9/${credit.id}/confirm`,
      headers: adminAuth(),
      payload: {
        attestSource: "EAU",
        attestValidFrom: "2031-03-12",
        attestValidTo: "2031-03-14",
        reason: "AU da",
      },
    });
    expect(confirm.statusCode, confirm.body).toBe(200);
    expect(await usedDays()).toBe(usedBefore + 10 - 3);

    const approveCancel = await review(vacId, "APPROVED", secondAdminToken as never);
    expect(approveCancel.statusCode, approveCancel.body).toBe(200);
    expect(
      (await app.prisma.section9Credit.findUniqueOrThrow({ where: { id: credit.id } })).status,
    ).toBe("SUPERSEDED");
    expect(await usedDays()).toBe(usedBefore); // no day credited twice
  });

  it("a credit whose vacation is CANCELLED still answers 409", async () => {
    const vacId = await approved("VACATION", "2031-04-07", "2031-04-11");
    const sickId = await approved("SICK", "2031-04-08", "2031-04-09");
    const credit = await app.prisma.section9Credit.findFirstOrThrow({
      where: { sickRequestId: sickId },
    });
    await app.prisma.leaveRequest.update({ where: { id: vacId }, data: { status: "CANCELLED" } });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/leave/section9/${credit.id}/confirm`,
      headers: adminAuth(),
      payload: {
        attestSource: "EAU",
        attestValidFrom: "2031-04-08",
        attestValidTo: "2031-04-09",
        reason: "AU da",
      },
    });
    expect(res.statusCode).toBe(409);
  });

  // ── 2. /correct only checks the days it adds ─────────────────────────────────────────────────
  it("addedDayRanges is new range minus old range", () => {
    const d = (s: string) => new Date(`${s}T00:00:00Z`);
    expect(
      addedDayRanges(d("2031-05-05"), d("2031-05-09"), d("2031-05-05"), d("2031-05-07")),
    ).toEqual([]);
    expect(
      addedDayRanges(d("2031-05-05"), d("2031-05-09"), d("2031-05-05"), d("2031-05-12")),
    ).toEqual([{ start: d("2031-05-10"), end: d("2031-05-12") }]);
    expect(
      addedDayRanges(d("2031-05-05"), d("2031-05-09"), d("2031-05-01"), d("2031-05-12")),
    ).toEqual([
      { start: d("2031-05-01"), end: d("2031-05-04") },
      { start: d("2031-05-10"), end: d("2031-05-12") },
    ]);
  });

  it("shortening a request that already sits in a stored double booking works (also through the employment-exit core); extending into the other request is refused", async () => {
    const a = await approved("VACATION", "2031-05-05", "2031-05-09");
    const b = await approved("VACATION", "2031-05-12", "2031-05-16");
    // Stored double booking, made by the old bug: B reaches back over A's kept days.
    await app.prisma.leaveRequest.update({
      where: { id: b },
      data: { startDate: new Date("2031-05-06"), status: "CANCELLATION_REQUESTED" },
    });

    const grow = await correct(a, "2031-05-05", "2031-05-10");
    expect(grow.statusCode).toBe(409);
    expect(JSON.parse(grow.body).error).toBe(OVERLAP);

    // The exit core (employment-exit.ts) goes through prepareLeaveCorrection with end = exit day.
    const existing = await app.prisma.leaveRequest.findUniqueOrThrow({
      where: { id: a },
      include: { leaveType: true, employee: { select: { tenantId: true } } },
    });
    const prepared = await prepareLeaveCorrection(app, {
      existing,
      start: existing.startDate,
      end: new Date("2031-05-07"),
      halfDay: false,
      note: null,
      reason: "Anonymisierung",
      tenantId: data.tenant.id,
    });
    expect(prepared.ok, JSON.stringify(prepared)).toBe(true);

    const shorten = await correct(a, "2031-05-05", "2031-05-07");
    expect(shorten.statusCode, shorten.body).toBe(200);
  });

  // ── 5. PENDING edit and approval ─────────────────────────────────────────────────────────────
  it("the PENDING edit cannot move onto an APPROVED or CANCELLATION_REQUESTED request; a legitimate edit still works", async () => {
    const target = await approved("VACATION", "2031-06-16", "2031-06-18");
    const free = await create({ type: "VACATION", startDate: "2031-06-02", endDate: "2031-06-04" });

    const onApproved = await edit(free, "2031-06-17", "2031-06-19");
    expect(onApproved.statusCode, onApproved.body).toBe(409);
    expect(JSON.parse(onApproved.body).error).toBe(OVERLAP);

    await setStatus(target, "CANCELLATION_REQUESTED");
    expect((await edit(free, "2031-06-17", "2031-06-19")).statusCode).toBe(409);

    // Editing within its own old dates and onto free dates is fine (it never collides with itself).
    expect((await edit(free, "2031-06-02", "2031-06-05")).statusCode).toBe(200);
    expect((await edit(free, "2031-06-23", "2031-06-24")).statusCode).toBe(200);
  });

  it("the PENDING edit keeps the sick-over-effective-leave exception of POST", async () => {
    await approved("VACATION", "2031-07-07", "2031-07-11");
    const sick = await create({ type: "SICK", startDate: "2031-07-21", endDate: "2031-07-22" });
    expect((await edit(sick, "2031-07-08", "2031-07-09")).statusCode).toBe(200);
    const pendingVac = await create({
      type: "VACATION",
      startDate: "2031-07-28",
      endDate: "2031-07-30",
    });
    const sick2 = await create({ type: "SICK", startDate: "2031-08-18", endDate: "2031-08-19" });
    expect((await edit(sick2, "2031-07-29", "2031-07-29")).statusCode).toBe(409);
    expect(pendingVac).toBeTruthy();
  });

  it("the PENDING edit enforces maxDaysPerYear like POST", async () => {
    const id = await create({ type: "VACATION", startDate: "2031-10-06", endDate: "2031-10-08" });
    // Earlier tests of this file already use up vacation days in 2031; budget on top of them.
    const others = await app.prisma.leaveRequest.aggregate({
      where: {
        employeeId: data.employee.id,
        leaveTypeId: data.vacationType.id,
        deletedAt: null,
        status: { in: ["PENDING", "APPROVED", "CANCELLATION_REQUESTED"] },
        id: { not: id },
        startDate: { gte: new Date("2031-01-01"), lte: new Date("2031-12-31") },
      },
      _sum: { days: true },
    });
    const max = Number(others._sum.days ?? 0) + 4;
    await app.prisma.leaveType.update({
      where: { id: data.vacationType.id },
      data: { maxDaysPerYear: max },
    });
    try {
      const tooLong = await edit(id, "2031-10-06", "2031-10-10");
      expect(tooLong.statusCode, tooLong.body).toBe(400);
      expect(JSON.parse(tooLong.body).error).toContain(`Max. ${max} Tage/Jahr`);
      expect((await edit(id, "2031-10-06", "2031-10-09")).statusCode).toBe(200);
    } finally {
      await app.prisma.leaveType.update({
        where: { id: data.vacationType.id },
        data: { maxDaysPerYear: null },
      });
    }
  });

  it("approving a PENDING request that double-books another effective request is refused with 409", async () => {
    const pending = await create({
      type: "VACATION",
      startDate: "2031-09-01",
      endDate: "2031-09-05",
    });
    // Manufactured stored double booking (what the edit bypass used to allow).
    await app.prisma.leaveRequest.create({
      data: {
        employeeId: data.employee.id,
        leaveTypeId: data.vacationType.id,
        startDate: new Date("2031-09-03"),
        endDate: new Date("2031-09-04"),
        days: 2,
        status: "APPROVED",
      },
    });
    const res = await review(pending);
    expect(res.statusCode, res.body).toBe(409);
    expect(JSON.parse(res.body).error).toBe(OVERLAP);
    expect(
      (await app.prisma.leaveRequest.findUniqueOrThrow({ where: { id: pending } })).status,
    ).toBe("PENDING");
  });
});
