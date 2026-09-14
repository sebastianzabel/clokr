/**
 * fix(sec-02): DELETE /api/v1/shifts/:id loaded the target row via an unfiltered
 * `shift.findUnique({ where: { id } })` and never compared the owning employee's
 * tenantId against the caller's — any ADMIN/MANAGER could delete a foreign tenant's
 * Shift. Fixed to check the loaded row's real owner before any further step,
 * mirroring overtime.ts (Shift itself has no tenantId column — go via employee).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

/** Tomorrow, "YYYY-MM-DD" — Shift.date must not be in the past (SHIFT_PAST_IMMUTABLE). */
function tomorrowIso(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const GENUINELY_MISSING_SHIFT_ID = "00000000-0000-4000-8000-000000000002";

describe("DELETE /api/v1/shifts/:id — tenant isolation (sec-02)", () => {
  let app: FastifyInstance;
  let tenantA: Awaited<ReturnType<typeof seedTestData>>;
  let tenantB: Awaited<ReturnType<typeof seedTestData>>;
  let victimShiftId: string;

  beforeAll(async () => {
    app = await getTestApp();
    tenantA = await seedTestData(app, "sec02-a");
    tenantB = await seedTestData(app, "sec02-b");

    const victimShift = await app.prisma.shift.create({
      data: {
        employeeId: tenantB.employee.id,
        date: new Date(tomorrowIso()),
        startTime: "08:00",
        endTime: "16:00",
      },
    });
    victimShiftId = victimShift.id;
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

  it("tenantA ADMIN deleting tenantB's shift → 404, row untouched, CROSS_TENANT_ACCESS_DENIED audit", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/shifts/${victimShiftId}`,
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
    });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: "Schicht nicht gefunden" });

    // The victim row survived, unchanged.
    const victimAfter = await app.prisma.shift.findUnique({ where: { id: victimShiftId } });
    expect(victimAfter).not.toBeNull();
    expect(victimAfter?.deletedAt).toBeNull();

    const audit = await app.prisma.auditLog.findFirst({
      where: { action: "CROSS_TENANT_ACCESS_DENIED", entity: "Shift", entityId: victimShiftId },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).not.toBeNull();
    expect(audit?.userId).toBe(tenantA.adminUser.id);
  });

  it("the cross-tenant 404 is byte-identical to a genuine not-found 404 (no existence oracle)", async () => {
    const crossTenantRes = await app.inject({
      method: "DELETE",
      url: `/api/v1/shifts/${victimShiftId}`,
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
    });

    const notFoundRes = await app.inject({
      method: "DELETE",
      url: `/api/v1/shifts/${GENUINELY_MISSING_SHIFT_ID}`,
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
    });

    expect(crossTenantRes.statusCode).toBe(notFoundRes.statusCode);
    expect(JSON.parse(crossTenantRes.body)).toEqual(JSON.parse(notFoundRes.body));
  });

  it("the same call by tenantB's OWN ADMIN still succeeds exactly as before (no regression)", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/shifts/${victimShiftId}`,
      headers: { authorization: `Bearer ${tenantB.adminToken}` },
    });

    expect(res.statusCode).toBe(204);

    const victimAfter = await app.prisma.shift.findUnique({ where: { id: victimShiftId } });
    expect(victimAfter).toBeNull();
  });
});
