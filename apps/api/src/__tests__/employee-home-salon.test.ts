/**
 * Phase 67b Plan 03 (issue #67) — the API's own employee lifecycle keeps the Stammsalon (HOME)
 * invariant: `POST /employees` resolves and creates the HOME row in the SAME transaction (D-22,
 * this file's first describe), `PATCH /employees/:id` fills the HOME gap when `hireDate` moves
 * earlier (D-07), the CSV import creates it or refuses up front (D-23), and the hard-delete
 * compliance path removes assignment rows before the employee (D-24, this file's last describe).
 *
 * `seedTestData()` creates ONE active default salon per tenant (Phase 67b Plan 03, D-24) — every
 * "N active salons" case below adjusts that starting point explicitly (adds a second active salon,
 * or deactivates the seeded default) rather than assuming a salon-less tenant.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, seedTestData, cleanupTestData } from "./setup";
import { DEFAULT_SALON_OPENING_HOURS } from "../contexts/platform/facade/salons";

function minimalEmployeeBody(overrides: Record<string, unknown> = {}) {
  const s = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  return {
    email: `home-salon-${s}@test.de`,
    firstName: "Home",
    lastName: "Salon",
    employeeNumber: `HS-${s}`,
    hireDate: "2026-03-01T23:30:00.000Z",
    // A direct password skips the invitation-mail path (SMTP not configured in tests) — this
    // file's assertions are about the Stammsalon row, not the invitation flow.
    password: "Test-hs-pw1234!",
    ...overrides,
  };
}

function postEmployee(app: FastifyInstance, token: string, body: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: "/api/v1/employees",
    headers: { authorization: `Bearer ${token}` },
    payload: body,
  });
}

async function makeActiveSalon(app: FastifyInstance, tenantId: string, name: string) {
  return app.prisma.salon.create({
    data: {
      tenantId,
      name,
      federalState: "NIEDERSACHSEN", // Phase 71b (issue #71): seedTestData's tenants are all NI
      openingHours: DEFAULT_SALON_OPENING_HOURS,
      isActive: true,
    },
  });
}

describe("POST /api/v1/employees — Stammsalon resolution (Phase 67b Plan 03, D-22)", () => {
  let app: FastifyInstance;
  let single: Awaited<ReturnType<typeof seedTestData>>;
  let multi: Awaited<ReturnType<typeof seedTestData>>;
  let multiSalonB: { id: string };
  let multiSalonInactive: { id: string };
  let zeroActive: Awaited<ReturnType<typeof seedTestData>>;
  let foreignTenant: Awaited<ReturnType<typeof seedTestData>>;

  const unknownSalonId = "00000000-0000-4000-8000-000000000501";

  beforeAll(async () => {
    app = await getTestApp();
    single = await seedTestData(app, "hs-single");
    multi = await seedTestData(app, "hs-multi");
    multiSalonB = await makeActiveSalon(app, multi.tenant.id, "Salon B");
    multiSalonInactive = await app.prisma.salon.create({
      data: {
        tenantId: multi.tenant.id,
        name: "Inaktiver Salon",
        federalState: "NIEDERSACHSEN",
        openingHours: DEFAULT_SALON_OPENING_HOURS,
        isActive: false,
        deactivatedAt: new Date(),
      },
    });
    zeroActive = await seedTestData(app, "hs-zero");
    await app.prisma.salon.update({
      where: { id: zeroActive.salonId },
      data: { isActive: false, deactivatedAt: new Date() },
    });
    foreignTenant = await seedTestData(app, "hs-foreign");
  });

  afterAll(async () => {
    for (const t of [single, multi, zeroActive, foreignTenant]) {
      try {
        await cleanupTestData(app, t.tenant.id);
      } catch (err) {
        console.error("Test cleanup failed:", err);
      }
    }
  });

  it("one active salon, homeSalonId omitted: 201, exactly one HOME row to that salon from the tenant-local hire day, CREATE audited", async () => {
    const res = await postEmployee(app, single.adminToken, minimalEmployeeBody());
    expect(res.statusCode, res.body.slice(0, 400)).toBe(201);
    const emp = JSON.parse(res.body);

    const rows = await app.prisma.employeeSalonAssignment.findMany({
      where: { employeeId: emp.id },
    });
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.kind).toBe("HOME");
    expect(row.salonId).toBe(single.salonId);
    // 2026-03-01T23:30:00.000Z is 2026-03-02 00:30 in Europe/Berlin (CET, UTC+1 in March before
    // DST) — the tenant-local day, not the UTC day.
    expect(row.validFrom.toISOString().slice(0, 10)).toBe("2026-03-02");
    expect(row.validUntil).toBeNull();
    expect(row.weekdays).toEqual([]);

    const audit = await app.prisma.auditLog.findFirst({
      where: { entity: "EmployeeSalonAssignment", action: "CREATE", entityId: row.id },
    });
    expect(audit).not.toBeNull();
    expect((audit?.newValue as { salonId?: string } | null)?.salonId).toBe(single.salonId);
  });

  it("one active salon, explicit homeSalonId: null: 201 (frontends send explicit null, never omit the key)", async () => {
    const res = await postEmployee(
      app,
      single.adminToken,
      minimalEmployeeBody({ homeSalonId: null }),
    );
    expect(res.statusCode, res.body.slice(0, 400)).toBe(201);
    const emp = JSON.parse(res.body);
    const rows = await app.prisma.employeeSalonAssignment.findMany({
      where: { employeeId: emp.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].salonId).toBe(single.salonId);
  });

  it("two active salons, homeSalonId omitted: 400 'Bei mehreren aktiven Salons...'; no User or Employee written", async () => {
    const body = minimalEmployeeBody();
    const usersBefore = await app.prisma.user.count({ where: { email: body.email as string } });
    const employeesBefore = await app.prisma.employee.count({
      where: { employeeNumber: body.employeeNumber as string },
    });
    expect(usersBefore).toBe(0);
    expect(employeesBefore).toBe(0);

    const res = await postEmployee(app, multi.adminToken, body);
    expect(res.statusCode, res.body.slice(0, 400)).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: "Bei mehreren aktiven Salons ist die Angabe des Stammsalons erforderlich.",
    });

    const usersAfter = await app.prisma.user.count({ where: { email: body.email as string } });
    const employeesAfter = await app.prisma.employee.count({
      where: { employeeNumber: body.employeeNumber as string },
    });
    expect(usersAfter).toBe(0);
    expect(employeesAfter).toBe(0);
  });

  it("two active salons, homeSalonId = the second: 201, HOME row to the second salon", async () => {
    const res = await postEmployee(
      app,
      multi.adminToken,
      minimalEmployeeBody({ homeSalonId: multiSalonB.id }),
    );
    expect(res.statusCode, res.body.slice(0, 400)).toBe(201);
    const emp = JSON.parse(res.body);
    const rows = await app.prisma.employeeSalonAssignment.findMany({
      where: { employeeId: emp.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].salonId).toBe(multiSalonB.id);
  });

  it("homeSalonId of an inactive salon: 400 'Einem deaktivierten Salon...'", async () => {
    const res = await postEmployee(
      app,
      multi.adminToken,
      minimalEmployeeBody({ homeSalonId: multiSalonInactive.id }),
    );
    expect(res.statusCode, res.body.slice(0, 400)).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: "Einem deaktivierten Salon kann keine neue Zuordnung zugewiesen werden.",
    });
  });

  it("zero active salons (default salon deactivated), homeSalonId omitted: 400 'Der Mandant hat keinen aktiven Salon.'", async () => {
    const res = await postEmployee(app, zeroActive.adminToken, minimalEmployeeBody());
    expect(res.statusCode, res.body.slice(0, 400)).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "Der Mandant hat keinen aktiven Salon." });
  });

  it("homeSalonId of a foreign tenant's real salon and a nonexistent uuid: byte-identical 400s; CROSS_TENANT_ACCESS_DENIED only for the foreign one", async () => {
    const foreignRes = await postEmployee(
      app,
      single.adminToken,
      minimalEmployeeBody({ homeSalonId: foreignTenant.salonId }),
    );
    const unknownRes = await postEmployee(
      app,
      single.adminToken,
      minimalEmployeeBody({ homeSalonId: unknownSalonId }),
    );
    expect(foreignRes.statusCode).toBe(400);
    expect(unknownRes.statusCode).toBe(400);
    expect(foreignRes.body).toBe(unknownRes.body);
    expect(JSON.parse(foreignRes.body)).toEqual({ error: "Salon nicht gefunden" });

    const foreignAudit = await app.prisma.auditLog.findFirst({
      where: {
        entity: "Salon",
        action: "CROSS_TENANT_ACCESS_DENIED",
        entityId: foreignTenant.salonId,
      },
    });
    expect(foreignAudit).not.toBeNull();
    const unknownAudit = await app.prisma.auditLog.findFirst({
      where: { entity: "Salon", action: "CROSS_TENANT_ACCESS_DENIED", entityId: unknownSalonId },
    });
    expect(unknownAudit).toBeNull();
  });
});

describe("PATCH /api/v1/employees/:id — Stammsalon-Lücke bei früherem Eintrittsdatum (Phase 67b Plan 03, D-07)", () => {
  let app: FastifyInstance;
  let tenant: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    tenant = await seedTestData(app, "hs-d07");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenant.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
  });

  async function createBareEmployee(prefix: string, hireDate: string) {
    const s = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const user = await app.prisma.user.create({
      data: {
        email: `${prefix}-${s}@test.de`,
        passwordHash: "x",
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    return app.prisma.employee.create({
      data: {
        tenantId: tenant.tenant.id,
        userId: user.id,
        employeeNumber: `${prefix.toUpperCase()}-${s}`,
        firstName: prefix,
        lastName: "Test",
        hireDate: new Date(hireDate),
      },
    });
  }

  async function createEmployeeWithHome(prefix: string, hireDate: string, salonId: string) {
    const emp = await createBareEmployee(prefix, hireDate);
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: tenant.tenant.id,
        employeeId: emp.id,
        salonId,
        kind: "HOME",
        validFrom: new Date(hireDate),
        validUntil: null,
        weekdays: [],
      },
    });
    return emp;
  }

  function patchEmployee(token: string, id: string, body: Record<string, unknown>) {
    return app.inject({
      method: "PATCH",
      url: `/api/v1/employees/${id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });
  }

  /** Same in-memory tiling definition as `salon-assignments.test.ts`'s own proof, restated here
   * rather than imported from production internals — every calendar day in [fromDay, toDay] has
   * EXACTLY one effective HOME row. */
  async function assertGaplessHomeTiling(employeeId: string, fromDay: string, toDay: string) {
    const rows = await app.prisma.employeeSalonAssignment.findMany({
      where: { employeeId, kind: "HOME" },
    });
    const from = new Date(`${fromDay}T00:00:00Z`).getTime();
    const to = new Date(`${toDay}T00:00:00Z`).getTime();
    let iterated = 0;
    for (let t = from; t <= to; t += 86400000) {
      const count = rows.filter(
        (row) =>
          row.validFrom.getTime() <= t &&
          (row.validUntil === null || row.validUntil.getTime() >= t),
      ).length;
      expect(
        count,
        `day ${new Date(t).toISOString().slice(0, 10)} has ${count} effective HOME row(s)`,
      ).toBe(1);
      iterated += 1;
    }
    return iterated;
  }

  it("hireDate moved earlier fills the gap with the earliest HOME row's own salon, audited CREATE with trigger HIRE_DATE_CHANGED; every day is tiled", async () => {
    const emp = await createEmployeeWithHome("d07a", "2024-01-01", tenant.salonId);

    const res = await patchEmployee(tenant.adminToken, emp.id, {
      hireDate: "2023-10-01T00:00:00.000Z",
    });
    expect(res.statusCode, res.body.slice(0, 400)).toBe(200);

    const rows = await app.prisma.employeeSalonAssignment.findMany({
      where: { employeeId: emp.id, kind: "HOME" },
      orderBy: { validFrom: "asc" },
    });
    expect(rows).toHaveLength(2);
    const [gapRow, original] = rows;
    expect(gapRow.salonId).toBe(tenant.salonId);
    expect(gapRow.validFrom.toISOString().slice(0, 10)).toBe("2023-10-01");
    expect(gapRow.validUntil?.toISOString().slice(0, 10)).toBe("2023-12-31");
    expect(original.validFrom.toISOString().slice(0, 10)).toBe("2024-01-01");
    expect(original.validUntil).toBeNull();

    const audit = await app.prisma.auditLog.findFirst({
      where: { entity: "EmployeeSalonAssignment", action: "CREATE", entityId: gapRow.id },
    });
    expect(audit).not.toBeNull();
    expect((audit?.newValue as { trigger?: string } | null)?.trigger).toBe("HIRE_DATE_CHANGED");

    const iterated = await assertGaplessHomeTiling(emp.id, "2023-10-01", "2026-12-31");
    expect(iterated).toBeGreaterThan(0);
  });

  it("review IN-05: an ADMIN-scope API key moves hireDate earlier — 200; the Employee UPDATE audit is written inside the same transaction as the gap-fill, without userId and naming the key", async () => {
    const keyRes = await app.inject({
      method: "POST",
      url: "/api/v1/api-keys",
      headers: { authorization: `Bearer ${tenant.adminToken}` },
      payload: { name: "IN-05 admin key", scopes: ["admin"] },
    });
    expect(keyRes.statusCode, keyRes.body.slice(0, 400)).toBe(200);
    const key = JSON.parse(keyRes.body) as { id: string; rawKey: string };

    const emp = await createEmployeeWithHome("in05", "2024-01-01", tenant.salonId);
    const res = await patchEmployee(key.rawKey, emp.id, { hireDate: "2023-10-01T00:00:00.000Z" });
    expect(res.statusCode, res.body.slice(0, 400)).toBe(200);

    const gapRows = await app.prisma.employeeSalonAssignment.findMany({
      where: { employeeId: emp.id, kind: "HOME", validFrom: new Date("2023-10-01") },
    });
    expect(gapRows).toHaveLength(1);

    const updateAudits = await app.prisma.auditLog.findMany({
      where: { entity: "Employee", action: "UPDATE", entityId: emp.id },
    });
    expect(updateAudits).toHaveLength(1);
    expect(updateAudits[0].userId).toBeNull();
    const newValue = updateAudits[0].newValue as { actor?: unknown; hireDate?: string } | null;
    expect(newValue?.actor).toEqual({ type: "API_KEY", apiKeyId: key.id });
    expect(newValue?.hireDate).toBe("2023-10-01T00:00:00.000Z");

    const gapAudits = await app.prisma.auditLog.findMany({
      where: { entity: "EmployeeSalonAssignment", action: "CREATE", entityId: gapRows[0].id },
    });
    expect(gapAudits).toHaveLength(1);
  });

  it("hireDate moved LATER than the earliest HOME row: no new assignment row", async () => {
    const emp = await createEmployeeWithHome("d07b", "2024-01-01", tenant.salonId);
    const res = await patchEmployee(tenant.adminToken, emp.id, {
      hireDate: "2024-03-01T00:00:00.000Z",
    });
    expect(res.statusCode, res.body.slice(0, 400)).toBe(200);
    const count = await app.prisma.employeeSalonAssignment.count({
      where: { employeeId: emp.id, kind: "HOME" },
    });
    expect(count).toBe(1);
  });

  it("PATCH without hireDate: no assignment change", async () => {
    const emp = await createEmployeeWithHome("d07c", "2024-01-01", tenant.salonId);
    const res = await patchEmployee(tenant.adminToken, emp.id, { firstName: "Renamed" });
    expect(res.statusCode, res.body.slice(0, 400)).toBe(200);
    const count = await app.prisma.employeeSalonAssignment.count({
      where: { employeeId: emp.id, kind: "HOME" },
    });
    expect(count).toBe(1);
  });

  it("employee without any HOME row + earlier hireDate: 200, no assignment row created (legacy fixture)", async () => {
    const emp = await createBareEmployee("d07d", "2024-01-01");
    const res = await patchEmployee(tenant.adminToken, emp.id, {
      hireDate: "2023-06-01T00:00:00.000Z",
    });
    expect(res.statusCode, res.body.slice(0, 400)).toBe(200);
    const count = await app.prisma.employeeSalonAssignment.count({ where: { employeeId: emp.id } });
    expect(count).toBe(0);
  });

  it("D-13 exemption: the earliest HOME row's salon is inactive — the gap row is still created with that (inactive) salon", async () => {
    const inactiveSalon = await makeActiveSalon(app, tenant.tenant.id, "Bald inaktiv (D07)");
    await app.prisma.salon.update({
      where: { id: inactiveSalon.id },
      data: { isActive: false, deactivatedAt: new Date() },
    });
    const emp = await createEmployeeWithHome("d07e", "2024-01-01", inactiveSalon.id);

    const res = await patchEmployee(tenant.adminToken, emp.id, {
      hireDate: "2023-10-01T00:00:00.000Z",
    });
    expect(res.statusCode, res.body.slice(0, 400)).toBe(200);

    const rows = await app.prisma.employeeSalonAssignment.findMany({
      where: { employeeId: emp.id, kind: "HOME" },
      orderBy: { validFrom: "asc" },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].salonId).toBe(inactiveSalon.id);
  });
});

describe("DELETE /:id/hard-delete removes salon assignment rows first (Phase 67b Plan 03, D-24)", () => {
  let app: FastifyInstance;
  let tenant: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    tenant = await seedTestData(app, "hs-harddelete");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenant.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
  });

  it("hard-delete of an anonymized, retention-expired employee with a HOME and a DEPLOYMENT row succeeds; 0 assignment rows remain", async () => {
    const uid = `hs-hd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const user = await app.prisma.user.create({
      data: {
        email: `deleted-${uid}@anonymized.local`,
        passwordHash: "ANONYMIZED",
        role: "EMPLOYEE",
        isActive: false,
      },
    });
    const exitDate = new Date();
    exitDate.setFullYear(exitDate.getFullYear() - 11); // past the default 10y retention + 2y floor
    const emp = await app.prisma.employee.create({
      data: {
        tenantId: tenant.tenant.id,
        userId: user.id,
        firstName: "Gelöscht",
        lastName: `GELÖSCHT-${uid}`,
        employeeNumber: `GELÖSCHT-${uid}`,
        hireDate: exitDate,
        exitDate,
      },
    });
    await app.prisma.overtimeAccount.create({ data: { employeeId: emp.id, balanceHours: 0 } });

    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: tenant.tenant.id,
        employeeId: emp.id,
        salonId: tenant.salonId,
        kind: "HOME",
        validFrom: exitDate,
        validUntil: null,
        weekdays: [],
      },
    });
    const deploymentSalon = await makeActiveSalon(app, tenant.tenant.id, "Einsatzsalon HD");
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: tenant.tenant.id,
        employeeId: emp.id,
        salonId: deploymentSalon.id,
        kind: "DEPLOYMENT",
        validFrom: exitDate,
        validUntil: null,
        weekdays: [0, 1, 2, 3, 4],
      },
    });

    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/employees/${emp.id}/hard-delete`,
      headers: { authorization: `Bearer ${tenant.adminToken}` },
    });
    expect(res.statusCode, res.body.slice(0, 400)).toBe(204);

    const remaining = await app.prisma.employeeSalonAssignment.count({
      where: { employeeId: emp.id },
    });
    expect(remaining).toBe(0);
    const empRow = await app.prisma.employee.findUnique({ where: { id: emp.id } });
    expect(empRow).toBeNull();
  });
});
