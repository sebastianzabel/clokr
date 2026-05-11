import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

describe("Employee self-service WiFi API", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  // IDs created during tests — used for cross-test references and cleanup guards
  let device1Id: string;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "mw");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  // ── Auth guard ─────────────────────────────────────────────────────────────

  describe("Auth guard", () => {
    it("GET /me/wifi without token → 401", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/employees/me/wifi",
      });
      expect(res.statusCode).toBe(401);
    });

    it("POST /me/wifi/devices without token → 401", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/employees/me/wifi/devices",
        payload: { mac: "AA:BB:CC:DD:EE:FF" },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  // ── GET /me/wifi — own-data scope ─────────────────────────────────────────

  describe("GET /me/wifi", () => {
    it("returns own wifi data with empty device list on fresh employee", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/employees/me/wifi",
        headers: { authorization: `Bearer ${data.empToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.wifiPresenceEnabled).toBe(false);
      expect(body.wifiOptInAt).toBeNull();
      expect(body.devices).toEqual([]);
    });
  });

  // ── PATCH /me/wifi — opt-in toggle ────────────────────────────────────────

  describe("PATCH /me/wifi — opt-in toggle", () => {
    it("enabling wifiPresenceEnabled stamps wifiOptInAt", async () => {
      const before = new Date();

      const res = await app.inject({
        method: "PATCH",
        url: "/api/v1/employees/me/wifi",
        headers: { authorization: `Bearer ${data.empToken}` },
        payload: { wifiPresenceEnabled: true },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.wifiPresenceEnabled).toBe(true);
      expect(body.wifiOptInAt).not.toBeNull();
      expect(new Date(body.wifiOptInAt).getTime()).toBeGreaterThanOrEqual(before.getTime());
    });

    it("disabling wifiPresenceEnabled clears flag but preserves wifiOptInAt", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/v1/employees/me/wifi",
        headers: { authorization: `Bearer ${data.empToken}` },
        payload: { wifiPresenceEnabled: false },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.wifiPresenceEnabled).toBe(false);
      // wifiOptInAt must NOT be null — GDPR consent withdrawal trace
      expect(body.wifiOptInAt).not.toBeNull();
    });

    it("GET /me/wifi after opt-out reflects disabled flag with wifiOptInAt still set", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/employees/me/wifi",
        headers: { authorization: `Bearer ${data.empToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.wifiPresenceEnabled).toBe(false);
      expect(body.wifiOptInAt).not.toBeNull();
    });

    it("PATCH opt-in writes AuditLog entry with action UPDATE, entity Employee", async () => {
      const beforeTs = new Date();

      await app.inject({
        method: "PATCH",
        url: "/api/v1/employees/me/wifi",
        headers: { authorization: `Bearer ${data.empToken}` },
        payload: { wifiPresenceEnabled: true },
      });

      const logs = await app.prisma.auditLog.findMany({
        where: {
          entity: "Employee",
          action: "UPDATE",
          entityId: data.employee.id,
          createdAt: { gte: beforeTs },
        },
      });

      expect(logs.length).toBeGreaterThanOrEqual(1);
      const log = logs.find(
        (l) =>
          l.newValue !== null &&
          typeof l.newValue === "object" &&
          "wifiPresenceEnabled" in (l.newValue as object),
      );
      expect(log).toBeDefined();
      // purgeable must not be set to true — consent records are permanently retained
      // The audit plugin either omits the field (defaults false) or sets it explicitly false
      expect((log as { purgeable?: boolean }).purgeable).not.toBe(true);
    });
  });

  // ── POST /me/wifi/devices — MAC registration ──────────────────────────────

  describe("POST /me/wifi/devices — MAC registration", () => {
    it("registers a valid colon-separated MAC → 201, stored normalized", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/employees/me/wifi/devices",
        headers: { authorization: `Bearer ${data.empToken}` },
        payload: { mac: "AA:BB:CC:DD:EE:FF", label: "Testgerät 1" },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.mac).toBe("aa:bb:cc:dd:ee:ff");
      expect(body.label).toBe("Testgerät 1");
      expect(body.id).toBeDefined();
      device1Id = body.id;
    });

    it("registers a dash-separated MAC → 201, normalized to colon form", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/employees/me/wifi/devices",
        headers: { authorization: `Bearer ${data.empToken}` },
        payload: { mac: "11-22-33-44-55-66" },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.mac).toBe("11:22:33:44:55:66");
    });

    it("rejects an invalid MAC → 400", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/employees/me/wifi/devices",
        headers: { authorization: `Bearer ${data.empToken}` },
        payload: { mac: "not-a-mac" },
      });

      expect(res.statusCode).toBe(400);
    });

    it("duplicate MAC (same tenant) → 409 with German error message", async () => {
      // AA:BB:CC:DD:EE:FF was already registered above
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/employees/me/wifi/devices",
        headers: { authorization: `Bearer ${data.empToken}` },
        payload: { mac: "AA:BB:CC:DD:EE:FF" },
      });

      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.error).toBe("Dieses Gerät ist bereits registriert");
    });

    it("POST /me/wifi/devices writes AuditLog entry with action CREATE, entity PresenceDevice", async () => {
      const beforeTs = new Date();

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/employees/me/wifi/devices",
        headers: { authorization: `Bearer ${data.empToken}` },
        payload: { mac: "AA:BB:CC:DD:EE:01" },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);

      const log = await app.prisma.auditLog.findFirst({
        where: {
          entity: "PresenceDevice",
          action: "CREATE",
          entityId: body.id,
          createdAt: { gte: beforeTs },
        },
      });

      expect(log).toBeDefined();
      expect(log!.action).toBe("CREATE");
      expect(log!.entity).toBe("PresenceDevice");
    });

    it("GET /me/wifi returns registered devices", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/employees/me/wifi",
        headers: { authorization: `Bearer ${data.empToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.devices.length).toBeGreaterThanOrEqual(1);
      const mac = body.devices.find((d: { mac: string }) => d.mac === "aa:bb:cc:dd:ee:ff");
      expect(mac).toBeDefined();
    });
  });

  // ── DELETE /me/wifi/devices/:id — own-data guard ──────────────────────────

  describe("DELETE /me/wifi/devices/:id — own-data guard", () => {
    it("employee cannot delete another employee's device → 403", async () => {
      // Create a second employee in the same tenant via admin
      const uid = Date.now().toString(36);
      const createRes = await app.inject({
        method: "POST",
        url: "/api/v1/employees",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          email: `emp2-${uid}@test.de`,
          firstName: "Zweiter",
          lastName: "Mitarbeiter",
          employeeNumber: `E2-${uid}`,
          hireDate: new Date("2026-01-01").toISOString(),
          role: "EMPLOYEE",
          weeklyHours: 40,
          password: "Test@1234567!",
        },
      });
      expect(createRes.statusCode).toBe(201);

      // Login as second employee
      const loginRes = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: `emp2-${uid}@test.de`, password: "Test@1234567!" },
      });
      expect(loginRes.statusCode).toBe(200);
      const { accessToken: emp2Token } = JSON.parse(loginRes.body);

      // Register a device as the second employee
      const deviceRes = await app.inject({
        method: "POST",
        url: "/api/v1/employees/me/wifi/devices",
        headers: { authorization: `Bearer ${emp2Token}` },
        payload: { mac: "FF:EE:DD:CC:BB:AA" },
      });
      expect(deviceRes.statusCode).toBe(201);
      const emp2DeviceId = JSON.parse(deviceRes.body).id;

      // First employee tries to delete second employee's device → 403
      const deleteRes = await app.inject({
        method: "DELETE",
        url: `/api/v1/employees/me/wifi/devices/${emp2DeviceId}`,
        headers: { authorization: `Bearer ${data.empToken}` },
      });

      expect(deleteRes.statusCode).toBe(403);
    });

    it("employee can delete their own device → 204", async () => {
      expect(device1Id).toBeDefined();

      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/employees/me/wifi/devices/${device1Id}`,
        headers: { authorization: `Bearer ${data.empToken}` },
      });

      expect(res.statusCode).toBe(204);

      // Verify device is gone
      const getRes = await app.inject({
        method: "GET",
        url: "/api/v1/employees/me/wifi",
        headers: { authorization: `Bearer ${data.empToken}` },
      });
      const body = JSON.parse(getRes.body);
      const found = body.devices.find((d: { id: string }) => d.id === device1Id);
      expect(found).toBeUndefined();
    });

    it("DELETE device writes AuditLog entry with action DELETE, entity PresenceDevice", async () => {
      // Register a fresh device to delete
      const regRes = await app.inject({
        method: "POST",
        url: "/api/v1/employees/me/wifi/devices",
        headers: { authorization: `Bearer ${data.empToken}` },
        payload: { mac: "DE:AD:BE:EF:CA:FE" },
      });
      expect(regRes.statusCode).toBe(201);
      const tempDeviceId = JSON.parse(regRes.body).id;

      const beforeTs = new Date();

      await app.inject({
        method: "DELETE",
        url: `/api/v1/employees/me/wifi/devices/${tempDeviceId}`,
        headers: { authorization: `Bearer ${data.empToken}` },
      });

      const log = await app.prisma.auditLog.findFirst({
        where: {
          entity: "PresenceDevice",
          action: "DELETE",
          entityId: tempDeviceId,
          createdAt: { gte: beforeTs },
        },
      });

      expect(log).toBeDefined();
      expect(log!.action).toBe("DELETE");
      expect(log!.entity).toBe("PresenceDevice");
    });

    it("DELETE non-existent device → 404", async () => {
      const res = await app.inject({
        method: "DELETE",
        url: "/api/v1/employees/me/wifi/devices/00000000-0000-0000-0000-000000000000",
        headers: { authorization: `Bearer ${data.empToken}` },
      });

      expect(res.statusCode).toBe(404);
    });
  });
});
