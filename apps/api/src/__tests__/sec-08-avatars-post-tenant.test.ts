/**
 * fix(sec-08): POST /api/v1/avatars/:employeeId only guarded the self-upload path
 * (`isSelf`) — an ADMIN/MANAGER of any tenant could upload an avatar onto a foreign
 * tenant's employee, since the `isManager` branch never compared tenantId. Fixed by
 * copying the tenant check already established on the sibling GET /:employeeId
 * (below in the same file) verbatim.
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

  it("tenantA ADMIN uploading an avatar onto tenantB's employee → 403, avatarPath untouched", async () => {
    const { body, contentType } = buildMultipartBody("avatar.jpg", "image/jpeg", JPEG_BYTES);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/avatars/${tenantB.employee.id}`,
      headers: { authorization: `Bearer ${tenantA.adminToken}`, "content-type": contentType },
      payload: body,
    });

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: "Keine Berechtigung" });

    const victimAfter = await app.prisma.employee.findUnique({
      where: { id: tenantB.employee.id },
    });
    expect(victimAfter?.avatarPath).toBeNull();
  });

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
