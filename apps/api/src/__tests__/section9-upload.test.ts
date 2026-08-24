/**
 * Phase 104-07: paper-AU upload/retrieval (D-26) + the Art. 17 DSGVO deletion extension
 * for the new storage location (Task 2).
 *
 * The file the AU document is stored at is an Art. 9 DSGVO health datum — every test here
 * either proves the allowlist/size/tenant/authz guards around it, or proves it is genuinely
 * erasable again.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
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

const PDF_BYTES = Buffer.from("%PDF-1.4\n%mock-au-document%%EOF");
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

describe("Section9 document upload/retrieval — Phase 104-07 Task 1", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let other: Awaited<ReturnType<typeof seedTestData>>;
  let managerToken: string;
  let employee2Token: string;
  let employee2Id: string;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "s9up");
    other = await seedTestData(app, "s9up2");

    // A MANAGER user in `data`'s tenant — seedTestData only provisions ADMIN + EMPLOYEE.
    const s = "s9up-mgr-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const managerUser = await app.prisma.user.create({
      data: {
        email: `mgr-${s}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "MANAGER",
        isActive: true,
      },
    });
    await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: managerUser.id,
        employeeNumber: `MGR-${s}`,
        firstName: "Manager",
        lastName: "Test",
        hireDate: new Date("2024-01-01"),
      },
    });
    const mgrLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: `mgr-${s}@test.de`, password: "test1234" },
    });
    managerToken = JSON.parse(mgrLogin.body).accessToken as string;

    // A second EMPLOYEE in `data`'s tenant — for the "not another employee's case" test.
    const e2 = "s9up-emp2-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const emp2User = await app.prisma.user.create({
      data: {
        email: `emp2-${e2}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const emp2 = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: emp2User.id,
        employeeNumber: `E2-${e2}`,
        firstName: "Zweiter",
        lastName: "Mitarbeiter",
        hireDate: new Date("2024-01-01"),
      },
    });
    employee2Id = emp2.id;
    const emp2Login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: `emp2-${e2}@test.de`, password: "test1234" },
    });
    employee2Token = JSON.parse(emp2Login.body).accessToken as string;

    // This suite creates 7 short vacation windows across makeCredit() calls without ever
    // confirming (which would credit the days back) — bump the entitlement so the default
    // 30-day budget cannot be exhausted mid-suite and start rejecting later tests' requests.
    await app.prisma.leaveEntitlement.updateMany({
      where: { employeeId: data.employee.id },
      data: { totalDays: 200 },
    });
  });

  afterAll(async () => {
    try {
      await app.prisma.section9Credit.deleteMany({ where: { employeeId: data.employee.id } });
      await cleanupTestData(app, data.tenant.id);
      await cleanupTestData(app, other.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  /** Creates one AU_PENDING Section9Credit for `data.employee` via the real approve flow. */
  async function makeCredit(vacStart: string, vacEnd: string, sickStart: string, sickEnd: string) {
    const vac = await app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: { type: "VACATION", startDate: vacStart, endDate: vacEnd },
    });
    expect(vac.statusCode).toBe(201);
    const vacId = JSON.parse(vac.body).id as string;
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/v1/leave/requests/${vacId}/review`,
          headers: { authorization: `Bearer ${data.adminToken}` },
          payload: { status: "APPROVED" },
        })
      ).statusCode,
    ).toBe(200);

    const sick = await app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: { type: "SICK", startDate: sickStart, endDate: sickEnd },
    });
    expect(sick.statusCode).toBe(201);
    const sickId = JSON.parse(sick.body).id as string;
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/v1/leave/requests/${sickId}/review`,
          headers: { authorization: `Bearer ${data.adminToken}` },
          payload: { status: "APPROVED" },
        })
      ).statusCode,
    ).toBe(200);

    const credit = await app.prisma.section9Credit.findFirst({
      where: { sickRequestId: sickId, vacationRequestId: vacId },
    });
    expect(credit).toBeTruthy();
    return credit!;
  }

  it("Test 1: a MANAGER uploads a small PDF — 200, documentPath set, bytes round-trip", async () => {
    const credit = await makeCredit("2027-01-04", "2027-01-08", "2027-01-05", "2027-01-06");
    const { body, contentType } = buildMultipartBody("au.pdf", "application/pdf", PDF_BYTES);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/section9-documents/${credit.id}`,
      headers: { authorization: `Bearer ${managerToken}`, "content-type": contentType },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    const json = JSON.parse(res.body) as { success: boolean; documentPath: string };
    expect(json.success).toBe(true);
    const expectedPath = `section9/${data.tenant.id}/${data.employee.id}/${credit.id}.pdf`;
    expect(json.documentPath).toBe(expectedPath);

    const updated = await app.prisma.section9Credit.findUnique({ where: { id: credit.id } });
    expect(updated?.documentPath).toBe(expectedPath);

    const stored = await app.storage.getBuffer(expectedPath);
    expect(Buffer.compare(stored, PDF_BYTES)).toBe(0);
  });

  it("Test 2: uploading text/html is rejected with 400 and nothing is stored", async () => {
    const credit = await makeCredit("2027-01-11", "2027-01-15", "2027-01-12", "2027-01-13");
    const { body, contentType } = buildMultipartBody(
      "evil.html",
      "text/html",
      Buffer.from("<script>alert(1)</script>"),
    );

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/section9-documents/${credit.id}`,
      headers: { authorization: `Bearer ${data.adminToken}`, "content-type": contentType },
      payload: body,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBeTruthy();

    const stillNull = await app.prisma.section9Credit.findUnique({ where: { id: credit.id } });
    expect(stillNull?.documentPath).toBeNull();
  });

  it("Test 3: a buffer larger than the AU cap (10 MB) is rejected with 400; nothing stored", async () => {
    const credit = await makeCredit("2027-01-18", "2027-01-22", "2027-01-19", "2027-01-20");
    const oversized = Buffer.alloc(11 * 1024 * 1024, 0x41);
    const { body, contentType } = buildMultipartBody("big.pdf", "application/pdf", oversized);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/section9-documents/${credit.id}`,
      headers: { authorization: `Bearer ${data.adminToken}`, "content-type": contentType },
      payload: body,
    });
    expect(res.statusCode).toBe(400);

    const stillNull = await app.prisma.section9Credit.findUnique({ where: { id: credit.id } });
    expect(stillNull?.documentPath).toBeNull();
  });

  it("Test 4: an EMPLOYEE may upload to their OWN case but not to another employee's", async () => {
    const credit = await makeCredit("2027-01-25", "2027-01-29", "2027-01-26", "2027-01-27");
    const { body, contentType } = buildMultipartBody("au.pdf", "application/pdf", PDF_BYTES);

    // Own case: allowed.
    const ownRes = await app.inject({
      method: "POST",
      url: `/api/v1/section9-documents/${credit.id}`,
      headers: { authorization: `Bearer ${data.empToken}`, "content-type": contentType },
      payload: body,
    });
    expect(ownRes.statusCode).toBe(200);

    // Another employee in the SAME tenant, different case: forbidden.
    const { body: body2, contentType: ct2 } = buildMultipartBody(
      "au.pdf",
      "application/pdf",
      PDF_BYTES,
    );
    const otherRes = await app.inject({
      method: "POST",
      url: `/api/v1/section9-documents/${credit.id}`,
      headers: { authorization: `Bearer ${employee2Token}`, "content-type": ct2 },
      payload: body2,
    });
    expect(otherRes.statusCode).toBe(403);
    void employee2Id; // referenced for readability; the token is what matters for the 403
  });

  it("Test 5: a user from another tenant gets 404 + CROSS_TENANT_ACCESS_DENIED audit, never 403", async () => {
    const credit = await makeCredit("2027-02-01", "2027-02-05", "2027-02-02", "2027-02-03");
    const { body, contentType } = buildMultipartBody("au.pdf", "application/pdf", PDF_BYTES);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/section9-documents/${credit.id}`,
      headers: { authorization: `Bearer ${other.adminToken}`, "content-type": contentType },
      payload: body,
    });
    expect(res.statusCode).toBe(404);

    const auditRow = await app.prisma.auditLog.findFirst({
      where: {
        action: "CROSS_TENANT_ACCESS_DENIED",
        entity: "Section9Credit",
        entityId: credit.id,
      },
      orderBy: { createdAt: "desc" },
    });
    expect(auditRow).toBeTruthy();
  });

  it("Test 6: GET requires auth, returns bytes+content-type for an in-tenant manager, 404 for another tenant", async () => {
    const credit = await makeCredit("2027-02-08", "2027-02-12", "2027-02-09", "2027-02-10");
    const { body, contentType } = buildMultipartBody("au.pdf", "application/pdf", PDF_BYTES);
    const upload = await app.inject({
      method: "POST",
      url: `/api/v1/section9-documents/${credit.id}`,
      headers: { authorization: `Bearer ${managerToken}`, "content-type": contentType },
      payload: body,
    });
    expect(upload.statusCode).toBe(200);

    // No auth at all.
    const noAuth = await app.inject({
      method: "GET",
      url: `/api/v1/section9-documents/${credit.id}`,
    });
    expect(noAuth.statusCode).toBe(401);

    // In-tenant manager: bytes back with the right content type.
    const getRes = await app.inject({
      method: "GET",
      url: `/api/v1/section9-documents/${credit.id}`,
      headers: { authorization: `Bearer ${managerToken}` },
    });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.headers["content-type"]).toBe("application/pdf");
    expect(getRes.headers["cache-control"]).toBe("private, no-store");
    expect(Buffer.compare(Buffer.from(getRes.rawPayload), PDF_BYTES)).toBe(0);

    // Another tenant: 404.
    const crossRes = await app.inject({
      method: "GET",
      url: `/api/v1/section9-documents/${credit.id}`,
      headers: { authorization: `Bearer ${other.adminToken}` },
    });
    expect(crossRes.statusCode).toBe(404);
  });

  it("Test 7: the avatar route still enforces its own 2 MB limit (per-call override did not leak globally)", async () => {
    const oversizedImage = Buffer.alloc(3 * 1024 * 1024, 0xff);
    const { body, contentType } = buildMultipartBody("avatar.jpg", "image/jpeg", oversizedImage);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/avatars/${data.employee.id}`,
      headers: { authorization: `Bearer ${data.empToken}`, "content-type": contentType },
      payload: body,
    });
    expect(res.statusCode).not.toBe(200);

    const employee = await app.prisma.employee.findUnique({ where: { id: data.employee.id } });
    expect(employee?.avatarPath).toBeNull();
  });

  it("Test 8: uploading twice replaces the object at the same documentPath (no orphan)", async () => {
    const credit = await makeCredit("2027-02-15", "2027-02-19", "2027-02-16", "2027-02-17");

    const first = buildMultipartBody("au.pdf", "application/pdf", PDF_BYTES);
    const firstRes = await app.inject({
      method: "POST",
      url: `/api/v1/section9-documents/${credit.id}`,
      headers: { authorization: `Bearer ${data.adminToken}`, "content-type": first.contentType },
      payload: first.body,
    });
    expect(firstRes.statusCode).toBe(200);
    const firstPath = JSON.parse(firstRes.body).documentPath as string;
    expect(firstPath.endsWith(".pdf")).toBe(true);

    const second = buildMultipartBody("au.jpg", "image/jpeg", JPEG_BYTES);
    const secondRes = await app.inject({
      method: "POST",
      url: `/api/v1/section9-documents/${credit.id}`,
      headers: { authorization: `Bearer ${data.adminToken}`, "content-type": second.contentType },
      payload: second.body,
    });
    expect(secondRes.statusCode).toBe(200);
    const secondPath = JSON.parse(secondRes.body).documentPath as string;
    expect(secondPath.endsWith(".jpg")).toBe(true);
    expect(secondPath).not.toBe(firstPath);

    // Exactly one documentPath value on the row — the field is a scalar, so this is
    // trivially true, but the real assertion is that the OLD object is gone (no orphan).
    const finalRow = await app.prisma.section9Credit.findUnique({ where: { id: credit.id } });
    expect(finalRow?.documentPath).toBe(secondPath);

    await expect(app.storage.getBuffer(firstPath)).rejects.toBeTruthy();
    const newBytes = await app.storage.getBuffer(secondPath);
    expect(Buffer.compare(newBytes, JPEG_BYTES)).toBe(0);
  });
});
