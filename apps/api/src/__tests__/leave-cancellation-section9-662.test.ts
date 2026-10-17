/**
 * Issue #662 - approving the cancellation of an approved vacation supersedes the request's § 9 BUrlG
 * credits (SUPERSEDED, audited, never deleted) in the same transaction as the cancellation.
 *
 * Before the fix a CONFIRMED credit stayed standing after `CANCELLATION_REQUESTED -> CANCELLED`:
 * the cancellation gave all request days back and the credit's own give-back stayed on top, so
 * `LeaveEntitlement.usedDays` went below zero (days credited twice) and only `selfHealUsedDays`
 * (the entitlement GET) hid it. Every assertion on `usedDays` here reads the STORED column
 * directly - never through the self-heal read.
 *
 * Dates are fixed in 2027, ahead of the real clock, so the request is never in a closed month.
 */
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
  auditRowsFor,
  soleAuditRow,
} from "./setup";
import { getTenantTimezone, monthRangeUtc } from "../contexts/working-time-account";

describe("Cancellation approval supersedes § 9 credits (Issue #662)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let secondAdminToken: string;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "s9c662");
    await seedEntitlementYears(app, {
      employeeId: data.employee.id,
      leaveTypeId: data.vacationType.id,
      years: [2027],
    });
    // Four-eyes: the cancellation may be approved neither by the requester nor by the original
    // approver, so a second whole-tenant approver is needed.
    const user = await app.prisma.user.create({
      data: {
        email: `second-admin-662-${Date.now().toString(36)}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `ADM662-${Date.now().toString(36)}`,
        firstName: "Zweite",
        lastName: "Freigabe",
        hireDate: new Date("2024-01-01"),
      },
    });
    await grantSystemRole(app.prisma, {
      tenantId: data.tenant.id,
      userId: user.id,
      role: "ADMIN",
    });
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

  async function approve(id: string) {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${id}/review`,
      headers: adminAuth(),
      payload: { status: "APPROVED" },
    });
    expect(res.statusCode, res.body).toBe(200);
  }

  /** Vacation + overlapping sick request, both approved; returns the detected (AU_PENDING) credit. */
  async function vacationWithSickOverlap(vac: [string, string], sick: [string, string]) {
    const vacId = await create({ type: "VACATION", startDate: vac[0], endDate: vac[1] });
    await approve(vacId);
    const sickId = await create({ type: "SICK", startDate: sick[0], endDate: sick[1] });
    await approve(sickId);
    const credit = await app.prisma.section9Credit.findFirstOrThrow({
      where: { sickRequestId: sickId },
    });
    return { vacId, sickId, credit };
  }

  async function confirmCredit(creditId: string, from: string, to: string) {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/leave/section9/${creditId}/confirm`,
      headers: adminAuth(),
      payload: { attestSource: "EAU", attestValidFrom: from, attestValidTo: to, reason: "AU da" },
    });
    expect(res.statusCode, res.body).toBe(200);
  }

  async function requestCancellation(id: string) {
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/leave/requests/${id}`,
      headers: empAuth(),
      payload: { reason: "Urlaub entfällt" },
    });
    expect(res.statusCode, res.body).toBe(200);
  }

  function reviewCancellation(id: string) {
    return app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${id}/review`,
      headers: { authorization: `Bearer ${secondAdminToken}` },
      payload: { status: "APPROVED" },
    });
  }

  /** The STORED usedDays - never the self-healing entitlement GET. */
  async function storedUsedDays(year = 2027): Promise<number> {
    const row = await app.prisma.leaveEntitlement.findFirstOrThrow({
      where: { employeeId: data.employee.id, leaveTypeId: data.vacationType.id, year },
    });
    return Number(row.usedDays);
  }

  it("a CONFIRMED credit: Resturlaub and stored usedDays are correct, the credit is SUPERSEDED and audited, no row is deleted", async () => {
    const usedBefore = await storedUsedDays();
    const { vacId, credit } = await vacationWithSickOverlap(
      ["2027-03-01", "2027-03-12"],
      ["2027-03-10", "2027-03-12"],
    );
    await confirmCredit(credit.id, "2027-03-10", "2027-03-12");
    expect(await storedUsedDays()).toBe(usedBefore + 7); // 10 vacation days - 3 credited

    await requestCancellation(vacId);
    const creditRowsBefore = await app.prisma.section9Credit.count({
      where: { employeeId: data.employee.id },
    });

    const res = await reviewCancellation(vacId);
    expect(res.statusCode, res.body).toBe(200);

    // RED proof: without the supersession this reads usedBefore - 3 (the credit's days given back
    // a second time on top of the cancellation's full give-back).
    expect(await storedUsedDays()).toBe(usedBefore);

    const after = await app.prisma.section9Credit.findUniqueOrThrow({ where: { id: credit.id } });
    expect(after.status).toBe("SUPERSEDED");
    expect(await app.prisma.section9Credit.count({ where: { employeeId: data.employee.id } })).toBe(
      creditRowsBefore,
    );
    expect((await app.prisma.leaveRequest.findUniqueOrThrow({ where: { id: vacId } })).status).toBe(
      "CANCELLED",
    );

    const audit = await soleAuditRow(app.prisma, {
      where: {
        action: "SECTION9_CREDIT_SUPERSEDED",
        entity: "Section9Credit",
        entityId: credit.id,
      },
    });
    expect((audit.oldValue as { status: string; creditedDays: number }).status).toBe("CONFIRMED");
    expect((audit.oldValue as { creditedDays: number }).creditedDays).toBe(3);
    expect(audit.newValue).toMatchObject({
      status: "SUPERSEDED",
      cancelledLeaveRequestId: vacId,
      auditReason: "Stornierung",
    });
    expect(audit.userId).not.toBeNull();

    // The self-healing read agrees with what is stored (it used to be the only place that did).
    const heal = await app.inject({
      method: "GET",
      url: `/api/v1/leave/entitlements/${data.employee.id}?year=2027`,
      headers: adminAuth(),
    });
    const healed = (
      JSON.parse(heal.body) as Array<{ leaveType?: { name: string }; usedDays?: number }>
    ).find((r) => r.leaveType?.name === "Urlaub");
    expect(Number(healed?.usedDays)).toBe(usedBefore);
  });

  it("an AU_PENDING credit (never booked) is superseded too, the ledger only gets the cancellation's give-back", async () => {
    const usedBefore = await storedUsedDays();
    const { vacId, credit } = await vacationWithSickOverlap(
      ["2027-06-07", "2027-06-18"],
      ["2027-06-09", "2027-06-10"],
    );
    expect(credit.status).toBe("AU_PENDING");
    expect(await storedUsedDays()).toBe(usedBefore + 10);

    await requestCancellation(vacId);
    expect((await reviewCancellation(vacId)).statusCode).toBe(200);

    expect(await storedUsedDays()).toBe(usedBefore);
    const after = await app.prisma.section9Credit.findUniqueOrThrow({ where: { id: credit.id } });
    expect(after.status).toBe("SUPERSEDED");
    expect(
      await auditRowsFor(app, "Section9Credit", credit.id, "SECTION9_CREDIT_SUPERSEDED"),
    ).toHaveLength(1);
  });

  it("a cancellation touching a closed month is refused 409 and leaves the credit untouched", async () => {
    const usedBefore = await storedUsedDays();
    const { vacId, credit } = await vacationWithSickOverlap(
      ["2027-07-05", "2027-07-16"],
      ["2027-07-07", "2027-07-08"],
    );
    await confirmCredit(credit.id, "2027-07-07", "2027-07-08");
    await requestCancellation(vacId);

    const tz = await getTenantTimezone(app.prisma, data.tenant.id);
    const { start, end } = monthRangeUtc(2027, 7, tz);
    await app.prisma.saldoSnapshot.create({
      data: {
        employeeId: data.employee.id,
        periodType: "MONTHLY",
        periodStart: start,
        periodEnd: end,
        workedMinutes: 0,
        expectedMinutes: 0,
        balanceMinutes: 0,
        carryOver: 0,
        closedAt: new Date(),
        closedBy: "test-system",
      },
    });

    const usedAfterConfirm = await storedUsedDays();
    const res = await reviewCancellation(vacId);
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe("LEAVE_MONTH_CLOSED");

    expect(await storedUsedDays()).toBe(usedAfterConfirm);
    expect(usedAfterConfirm).toBe(usedBefore + 10 - 2);
    const after = await app.prisma.section9Credit.findUniqueOrThrow({ where: { id: credit.id } });
    expect(after.status).toBe("CONFIRMED");
    expect(
      await auditRowsFor(app, "Section9Credit", credit.id, "SECTION9_CREDIT_SUPERSEDED"),
    ).toHaveLength(0);
  });
});
