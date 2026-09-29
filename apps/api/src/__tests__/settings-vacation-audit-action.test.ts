/**
 * Issue #416 — `PUT /api/v1/settings/vacation/:employeeId` always audited `action: "UPDATE"`,
 * even on the very first write for an employee+year with no prior `LeaveEntitlement` row. The
 * handler already fetches the pre-existing row (via `getVacationEntitlement`) before the upsert —
 * this pins that the audit now says `CREATE` when that fetch found nothing, and `UPDATE` on a
 * subsequent write for the same employee+year.
 *
 * Every year is computed from `new Date()` — no hardcoded calendar literal (documented time-bomb
 * hazard, see CLAUDE.md / docs/testing.md).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

describe("PUT /api/v1/settings/vacation/:employeeId — CREATE-vs-UPDATE audit action (Issue #416)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "svaa");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("audits CREATE on the first write for a year with no prior entitlement row, and UPDATE on a second write", async () => {
    // seedTestData() only seeds an entitlement for the CURRENT year — a future year has none yet.
    const freshYear = new Date().getFullYear() + 8;

    const before = await app.prisma.leaveEntitlement.findUnique({
      where: {
        employeeId_leaveTypeId_year: {
          employeeId: data.employee.id,
          leaveTypeId: data.vacationType.id,
          year: freshYear,
        },
      },
    });
    expect(before).toBeNull();

    const firstRes = await app.inject({
      method: "PUT",
      url: `/api/v1/settings/vacation/${data.employee.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { year: freshYear, totalDays: 20 },
    });
    expect(firstRes.statusCode).toBe(200);

    const entitlement = await app.prisma.leaveEntitlement.findUnique({
      where: {
        employeeId_leaveTypeId_year: {
          employeeId: data.employee.id,
          leaveTypeId: data.vacationType.id,
          year: freshYear,
        },
      },
    });
    expect(entitlement).not.toBeNull();

    const firstAudit = await app.prisma.auditLog.findFirst({
      where: { entity: "LeaveEntitlement", entityId: entitlement!.id },
      orderBy: { createdAt: "asc" },
    });
    expect(firstAudit?.action).toBe("CREATE");

    // Second write for the SAME employee+year — the row now exists, so this must be UPDATE.
    const secondRes = await app.inject({
      method: "PUT",
      url: `/api/v1/settings/vacation/${data.employee.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { year: freshYear, totalDays: 25 },
    });
    expect(secondRes.statusCode).toBe(200);

    const secondAudit = await app.prisma.auditLog.findFirst({
      where: { entity: "LeaveEntitlement", entityId: entitlement!.id },
      orderBy: { createdAt: "desc" },
    });
    expect(secondAudit?.action).toBe("UPDATE");
  });

  it("audits UPDATE for a year that already has a seeded entitlement row (regression guard)", async () => {
    const currentYear = new Date().getFullYear();
    // seedTestData() seeds this row already — assert the pre-existing behavior is unchanged.
    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/settings/vacation/${data.employee.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { year: currentYear, totalDays: 28 },
    });
    expect(res.statusCode).toBe(200);

    const entitlement = await app.prisma.leaveEntitlement.findUnique({
      where: {
        employeeId_leaveTypeId_year: {
          employeeId: data.employee.id,
          leaveTypeId: data.vacationType.id,
          year: currentYear,
        },
      },
    });
    const audit = await app.prisma.auditLog.findFirst({
      where: { entity: "LeaveEntitlement", entityId: entitlement!.id },
      orderBy: { createdAt: "desc" },
    });
    expect(audit?.action).toBe("UPDATE");
  });
});
