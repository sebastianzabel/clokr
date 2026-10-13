/**
 * Issue #547 (Phase 85b Plan 01, D-01/D-02) — `GET /api/v1/employees` for SCOPED readers.
 *
 * Before this plan the list answered every employee of the tenant, including the stored overtime
 * balance, to any caller holding `employee:read:ZUGEWIESEN` — also a Salonmanager whose reach is
 * one salon. Now:
 *  - D-01: the list holds exactly the persons of the single view's master-data rule
 *    (`resolvePersonScopedEmployeeIds`: Stammsalon today OR an active DEPLOYMENT today in the
 *    reach, OR the reach's person ids) plus the caller's own row. A Springer homed in B whose only
 *    link to salon A is time entries recorded there (the AC-4 probe of issue #85) is NOT a person
 *    of salon A's manager; an active deployment in A makes them one.
 *  - D-02 (owner decision 2026-08-27, total saldo only for Inhaber, Personalabteilung and the
 *    employee): `overtimeAccount.balanceHours` is the stored value only when the caller holds
 *    `overtime:read` with a reach covering the person; otherwise it is `null` — never 0. A person
 *    without an account keeps `overtimeAccount: null`.
 *  - A whole-tenant caller receives the byte-identical list (`whole-tenant-frozen-85.test.ts`).
 *
 * Mutation proofs (run during execution, restored with cp, never committed):
 *  - M1: skipping the id narrowing in the handler turned the narrowing cases red
 *    (D-01 Salonmanager list, Springer, PERSONS and empty-reach cases).
 *  - M2: returning the stored balance unconditionally turned the null-balance cases red
 *    (Salonmanager, overtime:read over salon A, overtime:read EIGENE).
 *
 * Phase 85b Plan 15 (gap closure): the same mask is pinned on `GET /employees/:id` and the PATCH
 * responses (`overtimeAccount` is decided by one helper). Mutation proof M1: returning the raw
 * account on the single view turns the 85b-15 cases red.
 *
 * No person names in fixtures (labels such as "el85").
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";
import { normalizeRolePermissions, roleNameKey, SYSTEM_ROLE_IDS } from "../contexts/platform";

const PASSWORD = "test1234";

/** Tenant-local (Europe/Berlin) calendar day, shifted by `offsetDays`, as YYYY-MM-DD. */
function berlinDay(offsetDays = 0): string {
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

interface ListRow {
  id: string;
  overtimeAccount: { balanceHours: unknown } | null;
  [key: string]: unknown;
}

describe("Issue #547 (Phase 85b Plan 01) — employee list scope and balance masking", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: { id: string };
  let salonB: { id: string };
  // Deactivated salon: a SALONS assignment on it passes the permission gate but resolves to an
  // empty live reach.
  let salonDead: { id: string };

  const emp: Record<string, { id: string; userId: string; email: string }> = {};

  function uniqueSuffix(label: string): string {
    return `${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }

  async function createPerson(
    label: string,
    opts: { balance?: string | null; anonymized?: boolean } = {},
  ) {
    const s = uniqueSuffix(label);
    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const email = `${s}@test.de`;
    const user = await app.prisma.user.create({
      data: { email, passwordHash, role: "EMPLOYEE", isActive: !opts.anonymized },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: s.toUpperCase().slice(0, 20),
        firstName: opts.anonymized ? "Gelöscht" : label,
        lastName: opts.anonymized ? `GELÖSCHT-${label.toUpperCase()}` : "ListScope85",
        hireDate: new Date("2020-01-01"),
      },
    });
    if (opts.balance !== null && opts.balance !== undefined) {
      await app.prisma.overtimeAccount.create({
        data: { employeeId: employee.id, balanceHours: opts.balance },
      });
    }
    emp[label] = { id: employee.id, userId: user.id, email };
    return emp[label];
  }

  function assign(
    employeeId: string,
    salonId: string,
    kind: "HOME" | "DEPLOYMENT",
    validFrom: string,
    validUntil: string | null = null,
  ) {
    return app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: data.tenant.id,
        employeeId,
        salonId,
        kind,
        validFrom: new Date(validFrom),
        validUntil: validUntil ? new Date(validUntil) : null,
        weekdays: [],
      },
    });
  }

  async function customManager(
    label: string,
    permissions: string[],
    scope: { scopeType: "SALONS" | "PERSONS"; salonIds?: string[]; employeeIds?: string[] },
  ) {
    const person = await createPerson(label, { balance: "9" });
    await assign(person.id, salonB.id, "HOME", "2020-01-01");
    const name = `El85 ${crypto.randomBytes(3).toString("hex")}`;
    const role = await app.prisma.accessRole.create({
      data: {
        tenantId: data.tenant.id,
        name,
        nameKey: roleNameKey(name),
        permissions: normalizeRolePermissions(permissions),
      },
    });
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: data.tenant.id,
        userId: person.userId,
        accessRoleId: role.id,
        scopeType: scope.scopeType,
        salonIds: scope.salonIds ?? [],
        employeeIds: scope.employeeIds ?? [],
      },
    });
    return person;
  }

  async function login(email: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    return (JSON.parse(res.body) as { accessToken: string }).accessToken;
  }

  async function list(token: string, query = ""): Promise<ListRow[]> {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/employees${query}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body) as ListRow[];
  }

  const idsOf = (rows: ListRow[]) => rows.map((r) => r.id).sort((a, b) => a.localeCompare(b));
  const sorted = (ids: string[]) => [...ids].sort((a, b) => a.localeCompare(b));
  const balanceOf = (rows: ListRow[], id: string) => {
    const row = rows.find((r) => r.id === id);
    expect(row, `row ${id} present`).toBeDefined();
    return row!.overtimeAccount === null ? "NO_ACCOUNT" : row!.overtimeAccount.balanceHours;
  };

  let salonManagerToken = "";
  let adminToken = "";

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "el85");
    adminToken = data.adminToken;
    salonA = await createTestSalon(app.prisma, data.tenant.id, { name: "EL85 Salon A" });
    salonB = await createTestSalon(app.prisma, data.tenant.id, { name: "EL85 Salon B" });
    salonDead = await createTestSalon(app.prisma, data.tenant.id, {
      name: "EL85 Salon Dead",
      isActive: false,
    });

    // Persons of salon A today: pA1, pA2 (no account), pDepl (homed in B, deployment in A today).
    await createPerson("el85-pa1", { balance: "5" });
    await assign(emp["el85-pa1"].id, salonA.id, "HOME", "2020-01-01");
    await createPerson("el85-pa2", { balance: null });
    await assign(emp["el85-pa2"].id, salonA.id, "HOME", "2020-01-01");
    await createPerson("el85-depl", { balance: "8" });
    await assign(emp["el85-depl"].id, salonB.id, "HOME", "2020-01-01");
    await assign(emp["el85-depl"].id, salonA.id, "DEPLOYMENT", berlinDay(-10));

    // Not persons of salon A today.
    await createPerson("el85-pb", { balance: "6" });
    await assign(emp["el85-pb"].id, salonB.id, "HOME", "2020-01-01");
    //   Springer: homed in B, worked in A (entry recorded there), no deployment.
    await createPerson("el85-springer", { balance: "7" });
    await assign(emp["el85-springer"].id, salonB.id, "HOME", "2020-01-01");
    await app.prisma.timeEntry.create({
      data: {
        employeeId: emp["el85-springer"].id,
        salonId: salonA.id,
        date: new Date(berlinDay(-3)),
        startTime: new Date(`${berlinDay(-3)}T08:00:00Z`),
        endTime: new Date(`${berlinDay(-3)}T16:00:00Z`),
        type: "WORK",
        source: "MANUAL",
      },
    });
    //   Deployment in A that ended yesterday.
    await createPerson("el85-ended", { balance: "4" });
    await assign(emp["el85-ended"].id, salonB.id, "HOME", "2020-01-01");
    await assign(emp["el85-ended"].id, salonA.id, "DEPLOYMENT", berlinDay(-30), berlinDay(-1));
    //   Homed in A until yesterday, in B from today.
    await createPerson("el85-moved", { balance: "3" });
    await assign(emp["el85-moved"].id, salonA.id, "HOME", "2020-01-01", berlinDay(-1));
    await assign(emp["el85-moved"].id, salonB.id, "HOME", berlinDay(0));
    //   Anonymized person homed in A.
    await createPerson("el85-anon", { balance: "1", anonymized: true });
    await assign(emp["el85-anon"].id, salonA.id, "HOME", "2020-01-01");

    // The Salonmanager of A (system template: employee:read, no overtime:read at all). Their own
    // employee row is homed in B on purpose: the own row must appear although B is out of reach.
    await createPerson("el85-sm", { balance: "2" });
    await assign(emp["el85-sm"].id, salonB.id, "HOME", "2020-01-01");
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: data.tenant.id,
        userId: emp["el85-sm"].userId,
        accessRoleId: SYSTEM_ROLE_IDS.SALON_MANAGER,
        scopeType: "SALONS",
        salonIds: [salonA.id],
        employeeIds: [],
      },
    });
    salonManagerToken = await login(emp["el85-sm"].email);
  });

  afterAll(async () => {
    try {
      // RoleAssignment/AccessRole -> Tenant are onDelete: Restrict and cleanupTestData does not
      // know them.
      await app.prisma.roleAssignment.deleteMany({ where: { tenantId: data.tenant.id } });
      await app.prisma.accessRole.deleteMany({ where: { tenantId: data.tenant.id } });
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("employees-list-scope-85 cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("D-01: the Salonmanager of A lists exactly the persons of A (Stammsalon or active deployment today) plus their own row", async () => {
    const rows = await list(salonManagerToken);
    expect(idsOf(rows)).toEqual(
      sorted([
        emp["el85-pa1"].id,
        emp["el85-pa2"].id,
        emp["el85-depl"].id,
        emp["el85-sm"].id, // own row, homed in B
      ]),
    );
  });

  it("D-01 (AC-4 probe): a Springer homed in B with entries in A is absent without a deployment in A, present with one", async () => {
    const before = await list(salonManagerToken);
    expect(idsOf(before)).not.toContain(emp["el85-springer"].id);
    // The Springer's entry in A exists (precondition of the probe).
    const entries = await app.prisma.timeEntry.count({
      where: { employeeId: emp["el85-springer"].id, salonId: salonA.id },
    });
    expect(entries).toBe(1);

    await assign(emp["el85-springer"].id, salonA.id, "DEPLOYMENT", berlinDay(-1));
    const after = await list(salonManagerToken);
    expect(idsOf(after)).toContain(emp["el85-springer"].id);
    // Still no overtime:read -> no balance for the newly visible person.
    expect(balanceOf(after, emp["el85-springer"].id)).toBeNull();
  });

  it("D-01: persons whose A deployment ended yesterday, or who moved from A to B today, are absent", async () => {
    const rows = await list(salonManagerToken);
    expect(idsOf(rows)).not.toContain(emp["el85-ended"].id);
    expect(idsOf(rows)).not.toContain(emp["el85-moved"].id);
    expect(idsOf(rows)).not.toContain(emp["el85-pb"].id);
  });

  it("D-01: a PERSONS-scoped reader gets exactly the listed person and their own row", async () => {
    const reader = await customManager("el85-persons", ["employee:read:ZUGEWIESEN"], {
      scopeType: "PERSONS",
      employeeIds: [emp["el85-pb"].id],
    });
    const rows = await list(await login(reader.email));
    expect(idsOf(rows)).toEqual(sorted([emp["el85-pb"].id, reader.id]));
  });

  it("D-01: a scoped reader with an empty reach gets only their own row", async () => {
    const reader = await customManager("el85-empty", ["employee:read:ZUGEWIESEN"], {
      scopeType: "SALONS",
      salonIds: [salonDead.id],
    });
    const rows = await list(await login(reader.email));
    expect(idsOf(rows)).toEqual([reader.id]);
  });

  it("D-02: the Salonmanager (no overtime:read) gets balanceHours null on every row, rows without an account keep overtimeAccount null", async () => {
    const rows = await list(salonManagerToken);
    for (const row of rows) {
      if (row.id === emp["el85-pa2"].id) {
        expect(row.overtimeAccount).toBeNull();
      } else {
        expect(row.overtimeAccount).not.toBeNull();
        expect(row.overtimeAccount!.balanceHours).toBeNull();
      }
    }
    // The stored balances are non-zero, so a masked 0 would be a fabricated number.
    const stored = await app.prisma.overtimeAccount.findUniqueOrThrow({
      where: { employeeId: emp["el85-pa1"].id },
    });
    expect(Number(stored.balanceHours)).toBe(5);
  });

  it("D-02: overtime:read over salon A reveals the balance of persons homed in A, not of the deployment-only person", async () => {
    const reader = await customManager(
      "el85-ot-a",
      ["employee:read:ZUGEWIESEN", "overtime:read:ZUGEWIESEN"],
      { scopeType: "SALONS", salonIds: [salonA.id] },
    );
    const rows = await list(await login(reader.email));
    expect(idsOf(rows)).toContain(emp["el85-pa1"].id);
    expect(idsOf(rows)).toContain(emp["el85-depl"].id);
    expect(Number(balanceOf(rows, emp["el85-pa1"].id))).toBe(5);
    expect(balanceOf(rows, emp["el85-pa2"].id)).toBe("NO_ACCOUNT");
    // Deployment-only: Stammsalon B is outside the overtime reach.
    expect(balanceOf(rows, emp["el85-depl"].id)).toBeNull();
    // Own row (homed in B): always covered.
    expect(Number(balanceOf(rows, reader.id))).toBe(9);
  });

  it("D-02: overtime:read EIGENE reveals only the caller's own balance", async () => {
    const reader = await customManager(
      "el85-ot-own",
      ["employee:read:ZUGEWIESEN", "overtime:read:EIGENE"],
      { scopeType: "SALONS", salonIds: [salonA.id] },
    );
    const rows = await list(await login(reader.email));
    expect(Number(balanceOf(rows, reader.id))).toBe(9);
    expect(balanceOf(rows, emp["el85-pa1"].id)).toBeNull();
    expect(balanceOf(rows, emp["el85-depl"].id)).toBeNull();
  });

  it("547-AC3: the tenant admin sees every person and every balance", async () => {
    const rows = await list(adminToken);
    expect(idsOf(rows)).toEqual(
      expect.arrayContaining([
        emp["el85-pa1"].id,
        emp["el85-pb"].id,
        emp["el85-springer"].id,
        emp["el85-ended"].id,
        emp["el85-moved"].id,
      ]),
    );
    expect(Number(balanceOf(rows, emp["el85-pa1"].id))).toBe(5);
    expect(Number(balanceOf(rows, emp["el85-pb"].id))).toBe(6);
    expect(Number(balanceOf(rows, emp["el85-springer"].id))).toBe(7);
    expect(balanceOf(rows, emp["el85-pa2"].id)).toBe("NO_ACCOUNT");
  });

  it("data minimisation: for an in-reach person the Salonmanager's row has exactly the admin's key set", async () => {
    const adminRow = (await list(adminToken)).find((r) => r.id === emp["el85-pa1"].id);
    const smRow = (await list(salonManagerToken)).find((r) => r.id === emp["el85-pa1"].id);
    expect(adminRow).toBeDefined();
    expect(smRow).toBeDefined();
    expect(Object.keys(smRow!).sort((a, b) => a.localeCompare(b))).toEqual(
      Object.keys(adminRow!).sort((a, b) => a.localeCompare(b)),
    );
  });

  it("?includeAnonymized=true from a caller without employee:anonymize still yields no anonymized row", async () => {
    const rows = await list(salonManagerToken, "?includeAnonymized=true");
    expect(idsOf(rows)).not.toContain(emp["el85-anon"].id);
    const adminRows = await list(adminToken, "?includeAnonymized=true");
    expect(idsOf(adminRows)).toContain(emp["el85-anon"].id);
  });

  // ── Phase 85b Plan 15 (gap closure of 85b-VERIFICATION): the single view and the PATCH
  // responses carry the same saldo mask as the list — one helper decides.

  async function getOne(token: string, id: string) {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/employees/${id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    return { status: res.statusCode, body: JSON.parse(res.body) as ListRow };
  }

  it("85b-15: GET /employees/:id masks the saldo for the Salonmanager (in-reach person and deployment-only person), keeps null for a person without an account", async () => {
    const inReach = await getOne(salonManagerToken, emp["el85-pa1"].id);
    expect(inReach.status).toBe(200);
    expect(inReach.body.overtimeAccount).not.toBeNull();
    expect(inReach.body.overtimeAccount!.balanceHours).toBeNull();

    // Homed in B, deployed in A today: master data is visible, the saldo (which would include
    // salon-B time) must not be.
    const deployed = await getOne(salonManagerToken, emp["el85-depl"].id);
    expect(deployed.status).toBe(200);
    expect(deployed.body.overtimeAccount).not.toBeNull();
    expect(deployed.body.overtimeAccount!.balanceHours).toBeNull();
    // The stored value is non-zero, so a null is a mask and not an empty account.
    const stored = await app.prisma.overtimeAccount.findUniqueOrThrow({
      where: { employeeId: emp["el85-depl"].id },
    });
    expect(Number(stored.balanceHours)).toBe(8);

    const noAccount = await getOne(salonManagerToken, emp["el85-pa2"].id);
    expect(noAccount.status).toBe(200);
    expect(noAccount.body.overtimeAccount).toBeNull();
  });

  it("85b-15: GET /employees/:id shows the stored saldo to the admin and to the person themself", async () => {
    const asAdmin = await getOne(adminToken, emp["el85-depl"].id);
    expect(asAdmin.status).toBe(200);
    expect(Number(asAdmin.body.overtimeAccount!.balanceHours)).toBe(8);

    const asSelf = await getOne(await login(emp["el85-pa1"].email), emp["el85-pa1"].id);
    expect(asSelf.status).toBe(200);
    expect(Number(asSelf.body.overtimeAccount!.balanceHours)).toBe(5);
  });

  it("85b-15: GET /employees/:id follows overtime:read coverage (salon A reveals a person homed in A, not the deployment-only person)", async () => {
    const reader = await customManager(
      "el85-ot-one",
      ["employee:read:ZUGEWIESEN", "overtime:read:ZUGEWIESEN"],
      { scopeType: "SALONS", salonIds: [salonA.id] },
    );
    const token = await login(reader.email);
    expect(
      Number((await getOne(token, emp["el85-pa1"].id)).body.overtimeAccount!.balanceHours),
    ).toBe(5);
    expect(
      (await getOne(token, emp["el85-depl"].id)).body.overtimeAccount!.balanceHours,
    ).toBeNull();
  });

  it("85b-15: the list and the single view agree on the balance of every listed person", async () => {
    const rows = await list(salonManagerToken);
    for (const row of rows) {
      const one = await getOne(salonManagerToken, row.id);
      expect(one.status).toBe(200);
      expect(
        one.body.overtimeAccount === null ? "NO_ACCOUNT" : one.body.overtimeAccount.balanceHours,
      ).toBe(row.overtimeAccount === null ? "NO_ACCOUNT" : row.overtimeAccount.balanceHours);
    }
  });

  it("85b-15: PATCH /employees/:id/reactivate answers balanceHours null to a caller without overtime:read coverage, the stored value to the admin", async () => {
    const reader = await customManager(
      "el85-react",
      ["employee:read:ZUGEWIESEN", "employee:manage-access:ZUGEWIESEN"],
      { scopeType: "SALONS", salonIds: [salonA.id] },
    );
    const token = await login(reader.email);
    const target = await createPerson("el85-react-target", { balance: "4" });
    await assign(target.id, salonA.id, "HOME", "2020-01-01");
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/employees/${target.id}/reactivate`,
      headers: { authorization: `Bearer ${token}` },
    });
    // The fixture user is active already (409) -> deactivate first so the reactivate path runs.
    expect(res.statusCode).toBe(409);
    await app.prisma.user.update({ where: { id: target.userId }, data: { isActive: false } });
    const ok = await app.inject({
      method: "PATCH",
      url: `/api/v1/employees/${target.id}/reactivate`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(ok.statusCode).toBe(200);
    const body = JSON.parse(ok.body) as ListRow;
    expect(body.overtimeAccount).not.toBeNull();
    expect(body.overtimeAccount!.balanceHours).toBeNull();

    await app.prisma.user.update({ where: { id: target.userId }, data: { isActive: false } });
    const asAdmin = await app.inject({
      method: "PATCH",
      url: `/api/v1/employees/${target.id}/reactivate`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(asAdmin.statusCode).toBe(200);
    expect(Number((JSON.parse(asAdmin.body) as ListRow).overtimeAccount!.balanceHours)).toBe(4);
  });

  it("85b-15: PATCH /employees/:id by a scoped caller returns no non-null balanceHours", async () => {
    const reader = await customManager(
      "el85-patch",
      ["employee:read:ZUGEWIESEN", "employee:update:ZUGEWIESEN"],
      { scopeType: "SALONS", salonIds: [salonA.id] },
    );
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/employees/${emp["el85-pa1"].id}`,
      headers: { authorization: `Bearer ${await login(reader.email)}` },
      payload: { coverageWeight: 1 },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as ListRow;
    // Either no account key at all or a masked one — never the stored 5.
    expect(body.overtimeAccount?.balanceHours ?? null).toBeNull();
    expect(res.body).not.toMatch(/"balanceHours":"?5/);
  });
});
