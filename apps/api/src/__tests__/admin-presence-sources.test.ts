import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

const BASE = "/api/v1/admin/presence-sources";

describe("admin-presence-sources", () => {
  let app: FastifyInstance;
  let adminToken: string;
  let empToken: string;
  let tenantId: string;
  let employeeId: string;

  beforeAll(async () => {
    app = await getTestApp();
    const seed = await seedTestData(app, "presence-src");
    adminToken = seed.adminToken;
    empToken = seed.empToken;
    tenantId = seed.tenant.id;
    employeeId = seed.employee.id;
  });

  afterAll(async () => {
    try {
      // Clean up PresenceDevice and PresenceSource before cleanupTestData (FK constraints)
      await app.prisma.presenceDevice.deleteMany({ where: { tenantId } });
      await app.prisma.presenceSource.deleteMany({ where: { tenantId } });
      await cleanupTestData(app, tenantId);
    } catch (err) {
      console.error("Cleanup failed:", err);
    }
  });

  // ── GET / — list ──────────────────────────────────────────────

  it("GET / as ADMIN returns empty list on fresh tenant", async () => {
    const res = await app.inject({
      method: "GET",
      url: BASE,
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.sources).toBeInstanceOf(Array);
    expect(body.sources.length).toBe(0);
  });

  it("GET / as EMPLOYEE returns 403", async () => {
    const res = await app.inject({
      method: "GET",
      url: BASE,
      headers: { authorization: `Bearer ${empToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  // ── POST / — create ───────────────────────────────────────────

  it("POST / as ADMIN creates source and returns rawKey", async () => {
    const res = await app.inject({
      method: "POST",
      url: BASE,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: "Büro FritzBox" },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.id).toBeDefined();
    expect(body.name).toBe("Büro FritzBox");
    expect(body.rawKey).toBeDefined();
    expect(body.rawKey).toMatch(/^clk_/);
    expect(body.keyPrefix).toBeDefined();
    expect(body.keyPrefix).toMatch(/\.\.\.$/);
    expect(body.isActive).toBe(true);
  });

  it("POST / as EMPLOYEE returns 403", async () => {
    const res = await app.inject({
      method: "POST",
      url: BASE,
      headers: { authorization: `Bearer ${empToken}` },
      payload: { name: "Test" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("POST / with missing name returns 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: BASE,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("GET / after POST lists the new source without rawKey", async () => {
    const res = await app.inject({
      method: "GET",
      url: BASE,
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.sources.length).toBeGreaterThanOrEqual(1);
    // rawKey must NOT appear in list items
    for (const source of body.sources) {
      expect(source.rawKey).toBeUndefined();
      expect(source.keyHash).toBeUndefined();
    }
  });

  // ── PATCH /:id — update ───────────────────────────────────────

  it("PATCH /:id as ADMIN updates name and creates audit log", async () => {
    // Create a source to patch
    const createRes = await app.inject({
      method: "POST",
      url: BASE,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: "Original Name" },
    });
    const { id } = JSON.parse(createRes.body);

    const res = await app.inject({
      method: "PATCH",
      url: `${BASE}/${id}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: "Updated Name" },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.name).toBe("Updated Name");

    // Verify audit log
    const audit = await app.prisma.auditLog.findFirst({
      where: { entity: "PresenceSource", entityId: id, action: "UPDATE" },
    });
    expect(audit).not.toBeNull();
    expect((audit!.newValue as Record<string, unknown>).name).toBe("Updated Name");
    expect((audit!.oldValue as Record<string, unknown>).name).toBe("Original Name");
  });

  it("PATCH /:id with empty body returns 400", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: BASE,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: "Empty Patch Test" },
    });
    const { id } = JSON.parse(createRes.body);

    const res = await app.inject({
      method: "PATCH",
      url: `${BASE}/${id}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("PATCH /:id on nonexistent id returns 404", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `${BASE}/00000000-0000-0000-0000-000000000000`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: "Ghost" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("PATCH /:id as EMPLOYEE returns 403", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: BASE,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: "Role Gate Test PATCH" },
    });
    const { id } = JSON.parse(createRes.body);

    const res = await app.inject({
      method: "PATCH",
      url: `${BASE}/${id}`,
      headers: { authorization: `Bearer ${empToken}` },
      payload: { name: "Hacked" },
    });
    expect(res.statusCode).toBe(403);
  });

  // ── DELETE /:id — soft delete ─────────────────────────────────

  it("DELETE /:id as ADMIN soft-deletes and creates audit log", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: BASE,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: "To Be Deleted" },
    });
    const { id } = JSON.parse(createRes.body);

    const res = await app.inject({
      method: "DELETE",
      url: `${BASE}/${id}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);

    // Verify audit log
    const audit = await app.prisma.auditLog.findFirst({
      where: { entity: "PresenceSource", entityId: id, action: "DELETE" },
    });
    expect(audit).not.toBeNull();

    // Verify source is soft-deleted (not in list)
    const listRes = await app.inject({
      method: "GET",
      url: BASE,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const listBody = JSON.parse(listRes.body);
    const found = listBody.sources.find((s: { id: string }) => s.id === id);
    expect(found).toBeUndefined();

    // Verify deletedAt and isActive in DB
    const dbRecord = await app.prisma.presenceSource.findUnique({ where: { id } });
    expect(dbRecord!.deletedAt).not.toBeNull();
    expect(dbRecord!.isActive).toBe(false);
  });

  it("DELETE /:id on already-deleted source returns 404", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: BASE,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: "Double Delete Test" },
    });
    const { id } = JSON.parse(createRes.body);

    // First delete
    await app.inject({
      method: "DELETE",
      url: `${BASE}/${id}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });

    // Second delete should return 404
    const res = await app.inject({
      method: "DELETE",
      url: `${BASE}/${id}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it("DELETE /:id as EMPLOYEE returns 403", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: BASE,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: "Role Gate Test DELETE" },
    });
    const { id } = JSON.parse(createRes.body);

    const res = await app.inject({
      method: "DELETE",
      url: `${BASE}/${id}`,
      headers: { authorization: `Bearer ${empToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  // ── GET /:id/devices — adapter proxy ──────────────────────────

  it("GET /:id/devices with no adapterUrl returns 502", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: BASE,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: "No Adapter URL" },
    });
    const { id } = JSON.parse(createRes.body);

    const res = await app.inject({
      method: "GET",
      url: `${BASE}/${id}/devices`,
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(res.statusCode).toBe(502);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("Kein Adapter-URL konfiguriert");
  });

  it("GET /:id/devices as EMPLOYEE returns 403", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: BASE,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: "Devices Role Gate" },
    });
    const { id } = JSON.parse(createRes.body);

    const res = await app.inject({
      method: "GET",
      url: `${BASE}/${id}/devices`,
      headers: { authorization: `Bearer ${empToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  // ── POST /:id/devices/:mac/assign ─────────────────────────────

  it("POST /:id/devices/:mac/assign creates PresenceDevice mapping", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: BASE,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: "Assign Test Source" },
    });
    const { id: sourceId } = JSON.parse(createRes.body);

    const res = await app.inject({
      method: "POST",
      url: `${BASE}/${sourceId}/devices/AA:BB:CC:DD:EE:FF/assign`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { employeeId },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.employeeId).toBe(employeeId);
    expect(body.mac).toBe("aa:bb:cc:dd:ee:ff"); // normalized

    // Verify audit log
    const device = await app.prisma.presenceDevice.findFirst({
      where: { tenantId, mac: "aa:bb:cc:dd:ee:ff" },
    });
    expect(device).not.toBeNull();

    const audit = await app.prisma.auditLog.findFirst({
      where: { entity: "PresenceDevice", entityId: device!.id, action: "ASSIGN_DEVICE" },
    });
    expect(audit).not.toBeNull();
  });

  it("POST /:id/devices/:mac/assign as EMPLOYEE returns 403", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: BASE,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: "Assign Role Gate" },
    });
    const { id: sourceId } = JSON.parse(createRes.body);

    const res = await app.inject({
      method: "POST",
      url: `${BASE}/${sourceId}/devices/AA:BB:CC:DD:EE:FF/assign`,
      headers: { authorization: `Bearer ${empToken}` },
      payload: { employeeId },
    });
    expect(res.statusCode).toBe(403);
  });

  // ── GET /opted-in — opted-in employees ───────────────────────

  it("GET /opted-in as ADMIN returns only opted-in employees", async () => {
    const res = await app.inject({
      method: "GET",
      url: `${BASE}/opted-in`,
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.employees).toBeInstanceOf(Array);
    // No employees opted in yet in fresh test tenant
    expect(
      body.employees.every((e: { wifiPresenceEnabled: boolean }) => e.wifiPresenceEnabled),
    ).toBe(true);
  });

  it("GET /opted-in as EMPLOYEE returns 403", async () => {
    const res = await app.inject({
      method: "GET",
      url: `${BASE}/opted-in`,
      headers: { authorization: `Bearer ${empToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  // ── AuditLog verification for CREATE ─────────────────────────

  it("POST / creates a CREATE audit log entry for PresenceSource", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: BASE,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: "Audit Log Test Source" },
    });
    expect(createRes.statusCode).toBe(201);
    const { id } = JSON.parse(createRes.body);

    const audit = await app.prisma.auditLog.findFirst({
      where: { entity: "PresenceSource", entityId: id, action: "CREATE" },
    });
    expect(audit).not.toBeNull();
    expect(audit!.entity).toBe("PresenceSource");
    expect(audit!.action).toBe("CREATE");
    expect((audit!.newValue as Record<string, unknown>).name).toBe("Audit Log Test Source");
  });
});
