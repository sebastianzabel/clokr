/**
 * fix(sec-08): POST /api/v1/avatars/:employeeId compared its two rejection branches for
 * ADMIN/MANAGER callers and found them distinguishable — a foreign tenant's real employee
 * id got 403 "Keine Berechtigung", an id that exists nowhere got 404 "Mitarbeiter nicht
 * gefunden". That difference IS a tenant-membership oracle (Issue #259, T-100-09) — GET
 * and DELETE of the same file were already fixed in Phase 258, POST was left behind on
 * purpose and reported. Rewritten here the way `sec-09-avatars-delete-tenant.test.ts` was
 * rewritten for DELETE: byte-identical 404 for both arms, audited only when the probed
 * employee genuinely exists in a foreign tenant.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

/** Builds a minimal, valid multipart/form-data body for a single file field. */
function buildMultipartBody(filename: string, contentType: string, data: Buffer) {
  const boundary = "----clokrTestBoundary" + Math.random().toString(36).slice(2);
  const preamble = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
  );
  const epilogue = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    body: Buffer.concat([preamble, data, epilogue]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

// A genuine, decodable 2x2 JPEG — the avatar route runs its input through sharp().
const JPEG_BYTES = Buffer.from(
  "/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgj/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABykX//Z",
  "base64",
);

describe("POST /api/v1/avatars/:employeeId — tenant isolation (sec-08)", () => {
  let app: FastifyInstance;
  let tenantA: Awaited<ReturnType<typeof seedTestData>>;
  let tenantB: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    tenantA = await seedTestData(app, "sec08-a");
    tenantB = await seedTestData(app, "sec08-b");
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

  // Case A (AC-1/AC-2). Explicit state setup first, so this case is order-independent and
  // does not rely on running before case D (which sets tenantB's employee avatarPath).
  it("tenantA ADMIN uploading an avatar onto tenantB's employee → the byte-identical 404 as an unknown id (T-100-09, was 403), avatarPath untouched", async () => {
    await app.prisma.employee.update({
      where: { id: tenantB.employee.id },
      data: { avatarPath: null },
    });

    const { body, contentType } = buildMultipartBody("avatar.jpg", "image/jpeg", JPEG_BYTES);

    const notFound = await app.inject({
      method: "POST",
      url: "/api/v1/avatars/00000000-0000-0000-0000-000000000000",
      headers: { authorization: `Bearer ${tenantA.adminToken}`, "content-type": contentType },
      payload: body,
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/avatars/${tenantB.employee.id}`,
      headers: { authorization: `Bearer ${tenantA.adminToken}`, "content-type": contentType },
      payload: body,
    });

    // Compared against the captured unknown-id response, not a string literal: the invariant
    // is "indistinguishable", not "equals this particular German sentence" (T-100-09).
    expect(res.statusCode).toBe(notFound.statusCode);
    expect(res.body).toBe(notFound.body);

    const victimAfter = await app.prisma.employee.findUnique({
      where: { id: tenantB.employee.id },
    });
    expect(victimAfter?.avatarPath).toBeNull();
  });

  // Case B (AC-3), both directions in one case, mirroring sec-09's audit test.
  it("CROSS_TENANT_ACCESS_DENIED is audited for a real foreign employee, and NOT for an unknown id", async () => {
    const { body, contentType } = buildMultipartBody("avatar.jpg", "image/jpeg", JPEG_BYTES);

    await app.inject({
      method: "POST",
      url: `/api/v1/avatars/${tenantB.employee.id}`,
      headers: { authorization: `Bearer ${tenantA.adminToken}`, "content-type": contentType },
      payload: body,
    });

    const auditForRealEmployee = await app.prisma.auditLog.findFirst({
      where: { action: "CROSS_TENANT_ACCESS_DENIED", entityId: tenantB.employee.id },
    });
    expect(auditForRealEmployee).not.toBeNull();

    const unknownId = "00000000-0000-0000-0000-000000000002";
    await app.inject({
      method: "POST",
      url: `/api/v1/avatars/${unknownId}`,
      headers: { authorization: `Bearer ${tenantA.adminToken}`, "content-type": contentType },
      payload: body,
    });

    const auditForUnknownId = await app.prisma.auditLog.findFirst({
      where: { action: "CROSS_TENANT_ACCESS_DENIED", entityId: unknownId },
    });
    expect(auditForUnknownId).toBeNull();
  });

  // Case C (NEW, POST-specific): the same equality as case A but with NO payload and NO
  // content-type header on either arm. Proves the guard returns before `await req.file()`
  // (avatars.ts:36) is ever reached — a bodyless probe must get the 404, not a 400 "no file
  // uploaded". Plan 259-02's checker sends exactly this shape; without this case, that
  // checker's green on this route would be unproven.
  it("tenantA ADMIN probing tenantB's employee with NO body and NO content-type → still the byte-identical 404 (T-100-09, guard runs before req.file())", async () => {
    const notFound = await app.inject({
      method: "POST",
      url: "/api/v1/avatars/00000000-0000-0000-0000-000000000000",
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/avatars/${tenantB.employee.id}`,
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
    });

    expect(res.statusCode).toBe(notFound.statusCode);
    expect(res.body).toBe(notFound.body);
  });

  // Case D (kept, no regression): tenantB's OWN admin can still upload.
  it("the same upload by tenantB's OWN ADMIN still succeeds exactly as before (no regression)", async () => {
    const { body, contentType } = buildMultipartBody("avatar.jpg", "image/jpeg", JPEG_BYTES);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/avatars/${tenantB.employee.id}`,
      headers: { authorization: `Bearer ${tenantB.adminToken}`, "content-type": contentType },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    const victimAfter = await app.prisma.employee.findUnique({
      where: { id: tenantB.employee.id },
    });
    expect(victimAfter?.avatarPath).not.toBeNull();
  });

  // Case E (kept, no regression): self-upload still succeeds.
  it("self-upload by the employee themselves still succeeds exactly as before (no regression)", async () => {
    const { body, contentType } = buildMultipartBody("avatar.jpg", "image/jpeg", JPEG_BYTES);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/avatars/${tenantA.employee.id}`,
      headers: { authorization: `Bearer ${tenantA.empToken}`, "content-type": contentType },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
  });
});
