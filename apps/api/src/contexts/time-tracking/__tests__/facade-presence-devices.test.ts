/**
 * Phase 100B Plan 09 (Wave 4, closing) — focused integration test for the Zeiterfassung
 * `PresenceDevice` facade.
 *
 * The membership test below is the point of this file (100B-09-PLAN.md Task 1/Task 2): it proves
 * `getPresenceDevice`/`deletePresenceDevice`'s `{ id, employeeId }` constraint actually rejects a
 * cross-employee lookup — the whole safety argument for replacing `fetch-then-compare` with an
 * inline-principal-field proof (D-13/G3). `data.employee` and `data.adminEmployee` are two
 * distinct employees in the SAME tenant (`seedTestData`'s own shape), which is exactly what this
 * test needs: a same-tenant, different-employee id must still be rejected, proving the constraint
 * is on `employeeId`, not merely on `tenantId`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../../__tests__/setup";
import {
  listPresenceDevices,
  findPresenceDeviceByMac,
  createPresenceDevice,
  getPresenceDevice,
  deletePresenceDevice,
} from "../index";
import type { FastifyInstance } from "fastify";

describe("Zeiterfassung facade — PresenceDevice (Phase 100B Plan 09)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let otherTenantData: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "pd-facade");
    otherTenantData = await seedTestData(app, "pd-facade-other");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
      await cleanupTestData(app, otherTenantData.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  describe("createPresenceDevice / findPresenceDeviceByMac", () => {
    it("creates a device and the mac lookup finds it within the same tenant", async () => {
      const created = await createPresenceDevice(app.prisma, {
        tenantId: data.tenant.id,
        employeeId: data.employee.id,
        mac: "aa:bb:cc:dd:ee:01",
        label: "Test-Gerät",
      });
      expect(created.mac).toBe("aa:bb:cc:dd:ee:01");
      expect(created.label).toBe("Test-Gerät");

      const found = await findPresenceDeviceByMac(app.prisma, "aa:bb:cc:dd:ee:01", data.tenant.id);
      expect(found?.id).toBe(created.id);
      expect(found?.employeeId).toBe(data.employee.id);
    });

    it("the same mac in a DIFFERENT tenant is not found — the uniqueness is per-tenant", async () => {
      const found = await findPresenceDeviceByMac(
        app.prisma,
        "aa:bb:cc:dd:ee:01",
        otherTenantData.tenant.id,
      );
      expect(found).toBeNull();
    });
  });

  describe("listPresenceDevices", () => {
    it("lists only the given employee's devices, ordered by addedAt", async () => {
      await createPresenceDevice(app.prisma, {
        tenantId: data.tenant.id,
        employeeId: data.employee.id,
        mac: "aa:bb:cc:dd:ee:02",
      });
      // A second employee's device in the SAME tenant must not appear in the first employee's list.
      await createPresenceDevice(app.prisma, {
        tenantId: data.tenant.id,
        employeeId: data.adminEmployee.id,
        mac: "aa:bb:cc:dd:ee:03",
      });

      const list = await listPresenceDevices(app.prisma, data.employee.id, data.tenant.id);
      const macs = list.map((d) => d.mac);
      expect(macs).toContain("aa:bb:cc:dd:ee:01");
      expect(macs).toContain("aa:bb:cc:dd:ee:02");
      expect(macs).not.toContain("aa:bb:cc:dd:ee:03");
    });
  });

  describe("getPresenceDevice / deletePresenceDevice — the employeeId constraint", () => {
    it("finds a device that belongs to the given employeeId", async () => {
      const created = await createPresenceDevice(app.prisma, {
        tenantId: data.tenant.id,
        employeeId: data.employee.id,
        mac: "aa:bb:cc:dd:ee:04",
      });

      const found = await getPresenceDevice(app.prisma, created.id, data.employee.id);
      expect(found).not.toBeNull();
      expect(found?.mac).toBe("aa:bb:cc:dd:ee:04");
    });

    it("does NOT find a device that belongs to a DIFFERENT employee in the SAME tenant — the whole safety argument", async () => {
      const created = await createPresenceDevice(app.prisma, {
        tenantId: data.tenant.id,
        employeeId: data.employee.id,
        mac: "aa:bb:cc:dd:ee:05",
      });

      // adminEmployee is a different employee in the SAME tenant (seedTestData's own shape) —
      // a tenant-only constraint would incorrectly let this through; only employeeId rejects it.
      const foundByOther = await getPresenceDevice(app.prisma, created.id, data.adminEmployee.id);
      expect(foundByOther).toBeNull();
    });

    it("does not find a device that does not exist at all — same null as the wrong-owner case", async () => {
      const found = await getPresenceDevice(
        app.prisma,
        "00000000-0000-0000-0000-000000000000",
        data.employee.id,
      );
      expect(found).toBeNull();
    });

    it("deletes a device that belongs to the given employeeId", async () => {
      const created = await createPresenceDevice(app.prisma, {
        tenantId: data.tenant.id,
        employeeId: data.employee.id,
        mac: "aa:bb:cc:dd:ee:06",
      });

      await deletePresenceDevice(app.prisma, created.id, data.employee.id);

      const found = await getPresenceDevice(app.prisma, created.id, data.employee.id);
      expect(found).toBeNull();
    });

    it("does NOT delete a device that belongs to a DIFFERENT employee — throws P2025 rather than deleting the wrong row", async () => {
      const created = await createPresenceDevice(app.prisma, {
        tenantId: data.tenant.id,
        employeeId: data.employee.id,
        mac: "aa:bb:cc:dd:ee:07",
      });

      await expect(
        deletePresenceDevice(app.prisma, created.id, data.adminEmployee.id),
      ).rejects.toThrow();

      // The row must still exist — the scoped delete refused to touch it.
      const stillThere = await getPresenceDevice(app.prisma, created.id, data.employee.id);
      expect(stillThere).not.toBeNull();
    });
  });
});
