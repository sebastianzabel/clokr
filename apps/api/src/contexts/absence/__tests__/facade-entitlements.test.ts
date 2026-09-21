/**
 * Phase 100B Plan 10 (Wave 5, opening) — focused integration test for the Abwesenheiten
 * `LeaveType`/`LeaveEntitlement` facade (A11-A19 plus the two H1 deviation-preserving siblings).
 *
 * `seedTestData()` already provisions one `LeaveType` (`vacationType`, code `VACATION`, name
 * "Urlaub" via `leaveTypeFields("VACATION")`) and one `LeaveEntitlement` row for the current
 * (offset) year — this file's fixtures build on top of that rather than re-seeding it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  SEED_YEAR_OFFSET,
} from "../../../__tests__/setup";
import {
  getLeaveTypeByCode,
  getLeaveTypeByDisplayName,
  listLeaveTypes,
  updateLeaveType,
  getVacationEntitlement,
  listEntitlementsForYear,
  getEntitlementsForEmployee,
  getEntitlementById,
  getExpiringCarryOver,
  upsertVacationEntitlement,
  getVacationEntitlementByDisplayName,
  getVacationEntitlementsForYearByDisplayName,
  hardDeleteEntitlementsForEmployee,
} from "../index";
import type { FastifyInstance } from "fastify";

describe("Abwesenheiten facade — LeaveType/LeaveEntitlement (Phase 100B Plan 10)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let otherData: Awaited<ReturnType<typeof seedTestData>>;
  const year = new Date().getFullYear() + SEED_YEAR_OFFSET;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "entitlements-facade");
    otherData = await seedTestData(app, "entitlements-facade-other");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
      await cleanupTestData(app, otherData.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  describe("getLeaveTypeByCode (A17)", () => {
    it("finds the seeded VACATION type for its own tenant", async () => {
      const found = await getLeaveTypeByCode(app.prisma, data.tenant.id, "VACATION");
      expect(found?.id).toBe(data.vacationType.id);
    });

    it("does not find another tenant's VACATION type", async () => {
      const found = await getLeaveTypeByCode(app.prisma, data.tenant.id, "VACATION");
      expect(found?.id).not.toBe(otherData.vacationType.id);
    });

    it("returns null for a code the tenant has no row for", async () => {
      const found = await getLeaveTypeByCode(app.prisma, data.tenant.id, "SPECIAL");
      expect(found).toBeNull();
    });
  });

  describe("getLeaveTypeByDisplayName (H1)", () => {
    it("finds the seeded type by its display name 'Urlaub'", async () => {
      const found = await getLeaveTypeByDisplayName(app.prisma, data.tenant.id, "Urlaub");
      expect(found?.id).toBe(data.vacationType.id);
    });

    it("returns null once the tenant renames the display name away from 'Urlaub' — the H1 deviation, reproduced not fixed", async () => {
      await app.prisma.leaveType.update({
        where: { id: data.vacationType.id },
        data: { name: "Jahresurlaub (umbenannt)" },
      });
      try {
        const found = await getLeaveTypeByDisplayName(app.prisma, data.tenant.id, "Urlaub");
        expect(found).toBeNull();
      } finally {
        await app.prisma.leaveType.update({
          where: { id: data.vacationType.id },
          data: { name: "Urlaub" },
        });
      }
    });
  });

  describe("listLeaveTypes (A18)", () => {
    it("lists only this tenant's leave types, ordered by name", async () => {
      const extra = await app.prisma.leaveType.create({
        data: { tenantId: data.tenant.id, code: "SICK", name: "Krankmeldung" },
      });
      try {
        const types = await listLeaveTypes(app.prisma, data.tenant.id);
        const ids = types.map((t) => t.id);
        expect(ids).toContain(data.vacationType.id);
        expect(ids).toContain(extra.id);
        expect(ids).not.toContain(otherData.vacationType.id);
        const names = types.map((t) => t.name);
        expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
      } finally {
        await app.prisma.leaveType.delete({ where: { id: extra.id } });
      }
    });
  });

  describe("updateLeaveType (A19, H3)", () => {
    it("updates a leave type for its own tenant and returns the pre-update values", async () => {
      const result = await updateLeaveType(app.prisma, data.tenant.id, data.vacationType.id, {
        allowHalfDay: false,
      });
      expect(result).not.toBeNull();
      expect(result?.existing.allowHalfDay).toBe(true);
      expect(result?.updated.allowHalfDay).toBe(false);
      // restore
      await app.prisma.leaveType.update({
        where: { id: data.vacationType.id },
        data: { allowHalfDay: true },
      });
    });

    it("returns null for a foreign-tenant id — the same 404 shape as a missing id", async () => {
      const result = await updateLeaveType(app.prisma, data.tenant.id, otherData.vacationType.id, {
        allowHalfDay: false,
      });
      expect(result).toBeNull();
      // prove the foreign row was NOT touched
      const untouched = await app.prisma.leaveType.findUnique({
        where: { id: otherData.vacationType.id },
      });
      expect(untouched?.allowHalfDay).toBe(true);
    });

    it("returns null for a nonexistent id", async () => {
      const result = await updateLeaveType(
        app.prisma,
        data.tenant.id,
        "00000000-0000-0000-0000-000000000000",
        {
          allowHalfDay: false,
        },
      );
      expect(result).toBeNull();
    });
  });

  describe("getVacationEntitlement (A11)", () => {
    it("resolves the VACATION type by code and returns the seeded entitlement", async () => {
      const result = await getVacationEntitlement(
        app.prisma,
        data.employee.id,
        data.tenant.id,
        year,
      );
      expect(result?.leaveTypeId).toBe(data.vacationType.id);
      expect(result?.entitlement?.employeeId).toBe(data.employee.id);
    });

    it("returns leaveTypeId with entitlement null for a year with no row yet", async () => {
      const result = await getVacationEntitlement(
        app.prisma,
        data.employee.id,
        data.tenant.id,
        year + 5,
      );
      expect(result?.leaveTypeId).toBe(data.vacationType.id);
      expect(result?.entitlement).toBeNull();
    });

    it("does not leak another tenant's entitlement for the same employeeId/year shape", async () => {
      const result = await getVacationEntitlement(
        app.prisma,
        otherData.employee.id,
        data.tenant.id,
        year,
      );
      expect(result?.entitlement).toBeNull();
    });
  });

  describe("upsertVacationEntitlement (A16)", () => {
    it("creates then updates the vacation entitlement for a fresh year", async () => {
      const created = await upsertVacationEntitlement(
        app.prisma,
        data.employee.id,
        data.tenant.id,
        year + 6,
        {
          totalDays: 20,
          carriedOverDays: 0,
          carryOverDeadline: null,
        },
      );
      expect(Number(created?.totalDays)).toBe(20);

      const updated = await upsertVacationEntitlement(
        app.prisma,
        data.employee.id,
        data.tenant.id,
        year + 6,
        {
          totalDays: 25,
          carriedOverDays: 2,
          carryOverDeadline: null,
        },
      );
      expect(Number(updated?.totalDays)).toBe(25);
      expect(Number(updated?.carriedOverDays)).toBe(2);
    });
  });

  describe("listEntitlementsForYear (A12) / getEntitlementsForEmployee (A13)", () => {
    it("listEntitlementsForYear is tenant-wide", async () => {
      const rows = await listEntitlementsForYear(app.prisma, data.tenant.id, year);
      expect(rows.map((r) => r.employeeId)).toContain(data.employee.id);
      expect(rows.map((r) => r.employeeId)).not.toContain(otherData.employee.id);
    });

    it("getEntitlementsForEmployee is per-employee AND tenant-constrained even when the tenant is wrong", async () => {
      const ownRows = await getEntitlementsForEmployee(
        app.prisma,
        data.employee.id,
        data.tenant.id,
        year,
      );
      expect(ownRows.length).toBeGreaterThan(0);

      const crossTenant = await getEntitlementsForEmployee(
        app.prisma,
        data.employee.id,
        otherData.tenant.id,
        year,
      );
      expect(crossTenant).toEqual([]);
    });
  });

  describe("getEntitlementById (A14, T-100B-43)", () => {
    it("finds the entitlement for its own tenant", async () => {
      const own = await getVacationEntitlement(app.prisma, data.employee.id, data.tenant.id, year);
      const found = await getEntitlementById(app.prisma, data.tenant.id, own!.entitlement!.id);
      expect(found?.id).toBe(own!.entitlement!.id);
    });

    it("returns null for a foreign tenant's entitlement id — the exact fetch-then-compare shape it replaces", async () => {
      const foreign = await getVacationEntitlement(
        app.prisma,
        otherData.employee.id,
        otherData.tenant.id,
        year,
      );
      const found = await getEntitlementById(app.prisma, data.tenant.id, foreign!.entitlement!.id);
      expect(found).toBeNull();
    });
  });

  describe("getExpiringCarryOver (A15, H2)", () => {
    it("finds an entitlement whose carry-over deadline is inside the window and excludes one outside it", async () => {
      const now = new Date();
      const insideWindow = new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000);
      const outsideWindow = new Date(now.getTime() + 200 * 24 * 60 * 60 * 1000);

      await app.prisma.leaveEntitlement.update({
        where: {
          employeeId_leaveTypeId_year: {
            employeeId: data.employee.id,
            leaveTypeId: data.vacationType.id,
            year,
          },
        },
        data: { carriedOverDays: 3, carryOverDeadline: insideWindow },
      });
      await app.prisma.leaveEntitlement.upsert({
        where: {
          employeeId_leaveTypeId_year: {
            employeeId: otherData.employee.id,
            leaveTypeId: otherData.vacationType.id,
            year,
          },
        },
        update: { carriedOverDays: 3, carryOverDeadline: outsideWindow },
        create: {
          employeeId: otherData.employee.id,
          leaveTypeId: otherData.vacationType.id,
          year,
          totalDays: 30,
          carriedOverDays: 3,
          carryOverDeadline: outsideWindow,
        },
      });

      const cutoff = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000);
      const rows = await getExpiringCarryOver(app.prisma, data.tenant.id, now, cutoff);
      const ids = rows.map((r) => r.employeeId);
      expect(ids).toContain(data.employee.id);
      expect(ids).not.toContain(otherData.employee.id);
    });
  });

  describe("getVacationEntitlementByDisplayName / getVacationEntitlementsForYearByDisplayName (H1)", () => {
    it("getVacationEntitlementByDisplayName finds the entitlement via the 'Urlaub'-named type", async () => {
      const found = await getVacationEntitlementByDisplayName(
        app.prisma,
        data.employee.id,
        data.tenant.id,
        year,
      );
      expect(found?.employeeId).toBe(data.employee.id);
    });

    it("the vacation entitlement is still found after the tenant renames the VACATION type (Issue #205, finding 2)", async () => {
      await app.prisma.leaveType.update({
        where: { id: data.vacationType.id },
        data: { name: "Jahresurlaub (umbenannt)" },
      });
      try {
        const found = await getVacationEntitlement(
          app.prisma,
          data.employee.id,
          data.tenant.id,
          year,
        );
        expect(found).not.toBeNull();
        expect(found?.entitlement).not.toBeNull();
        expect(found?.entitlement?.employeeId).toBe(data.employee.id);
      } finally {
        await app.prisma.leaveType.update({
          where: { id: data.vacationType.id },
          data: { name: "Urlaub" },
        });
      }
    });

    it("the vacation entitlement is found the same way when the tenant never renamed the type (AK-5 twin)", async () => {
      const found = await getVacationEntitlement(
        app.prisma,
        data.employee.id,
        data.tenant.id,
        year,
      );
      expect(found).not.toBeNull();
      expect(found?.entitlement).not.toBeNull();
      expect(found?.entitlement?.employeeId).toBe(data.employee.id);
    });

    it("getVacationEntitlementsForYearByDisplayName is tenant-wide and name-filtered", async () => {
      const rows = await getVacationEntitlementsForYearByDisplayName(
        app.prisma,
        data.tenant.id,
        year,
      );
      expect(rows.map((r) => r.employee.id)).toContain(data.employee.id);
      expect(rows.map((r) => r.employee.id)).not.toContain(otherData.employee.id);
    });
  });

  describe("hardDeleteEntitlementsForEmployee (F3)", () => {
    it("deletes every LeaveEntitlement row for the employee", async () => {
      const before = await app.prisma.leaveEntitlement.findMany({
        where: { employeeId: data.employee.id },
      });
      expect(before.length).toBeGreaterThan(0);

      await hardDeleteEntitlementsForEmployee(app.prisma, data.employee.id);

      const after = await app.prisma.leaveEntitlement.findMany({
        where: { employeeId: data.employee.id },
      });
      expect(after).toEqual([]);
    });

    it("rolls back with the rest of its transaction on a later failure — proves it runs on the passed-in client, not a captured app.prisma", async () => {
      await app.prisma.leaveEntitlement.create({
        data: {
          employeeId: otherData.employee.id,
          leaveTypeId: otherData.vacationType.id,
          year: year + 7,
          totalDays: 10,
        },
      });

      await expect(
        app.prisma.$transaction(async (tx) => {
          await hardDeleteEntitlementsForEmployee(tx, otherData.employee.id);
          throw new Error("forced rollback");
        }),
      ).rejects.toThrow("forced rollback");

      const survived = await app.prisma.leaveEntitlement.findFirst({
        where: { employeeId: otherData.employee.id, year: year + 7 },
      });
      expect(survived).not.toBeNull();
    });
  });
});
