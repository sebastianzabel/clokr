/**
 * The first test coverage GET /api/v1/avatars/:employeeId has ever had. Measured (phase 258
 * research): zero existing tests exercised this route before this file — sec-08 and sec-09
 * cover POST and DELETE only. That gap is why the phase's 404→204 change for "no avatar
 * stored" would have been neither caught if it were done wrong, nor proven if it were done
 * right (D-04b).
 *
 * This file writes ONLY the three outcomes that must NOT change when that flip lands in the
 * next task (avatars.ts task 2). They are run and confirmed green against the UNMODIFIED
 * handler below, so they are pins, not expectations. The 204 case, and the T-100-09
 * tenant-oracle cases, belong to task 2 and are written red there — adding them here would
 * mean editing this file again in task 2 to let the change through, which is the "not a pin"
 * failure mode this project has already paid for once (T-110-11).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

describe("GET /api/v1/avatars/:employeeId — outcomes phase 258 must NOT change (avatars-get)", () => {
  let app: FastifyInstance;
  let tenantA: Awaited<ReturnType<typeof seedTestData>>;
  let tenantB: Awaited<ReturnType<typeof seedTestData>>;
  const uploadedPaths: string[] = [];

  beforeAll(async () => {
    app = await getTestApp();
    tenantA = await seedTestData(app, "avget-a");
    tenantB = await seedTestData(app, "avget-b");
  });

  afterAll(async () => {
    for (const path of uploadedPaths) {
      try {
        await app.storage.delete(path);
      } catch (err) {
        console.error(`Cleanup of storage object ${path} failed:`, err);
      }
    }
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

  it("own tenant, avatarPath set and readable → 200 + image/webp + the cache header", async () => {
    const path = `avatars/${tenantA.tenant.id}/${tenantA.employee.id}.webp`;
    const bytes = Buffer.from("fake-webp-bytes-for-avatars-get-happy-path");
    await app.storage.upload(path, bytes, "image/webp");
    uploadedPaths.push(path);
    await app.prisma.employee.update({
      where: { id: tenantA.employee.id },
      data: { avatarPath: path },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/avatars/${tenantA.employee.id}`,
      headers: { authorization: `Bearer ${tenantA.empToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("image/webp");
    expect(res.headers["cache-control"]).toBe("private, max-age=3600");
    expect(res.rawPayload.length).toBe(bytes.length);
  });

  it("own tenant, avatarPath set but the file is missing in storage → 404 (D-03, untouched by this phase)", async () => {
    // A path that points nowhere is a genuine failure, not the "nothing stored" business
    // state — phase 258 only changes the "avatarPath is null" branch below, not this one.
    await app.prisma.employee.update({
      where: { id: tenantA.employee.id },
      data: { avatarPath: "avatars/does-not-exist/nope.webp" },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/avatars/${tenantA.employee.id}`,
      headers: { authorization: `Bearer ${tenantA.empToken}` },
    });

    expect(res.statusCode).toBe(404);
  });

  it("unknown employee id → 404 (status only — task 2 changes the body as part of the oracle guard)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/avatars/00000000-0000-0000-0000-000000000000",
      headers: { authorization: `Bearer ${tenantA.empToken}` },
    });

    // Status only, deliberately: today's body is {"error":"Kein Avatar vorhanden"}, and task 2
    // changes it to {"error":"Mitarbeiter nicht gefunden"} as part of the T-100-09 guard. Pinning
    // the body here would force an edit to this file in task 2 — exactly what this task avoids.
    // Task 2 pins the body once, where it is load-bearing (the oracle equality assertion).
    expect(res.statusCode).toBe(404);
  });

  // ── Task 2: the T-100-09 tenant guard and the 204 empty state. Written RED against the ──
  // ── unmodified handler above; task 2's action makes them pass.                          ──

  it("own tenant, no avatarPath at all → 204, empty body (phase 258, D-01)", async () => {
    await app.prisma.employee.update({
      where: { id: tenantA.employee.id },
      data: { avatarPath: null },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/avatars/${tenantA.employee.id}`,
      headers: { authorization: `Bearer ${tenantA.empToken}` },
    });

    expect(res.statusCode).toBe(204);
    expect(res.rawPayload.length).toBe(0);
    expect(res.body).toBe("");
  });

  it("foreign tenant, employee WITHOUT an avatar → the byte-identical 404 as an unknown id (T-100-09)", async () => {
    await app.prisma.employee.update({
      where: { id: tenantB.employee.id },
      data: { avatarPath: null },
    });

    const notFound = await app.inject({
      method: "GET",
      url: "/api/v1/avatars/00000000-0000-0000-0000-000000000000",
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/avatars/${tenantB.employee.id}`,
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
    });

    // Compared against the captured unknown-id response, not a string literal: the invariant
    // being pinned is "indistinguishable", not "equals this particular German sentence".
    expect(res.statusCode).toBe(notFound.statusCode);
    expect(res.body).toBe(notFound.body);
  });

  it("foreign tenant, employee WITH an avatar → the byte-identical 404 as an unknown id (T-100-09, was 403)", async () => {
    await app.prisma.employee.update({
      where: { id: tenantB.employee.id },
      data: { avatarPath: `avatars/${tenantB.tenant.id}/${tenantB.employee.id}.webp` },
    });

    const notFound = await app.inject({
      method: "GET",
      url: "/api/v1/avatars/00000000-0000-0000-0000-000000000000",
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/avatars/${tenantB.employee.id}`,
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
    });

    expect(res.statusCode).toBe(notFound.statusCode);
    expect(res.body).toBe(notFound.body);
  });

  it("CROSS_TENANT_ACCESS_DENIED is audited for a real foreign employee, and NOT for an unknown id", async () => {
    await app.prisma.employee.update({
      where: { id: tenantB.employee.id },
      data: { avatarPath: null },
    });

    await app.inject({
      method: "GET",
      url: `/api/v1/avatars/${tenantB.employee.id}`,
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
    });

    const auditForRealEmployee = await app.prisma.auditLog.findFirst({
      where: { action: "CROSS_TENANT_ACCESS_DENIED", entityId: tenantB.employee.id },
    });
    expect(auditForRealEmployee).not.toBeNull();

    const unknownId = "00000000-0000-0000-0000-000000000001";
    await app.inject({
      method: "GET",
      url: `/api/v1/avatars/${unknownId}`,
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
    });

    const auditForUnknownId = await app.prisma.auditLog.findFirst({
      where: { action: "CROSS_TENANT_ACCESS_DENIED", entityId: unknownId },
    });
    expect(auditForUnknownId).toBeNull();
  });
});
