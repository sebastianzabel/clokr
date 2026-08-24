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
// A genuine, decodable 2x2 JPEG (not just magic bytes) — the § 9-document route never parses
// its input (Test 1 proves that with a fake-but-allowlisted PDF), but Test 6 below round-trips
// this same constant through the AVATAR route too, which DOES run it through sharp().
const JPEG_BYTES = Buffer.from(
  "/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgj/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABykX//Z",
  "base64",
);

/**
 * Creates one AU_PENDING Section9Credit via the real create + approve flow (shared between the
 * upload/retrieve describe block and the DSGVO deletion describe block below).
 */
async function createSection9Credit(
  app: FastifyInstance,
  empToken: string,
  adminToken: string,
  vacStart: string,
  vacEnd: string,
  sickStart: string,
  sickEnd: string,
) {
  const vac = await app.inject({
    method: "POST",
    url: "/api/v1/leave/requests",
    headers: { authorization: `Bearer ${empToken}` },
    payload: { type: "VACATION", startDate: vacStart, endDate: vacEnd },
  });
  expect(vac.statusCode).toBe(201);
  const vacId = JSON.parse(vac.body).id as string;
  expect(
    (
      await app.inject({
        method: "PATCH",
        url: `/api/v1/leave/requests/${vacId}/review`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { status: "APPROVED" },
      })
    ).statusCode,
  ).toBe(200);

  const sick = await app.inject({
    method: "POST",
    url: "/api/v1/leave/requests",
    headers: { authorization: `Bearer ${empToken}` },
    payload: { type: "SICK", startDate: sickStart, endDate: sickEnd },
  });
  expect(sick.statusCode).toBe(201);
  const sickId = JSON.parse(sick.body).id as string;
  expect(
    (
      await app.inject({
        method: "PATCH",
        url: `/api/v1/leave/requests/${sickId}/review`,
        headers: { authorization: `Bearer ${adminToken}` },
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
  function makeCredit(vacStart: string, vacEnd: string, sickStart: string, sickEnd: string) {
    return createSection9Credit(
      app,
      data.empToken,
      data.adminToken,
      vacStart,
      vacEnd,
      sickStart,
      sickEnd,
    );
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

describe("DSGVO Art. 17 deletion — Phase 104-07 Task 2", () => {
  let app: FastifyInstance;
  let d1: Awaited<ReturnType<typeof seedTestData>>;
  let d2: Awaited<ReturnType<typeof seedTestData>>;
  let d3: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    d1 = await seedTestData(app, "s9del1");
    d2 = await seedTestData(app, "s9del2");
    d3 = await seedTestData(app, "s9del3");
    for (const d of [d1, d2, d3]) {
      await app.prisma.leaveEntitlement.updateMany({
        where: { employeeId: d.employee.id },
        data: { totalDays: 200 },
      });
    }
  });

  afterAll(async () => {
    try {
      for (const d of [d1, d2, d3]) {
        await app.prisma.section9Credit.deleteMany({ where: { employeeId: d.employee.id } });
        await cleanupTestData(app, d.tenant.id);
      }
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("Test 1+2+3+4: documentPath and reason are erased, the object is gone, the row survives", async () => {
    const credit = await createSection9Credit(
      app,
      d1.empToken,
      d1.adminToken,
      "2028-03-06",
      "2028-03-10",
      "2028-03-07",
      "2028-03-08",
    );
    // A manager-typed free-text reason — the field D-17 requires and Art. 9 minimisation
    // requires erasing on deletion, same as documentPath.
    await app.prisma.section9Credit.update({
      where: { id: credit.id },
      data: { reason: "AU per Post nachgereicht" },
    });

    const { body, contentType } = buildMultipartBody("au.pdf", "application/pdf", PDF_BYTES);
    const uploadRes = await app.inject({
      method: "POST",
      url: `/api/v1/section9-documents/${credit.id}`,
      headers: { authorization: `Bearer ${d1.adminToken}`, "content-type": contentType },
      payload: body,
    });
    expect(uploadRes.statusCode).toBe(200);
    const path = JSON.parse(uploadRes.body).documentPath as string;

    const delRes = await app.inject({
      method: "DELETE",
      url: `/api/v1/employees/${d1.employee.id}`,
      headers: { authorization: `Bearer ${d1.adminToken}` },
    });
    expect(delRes.statusCode).toBe(204);

    // Test 3: the Section9Credit ROW survives (Restrict FKs + R7 retention) — only its
    // health-data pointer and free-text reason are erased.
    const row = await app.prisma.section9Credit.findUnique({ where: { id: credit.id } });
    expect(row).toBeTruthy();
    // Test 1
    expect(row?.documentPath).toBeNull();
    // Test 4
    expect(row?.reason).toBeNull();
    // Test 2: the MinIO object at the pre-anonymisation path no longer exists.
    await expect(app.storage.getBuffer(path)).rejects.toBeTruthy();
  });

  it("Test 5: a failing MinIO delete during anonymization is non-fatal", async () => {
    const credit = await createSection9Credit(
      app,
      d2.empToken,
      d2.adminToken,
      "2028-03-13",
      "2028-03-17",
      "2028-03-14",
      "2028-03-15",
    );
    const { body, contentType } = buildMultipartBody("au.pdf", "application/pdf", PDF_BYTES);
    const uploadRes = await app.inject({
      method: "POST",
      url: `/api/v1/section9-documents/${credit.id}`,
      headers: { authorization: `Bearer ${d2.adminToken}`, "content-type": contentType },
      payload: body,
    });
    expect(uploadRes.statusCode).toBe(200);

    const originalDelete = app.storage.delete;
    app.storage.delete = () => Promise.reject(new Error("simulated MinIO outage"));
    let delRes;
    try {
      delRes = await app.inject({
        method: "DELETE",
        url: `/api/v1/employees/${d2.employee.id}`,
        headers: { authorization: `Bearer ${d2.adminToken}` },
      });
    } finally {
      app.storage.delete = originalDelete;
    }
    // The legally-required Postgres anonymisation still commits and the endpoint still
    // returns success — parity with the existing avatar/absence handling.
    expect(delRes.statusCode).toBe(204);

    const row = await app.prisma.section9Credit.findUnique({ where: { id: credit.id } });
    expect(row?.documentPath).toBeNull();
  });

  it("Test 6: the existing avatar and Absence.documentPath deletions still work unchanged", async () => {
    const avatarBody = buildMultipartBody("avatar.jpg", "image/jpeg", JPEG_BYTES);
    const avatarRes = await app.inject({
      method: "POST",
      url: `/api/v1/avatars/${d3.employee.id}`,
      headers: { authorization: `Bearer ${d3.empToken}`, "content-type": avatarBody.contentType },
      payload: avatarBody.body,
    });
    expect(avatarRes.statusCode).toBe(200);
    const avatarPath = JSON.parse(avatarRes.body).avatarPath as string;

    // No upload ROUTE exists for Absence.documentPath (R8/D-03: confirmed dead code by
    // 104-01) — place a real object directly, mirroring what a legacy import would have
    // produced, so the deletion loop has a real MinIO object to erase.
    const absenceDocPath = `absences/${d3.tenant.id}/${d3.employee.id}/legacy-au.pdf`;
    await app.storage.upload(absenceDocPath, PDF_BYTES, "application/pdf");
    await app.prisma.absence.create({
      data: {
        employeeId: d3.employee.id,
        type: "SICK",
        startDate: new Date("2028-03-20"),
        endDate: new Date("2028-03-20"),
        days: 1,
        documentPath: absenceDocPath,
        createdBy: d3.adminUser.id,
      },
    });

    const delRes = await app.inject({
      method: "DELETE",
      url: `/api/v1/employees/${d3.employee.id}`,
      headers: { authorization: `Bearer ${d3.adminToken}` },
    });
    expect(delRes.statusCode).toBe(204);

    // Note: anonymizeEmployeeData does NOT null Employee.avatarPath in Postgres (pre-existing,
    // out of scope for this plan — see deferred-items.md). The MinIO OBJECT deletion is the
    // guarantee this test pins; it is unaffected by this plan's changes either way.
    await expect(app.storage.getBuffer(avatarPath)).rejects.toBeTruthy();

    const absence = await app.prisma.absence.findFirst({ where: { employeeId: d3.employee.id } });
    expect(absence?.documentPath).toBeNull();
    await expect(app.storage.getBuffer(absenceDocPath)).rejects.toBeTruthy();
  });
});
