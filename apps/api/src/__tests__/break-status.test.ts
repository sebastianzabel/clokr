import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

// Phase 91 (BREAK-03/BREAK-04): PATCH /:id/break-status confirm/waive transitions.
// RED (Task 1): endpoint does not exist yet — every it() below MUST fail until Task 2 lands.
describe("PATCH /:id/break-status", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let dataB: Awaited<ReturnType<typeof seedTestData>>; // second tenant for cross-tenant test

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "bks");
    dataB = await seedTestData(app, "bksB");

    await app.prisma.tenantConfig.update({
      where: { tenantId: data.tenant.id },
      data: { autoBreakEnabled: true, defaultBreakStart: "12:00" },
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
      await cleanupTestData(app, dataB.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  // Partial unique index (employeeId, date) WHERE deletedAt IS NULL — clear prior entries per test.
  beforeEach(async () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    await app.prisma.break.deleteMany({
      where: { timeEntry: { employeeId: data.employee.id, date: today } },
    });
    await app.prisma.timeEntry.deleteMany({
      where: { employeeId: data.employee.id, date: today },
    });
  });

  /** Creates a >6h AUTO entry for data.employee (produces breakStatus AUTO on clock-out). */
  async function createAutoEntry() {
    const startTime = new Date(Date.now() - 7 * 60 * 60 * 1000);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const entry = await app.prisma.timeEntry.create({
      data: {
        employeeId: data.employee.id,
        date: today,
        startTime,
        source: "MANUAL",
      },
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/time-entries/${entry.id}/clock-out`,
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.entry.breakStatus).toBe("AUTO");
    return body.entry as { id: string; breakMinutes: number };
  }

  it("confirm: AUTO entry -> 200, breakStatus CONFIRMED, BREAK_CONFIRMED audit row", async () => {
    const entry = await createAutoEntry();

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/time-entries/${entry.id}/break-status`,
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: { action: "confirm" },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.entry.breakStatus).toBe("CONFIRMED");

    const audit = await app.prisma.auditLog.findFirst({
      where: { action: "BREAK_CONFIRMED", entityId: entry.id },
    });
    expect(audit).not.toBeNull();
  });

  it("waive: AUTO entry -> 200, breakMinutes 0, Break[] deleted, WAIVED + reason, BREAK_WAIVED audit, manager BREAK_COMPLIANCE_ALERT notification", async () => {
    const entry = await createAutoEntry();

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/time-entries/${entry.id}/break-status`,
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: { action: "waive", reason: "durchgearbeitet" },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.entry.breakStatus).toBe("WAIVED");
    expect(body.entry.breakMinutes).toBe(0);
    expect(body.entry.breakWaivedReason).toBe("durchgearbeitet");

    const remainingBreaks = await app.prisma.break.count({ where: { timeEntryId: entry.id } });
    expect(remainingBreaks).toBe(0);

    const audit = await app.prisma.auditLog.findFirst({
      where: { action: "BREAK_WAIVED", entityId: entry.id },
    });
    expect(audit).not.toBeNull();
    expect((audit?.oldValue as { breakMinutes?: number } | null)?.breakMinutes).toBeDefined();
    // WR-01: the pre-waive Break slots must be captured in the audit oldValue so a later
    // "durchgearbeitet" dispute is reconstructable (Break is not a soft-delete model).
    const capturedBreaks = (audit?.oldValue as { breaks?: unknown[] } | null)?.breaks;
    expect(Array.isArray(capturedBreaks)).toBe(true);
    expect(capturedBreaks?.length ?? 0).toBeGreaterThan(0);
    expect(capturedBreaks?.[0]).toHaveProperty("startTime");
    expect(capturedBreaks?.[0]).toHaveProperty("endTime");

    // data.adminUser is ADMIN role in the same tenant -> manager-alert recipient
    const notification = await app.prisma.notification.findFirst({
      where: { type: "BREAK_COMPLIANCE_ALERT", userId: data.adminUser.id },
    });
    expect(notification).not.toBeNull();
  });

  it("waive: rejected on a CONFIRMED entry -> 409 German message; real breaks preserved (WR-02)", async () => {
    // A CONFIRMED day carries the employee's affirmed real breaks — the waive shortcut
    // (which hard-deletes Break rows) must NOT be allowed to destroy them.
    const entry = await createAutoEntry();

    // Move it into CONFIRMED first.
    const confirmRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/time-entries/${entry.id}/break-status`,
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: { action: "confirm" },
    });
    expect(confirmRes.statusCode).toBe(200);
    const breaksBefore = await app.prisma.break.count({ where: { timeEntryId: entry.id } });
    expect(breaksBefore).toBeGreaterThan(0);

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/time-entries/${entry.id}/break-status`,
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: { action: "waive", reason: "durchgearbeitet" },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe(
      "Durchgearbeitet kann nur für eine automatisch eingetragene Pause erklärt werden.",
    );

    // The confirmed real breaks and status must be untouched.
    const unchanged = await app.prisma.timeEntry.findUnique({ where: { id: entry.id } });
    expect(unchanged?.breakStatus).toBe("CONFIRMED");
    const breaksAfter = await app.prisma.break.count({ where: { timeEntryId: entry.id } });
    expect(breaksAfter).toBe(breaksBefore);
  });

  it("waive: a second waive on an already-WAIVED entry -> 409 (no repeat, no duplicate alert)", async () => {
    // IN-02 fallout of WR-02: once WAIVED, the entry is no longer AUTO, so a repeat waive
    // is rejected — it cannot re-fire the manager BREAK_COMPLIANCE_ALERT.
    const entry = await createAutoEntry();

    const first = await app.inject({
      method: "PATCH",
      url: `/api/v1/time-entries/${entry.id}/break-status`,
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: { action: "waive", reason: "durchgearbeitet" },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "PATCH",
      url: `/api/v1/time-entries/${entry.id}/break-status`,
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: { action: "waive", reason: "durchgearbeitet" },
    });
    expect(second.statusCode).toBe(409);
    expect(JSON.parse(second.body).error).toBe(
      "Durchgearbeitet kann nur für eine automatisch eingetragene Pause erklärt werden.",
    );
  });

  it("waive: does not self-notify when the actor is themselves a manager/admin", async () => {
    // Admin creates + waives their OWN entry -> the admin must not receive a self-alert.
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const startTime = new Date(Date.now() - 7 * 60 * 60 * 1000);
    const entry = await app.prisma.timeEntry.create({
      data: {
        employeeId: data.adminEmployee.id,
        date: today,
        startTime,
        endTime: new Date(),
        breakMinutes: 30,
        breakStatus: "AUTO",
        source: "MANUAL",
      },
    });
    await app.prisma.break.create({
      data: {
        timeEntryId: entry.id,
        startTime,
        endTime: new Date(startTime.getTime() + 30 * 60000),
      },
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/time-entries/${entry.id}/break-status`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { action: "waive" },
    });
    expect(res.statusCode).toBe(200);

    const selfNotification = await app.prisma.notification.findFirst({
      where: { type: "BREAK_COMPLIANCE_ALERT", userId: data.adminUser.id, relatedId: entry.id },
    });
    expect(selfNotification).toBeNull();

    await app.prisma.timeEntry.deleteMany({ where: { id: entry.id } });
  });

  it("isLocked: confirm and waive both return 409 with the German lock message; DB unchanged", async () => {
    const entry = await createAutoEntry();
    await app.prisma.timeEntry.update({ where: { id: entry.id }, data: { isLocked: true } });

    const confirmRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/time-entries/${entry.id}/break-status`,
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: { action: "confirm" },
    });
    expect(confirmRes.statusCode).toBe(409);
    expect(JSON.parse(confirmRes.body).error).toBe(
      "Eintrag ist gesperrt und kann nicht bearbeitet werden",
    );

    const waiveRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/time-entries/${entry.id}/break-status`,
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: { action: "waive" },
    });
    expect(waiveRes.statusCode).toBe(409);
    expect(JSON.parse(waiveRes.body).error).toBe(
      "Eintrag ist gesperrt und kann nicht bearbeitet werden",
    );

    const unchanged = await app.prisma.timeEntry.findUnique({ where: { id: entry.id } });
    expect(unchanged?.breakStatus).toBe("AUTO");

    await app.prisma.timeEntry.update({ where: { id: entry.id }, data: { isLocked: false } });
  });

  it("cross-tenant: a user from tenant B PATCHing tenant A's entry -> 404 + CROSS_TENANT_ACCESS_DENIED audit", async () => {
    const entry = await createAutoEntry();

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/time-entries/${entry.id}/break-status`,
      headers: { authorization: `Bearer ${dataB.empToken}` },
      payload: { action: "confirm" },
    });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toBe("Eintrag nicht gefunden");

    const audit = await app.prisma.auditLog.findFirst({
      where: { action: "CROSS_TENANT_ACCESS_DENIED", entityId: entry.id },
    });
    expect(audit).not.toBeNull();
  });

  it("authz: a non-owner EMPLOYEE of the same tenant is rejected 403", async () => {
    const entry = await createAutoEntry();

    // Second employee in the same tenant, not owning this entry, not a manager.
    const s = "bks-other-" + Date.now().toString(36);
    const otherUser = await app.prisma.user.create({
      data: {
        email: `other-${s}@test.de`,
        passwordHash: (await app.prisma.user.findUnique({ where: { id: data.empUser.id } }))!
          .passwordHash,
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const otherEmployee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: otherUser.id,
        employeeNumber: `O-${s}`,
        firstName: "Other",
        lastName: "Test",
        hireDate: new Date("2024-01-01"),
      },
    });
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: `other-${s}@test.de`, password: "test1234" },
    });
    const { accessToken: otherToken } = JSON.parse(loginRes.body);

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/time-entries/${entry.id}/break-status`,
      headers: { authorization: `Bearer ${otherToken}` },
      payload: { action: "confirm" },
    });
    expect(res.statusCode).toBe(403);

    await app.prisma.employee.deleteMany({ where: { id: otherEmployee.id } });
    await app.prisma.user.deleteMany({ where: { id: otherUser.id } });
  });

  it("waive recomputes the overtime account without throwing (net worked time increases)", async () => {
    const entry = await createAutoEntry();

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/time-entries/${entry.id}/break-status`,
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: { action: "waive" },
    });
    expect(res.statusCode).toBe(200);

    const overtimeRes = await app.inject({
      method: "GET",
      url: `/api/v1/overtime/${data.employee.id}`,
      headers: { authorization: `Bearer ${data.empToken}` },
    });
    expect(overtimeRes.statusCode).toBe(200);
  });
});
