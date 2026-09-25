// Phase 65b Plan 03 (Issue #65, D-14..D-17) — coupling CRUD API tests.
//
// GET/POST/DELETE /api/v1/integrations/phorest/couplings[/:salonId] manage the SalonCoupling
// that replaces TenantConfig.phorestBranchId as the sync's source of the branch. Covers: tenant
// isolation on GET, the full POST check order (404 foreign/unknown, 422 inactive, 409
// already-coupled, 409 branch-collision, cross-tenant branch reuse allowed, a P2002 race, Zod
// 400s), the DELETE's byte-identical 404 for foreign/unknown/own-uncoupled plus its audit and its
// promise that shifts/appointments/sync runs are never touched, and the EMPLOYEE 403 / no-PUT
// authorization matrix.
//
// Run via `pnpm --filter @clokr/api test -- salon-couplings` (pretest db-push).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  seedTestData,
  cleanupTestData,
  createTestSalon,
} from "../../../../__tests__/setup";

const PREFIX = "/api/v1/integrations";
const BASE = `${PREFIX}/phorest/couplings`;

const SALON_NOT_FOUND_BODY = { error: "Salon nicht gefunden" };
const SALON_INACTIVE_BODY = { error: "Salon ist deaktiviert", code: "SALON_INACTIVE" };
const SALON_ALREADY_COUPLED_BODY = {
  error: "Dieser Salon ist bereits mit Phorest gekoppelt.",
  code: "SALON_ALREADY_COUPLED",
};
const BRANCH_ALREADY_COUPLED_BODY = {
  error: "Diese Phorest-Filiale ist bereits mit einem anderen Salon gekoppelt.",
  code: "BRANCH_ALREADY_COUPLED",
};
const COUPLING_NOT_FOUND_BODY = { error: "Kopplung nicht gefunden" };

describe("Phorest salon coupling CRUD (Phase 65b, issue #65, D-14..D-17)", () => {
  let app: FastifyInstance;
  let tenantA: Awaited<ReturnType<typeof seedTestData>>;
  let tenantB: Awaited<ReturnType<typeof seedTestData>>;

  const authA = () => ({ authorization: `Bearer ${tenantA.adminToken}` });
  const authAEmployee = () => ({ authorization: `Bearer ${tenantA.empToken}` });

  async function freshSalon(name: string, overrides?: { isActive?: boolean }) {
    return createTestSalon(app.prisma, tenantA.tenant.id, {
      name,
      isActive: overrides?.isActive,
      createdAt: new Date(Date.now() + Math.floor(Math.random() * 1000) + 1),
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    tenantA = await seedTestData(app, "coupl-a");
    tenantB = await seedTestData(app, "coupl-b");
  });

  afterAll(async () => {
    try {
      await app.prisma.phorestAppointment.deleteMany({
        where: { employeeId: { in: [tenantA.employee.id, tenantB.employee.id] } },
      });
      await cleanupTestData(app, tenantA.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed (tenantA):", err);
    }
    try {
      await cleanupTestData(app, tenantB.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed (tenantB):", err);
    }
  });

  // ── D-14: GET lists only the caller tenant's couplings ────────────────

  it("D-14: GET lists a coupling with salonName/salonIsActive/provider/externalBranchId, and never another tenant's coupling", async () => {
    const salon = await freshSalon("Coupling GET Salon");
    const coupling = await app.prisma.salonCoupling.create({
      data: {
        tenantId: tenantA.tenant.id,
        salonId: salon.id,
        provider: "PHOREST",
        externalBranchId: "list-a",
      },
    });
    const foreignCoupling = await app.prisma.salonCoupling.create({
      data: {
        tenantId: tenantB.tenant.id,
        salonId: tenantB.salonId,
        provider: "PHOREST",
        externalBranchId: "list-b",
      },
    });

    const res = await app.inject({ method: "GET", url: BASE, headers: authA() });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      couplings: Array<{
        id: string;
        salonId: string;
        salonName: string;
        salonIsActive: boolean;
        provider: string;
        externalBranchId: string;
        createdAt: string;
      }>;
    };

    const entry = body.couplings.find((c) => c.salonId === salon.id);
    expect(entry).toMatchObject({
      id: coupling.id,
      salonId: salon.id,
      salonName: "Coupling GET Salon",
      salonIsActive: true,
      provider: "PHOREST",
      externalBranchId: "list-a",
    });
    expect(typeof entry?.createdAt).toBe("string");

    // Tenant isolation: tenantB's coupling never appears in tenantA's list.
    expect(body.couplings.some((c) => c.salonId === foreignCoupling.salonId)).toBe(false);
  });

  // ── D-15: POST create ──────────────────────────────────────────────────

  it("D-15: POST trims externalBranchId, returns 201, and writes one CREATE audit row", async () => {
    const salon = await freshSalon("Coupling POST Salon 1");
    const beforeAudits = await app.prisma.auditLog.count({
      where: { entity: "SalonCoupling", action: "CREATE" },
    });

    const res = await app.inject({
      method: "POST",
      url: BASE,
      headers: authA(),
      payload: { salonId: salon.id, externalBranchId: "  br-create-1  " },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.coupling).toMatchObject({
      salonId: salon.id,
      provider: "PHOREST",
      externalBranchId: "br-create-1",
    });
    expect(typeof body.coupling.id).toBe("string");

    const afterAudits = await app.prisma.auditLog.count({
      where: { entity: "SalonCoupling", action: "CREATE" },
    });
    expect(afterAudits).toBe(beforeAudits + 1);

    const audit = await app.prisma.auditLog.findFirst({
      where: { entity: "SalonCoupling", entityId: body.coupling.id, action: "CREATE" },
      orderBy: { createdAt: "desc" },
    });
    expect(audit?.newValue).toEqual({
      salonId: salon.id,
      provider: "PHOREST",
      externalBranchId: "br-create-1",
    });
  });

  it("D-15: POST on a foreign salon and on an unknown UUID both answer byte-identical 404 'Salon nicht gefunden', with no row and no audit created", async () => {
    const beforeCount = await app.prisma.salonCoupling.count();
    const beforeAudits = await app.prisma.auditLog.count({ where: { entity: "SalonCoupling" } });

    const foreignRes = await app.inject({
      method: "POST",
      url: BASE,
      headers: authA(),
      payload: { salonId: tenantB.salonId, externalBranchId: "should-not-be-created" },
    });
    const unknownRes = await app.inject({
      method: "POST",
      url: BASE,
      headers: authA(),
      payload: {
        salonId: "00000000-0000-4000-8000-000000000001",
        externalBranchId: "should-not-be-created",
      },
    });

    expect(foreignRes.statusCode).toBe(404);
    expect(unknownRes.statusCode).toBe(404);
    expect(foreignRes.body).toBe(unknownRes.body);
    expect(JSON.parse(foreignRes.body)).toEqual(SALON_NOT_FOUND_BODY);

    expect(await app.prisma.salonCoupling.count()).toBe(beforeCount);
    expect(await app.prisma.auditLog.count({ where: { entity: "SalonCoupling" } })).toBe(
      beforeAudits,
    );
  });

  it("D-15: POST on an inactive own salon answers 422 SALON_INACTIVE", async () => {
    const salon = await freshSalon("Coupling POST Salon Inactive", { isActive: false });
    const res = await app.inject({
      method: "POST",
      url: BASE,
      headers: authA(),
      payload: { salonId: salon.id, externalBranchId: "br-inactive" },
    });
    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body)).toEqual(SALON_INACTIVE_BODY);
  });

  it("D-15: POST on an already-coupled salon answers 409 SALON_ALREADY_COUPLED", async () => {
    const salon = await freshSalon("Coupling POST Salon Already Coupled");
    await app.prisma.salonCoupling.create({
      data: {
        tenantId: tenantA.tenant.id,
        salonId: salon.id,
        provider: "PHOREST",
        externalBranchId: "br-already-1",
      },
    });
    const res = await app.inject({
      method: "POST",
      url: BASE,
      headers: authA(),
      payload: { salonId: salon.id, externalBranchId: "br-already-2" },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual(SALON_ALREADY_COUPLED_BODY);
  });

  it("D-15: POST on a second own salon with a branch id already coupled in the SAME tenant answers 409 BRANCH_ALREADY_COUPLED", async () => {
    const salon1 = await freshSalon("Coupling Branch Collision Salon 1");
    const salon2 = await freshSalon("Coupling Branch Collision Salon 2");
    await app.prisma.salonCoupling.create({
      data: {
        tenantId: tenantA.tenant.id,
        salonId: salon1.id,
        provider: "PHOREST",
        externalBranchId: "br-collision",
      },
    });
    const res = await app.inject({
      method: "POST",
      url: BASE,
      headers: authA(),
      payload: { salonId: salon2.id, externalBranchId: "br-collision" },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual(BRANCH_ALREADY_COUPLED_BODY);
  });

  it("D-15: the SAME branch id used by ANOTHER tenant is accepted (201) and never mentioned", async () => {
    // Reuses tenantB's own coupling created by the D-14 GET test (branch "list-b") — tenantB's
    // Salon can carry only ONE coupling (SalonCoupling.salonId is globally unique), so this test
    // must not create a second one on the same salon.
    const tenantBCoupling = await app.prisma.salonCoupling.findUnique({
      where: { salonId: tenantB.salonId },
    });
    expect(tenantBCoupling?.externalBranchId).toBe("list-b");

    const salon = await freshSalon("Coupling Cross-Tenant Branch Salon");
    const res = await app.inject({
      method: "POST",
      url: BASE,
      headers: authA(),
      payload: { salonId: salon.id, externalBranchId: "list-b" },
    });
    expect(res.statusCode).toBe(201);
  });

  it("D-15: two identical concurrent POSTs race to [201, 409], the 409 body being one of the fixed 409 bodies", async () => {
    const salon = await freshSalon("Coupling Race Salon");
    const payload = { salonId: salon.id, externalBranchId: "br-race-1" };
    const [r1, r2] = await Promise.all([
      app.inject({ method: "POST", url: BASE, headers: authA(), payload }),
      app.inject({ method: "POST", url: BASE, headers: authA(), payload }),
    ]);
    const statuses = [r1.statusCode, r2.statusCode].sort((a, b) => a - b);
    expect(statuses).toEqual([201, 409]);
    const loser = r1.statusCode === 409 ? r1 : r2;
    const loserBody = JSON.parse(loser.body);
    expect([SALON_ALREADY_COUPLED_BODY, BRANCH_ALREADY_COUPLED_BODY]).toContainEqual(loserBody);

    // Exactly one coupling exists on this salon after the race.
    const count = await app.prisma.salonCoupling.count({ where: { salonId: salon.id } });
    expect(count).toBe(1);
  });

  it("D-15: POST with a blank externalBranchId or a non-UUID salonId answers 400 (Zod)", async () => {
    const salon = await freshSalon("Coupling Zod Salon");
    const blankBranch = await app.inject({
      method: "POST",
      url: BASE,
      headers: authA(),
      payload: { salonId: salon.id, externalBranchId: "   " },
    });
    expect(blankBranch.statusCode).toBe(400);

    const badSalonId = await app.inject({
      method: "POST",
      url: BASE,
      headers: authA(),
      payload: { salonId: "not-a-uuid", externalBranchId: "br-zod" },
    });
    expect(badSalonId.statusCode).toBe(400);
  });

  // ── D-16: DELETE ────────────────────────────────────────────────────────

  it("D-16: DELETE removes an own coupling with a 200 + DELETE audit, leaving that salon's Shift/PhorestAppointment/PhorestSyncRun rows untouched", async () => {
    const salon = await freshSalon("Coupling Delete Salon");
    const coupling = await app.prisma.salonCoupling.create({
      data: {
        tenantId: tenantA.tenant.id,
        salonId: salon.id,
        provider: "PHOREST",
        externalBranchId: "br-delete-1",
      },
    });

    const shift = await app.prisma.shift.create({
      data: {
        employeeId: tenantA.employee.id,
        salonId: salon.id,
        date: new Date("2026-09-01"),
        startTime: "08:00",
        endTime: "16:00",
      },
    });
    const appointment = await app.prisma.phorestAppointment.create({
      data: {
        employeeId: tenantA.employee.id,
        salonId: salon.id,
        date: new Date("2026-09-01"),
        startTime: "09:00",
        endTime: "10:00",
        externalId: "coupling-delete-appt-1",
      },
    });
    const syncRun = await app.prisma.phorestSyncRun.create({
      data: { tenantId: tenantA.tenant.id, salonId: salon.id, status: "SUCCESS", created: 1 },
    });

    const beforeAudits = await app.prisma.auditLog.count({
      where: { entity: "SalonCoupling", action: "DELETE" },
    });

    const res = await app.inject({
      method: "DELETE",
      url: `${BASE}/${salon.id}`,
      headers: authA(),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ success: true });

    expect(await app.prisma.salonCoupling.findUnique({ where: { id: coupling.id } })).toBeNull();

    const afterAudits = await app.prisma.auditLog.count({
      where: { entity: "SalonCoupling", action: "DELETE" },
    });
    expect(afterAudits).toBe(beforeAudits + 1);
    const audit = await app.prisma.auditLog.findFirst({
      where: { entity: "SalonCoupling", entityId: coupling.id, action: "DELETE" },
      orderBy: { createdAt: "desc" },
    });
    expect(audit?.oldValue).toEqual({
      salonId: salon.id,
      provider: "PHOREST",
      externalBranchId: "br-delete-1",
    });

    // Time data (Zeiterfassung/Schichtplanung) is untouched by a coupling delete.
    const reloadedShift = await app.prisma.shift.findUnique({ where: { id: shift.id } });
    expect(reloadedShift).toEqual(shift);
    const reloadedAppointment = await app.prisma.phorestAppointment.findUnique({
      where: { id: appointment.id },
    });
    expect(reloadedAppointment).toEqual(appointment);
    const reloadedRun = await app.prisma.phorestSyncRun.findUnique({ where: { id: syncRun.id } });
    expect(reloadedRun).toEqual(syncRun);

    // Cleanup this test's own rows (afterAll's cleanupTestData handles the salon-scoped tables
    // it already knows about; the Shift/PhorestAppointment/PhorestSyncRun rows are cleaned by
    // cleanupTestData's employeeId/tenantId-scoped deletes).
  });

  it("D-16: DELETE on a foreign salon, an unknown UUID and an own uncoupled salon all answer byte-identical 404 'Kopplung nicht gefunden'", async () => {
    const foreignSalonId = tenantB.salonId; // coupled ("list-b") by the D-14 GET test, above
    const foreignCouplingBefore = await app.prisma.salonCoupling.findUnique({
      where: { salonId: foreignSalonId },
    });
    expect(foreignCouplingBefore).not.toBeNull(); // sanity: the foreign coupling really exists

    const ownUncoupledSalon = await freshSalon("Coupling Own Uncoupled Salon");

    const foreignRes = await app.inject({
      method: "DELETE",
      url: `${BASE}/${foreignSalonId}`,
      headers: authA(),
    });
    const unknownRes = await app.inject({
      method: "DELETE",
      url: `${BASE}/00000000-0000-4000-8000-000000000002`,
      headers: authA(),
    });
    const uncoupledRes = await app.inject({
      method: "DELETE",
      url: `${BASE}/${ownUncoupledSalon.id}`,
      headers: authA(),
    });

    for (const res of [foreignRes, unknownRes, uncoupledRes]) {
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body)).toEqual(COUPLING_NOT_FOUND_BODY);
    }
    expect(foreignRes.body).toBe(unknownRes.body);
    expect(unknownRes.body).toBe(uncoupledRes.body);

    // The foreign (tenantB) coupling still exists — the DELETE against tenantA's token never
    // reached it.
    const foreignCouplingAfter = await app.prisma.salonCoupling.findUnique({
      where: { salonId: foreignSalonId },
    });
    expect(foreignCouplingAfter).not.toBeNull();
  });

  // ── Authorization matrix ────────────────────────────────────────────────

  it("EMPLOYEE token gets 403 on GET/POST/DELETE; there is no PUT/PATCH on /phorest/couplings*", async () => {
    const salon = await freshSalon("Coupling Authz Salon");

    const getRes = await app.inject({ method: "GET", url: BASE, headers: authAEmployee() });
    expect(getRes.statusCode).toBe(403);

    const postRes = await app.inject({
      method: "POST",
      url: BASE,
      headers: authAEmployee(),
      payload: { salonId: salon.id, externalBranchId: "br-authz" },
    });
    expect(postRes.statusCode).toBe(403);

    const deleteRes = await app.inject({
      method: "DELETE",
      url: `${BASE}/${salon.id}`,
      headers: authAEmployee(),
    });
    expect(deleteRes.statusCode).toBe(403);

    const putRes = await app.inject({
      method: "PUT",
      url: BASE,
      headers: authA(),
      payload: {},
    });
    expect(putRes.statusCode).toBe(404);

    const patchRes = await app.inject({
      method: "PATCH",
      url: `${BASE}/${salon.id}`,
      headers: authA(),
      payload: {},
    });
    expect(patchRes.statusCode).toBe(404);
  });
});
