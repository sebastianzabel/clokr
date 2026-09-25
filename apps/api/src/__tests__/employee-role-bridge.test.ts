/**
 * Phase 75b Plan 11 (Issue #75) — the role bridge: every path that sets a legacy role writes a
 * system-role assignment, every assignment change rewrites `User.role` to the derived value with
 * an audit trace, and a user who still relies on the fallback has it stored first.
 *
 * AC-75-16: a role change in the employee form takes effect on the target's very next request —
 * the permission resolver reads the stored assignments per request, not the JWT claim — and the
 * next refresh carries the new compat role. D-15 (the bridge, role-assignment:manage), D-26
 * (materialize the fallback), D-29 (compatRole on the triggering audit row), D-31 (one transaction
 * with the lockout guard).
 *
 * Fixture: the checked-in legacy-role migration is executed after seeding, so the seed admin holds
 * a STORED Admin assignment — the anchor that keeps the lockout guard from firing where a test
 * does not intend it. A "migrated" person is created before a migration run, a "fallback" person
 * after the last one (no stored assignment, D-08). No person names (CLAUDE.md PII rule).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import crypto, { createHash, randomBytes } from "crypto";
import type { FastifyInstance } from "fastify";
import type { Role } from "@clokr/db";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import { executeLegacyRoleMigration } from "./legacy-role-migration-sql";
import { SYSTEM_ROLE_IDS, normalizeRolePermissions, roleNameKey } from "../contexts/platform";
import { ROLE_LOCKOUT_MESSAGE } from "../contexts/platform/role-assignment";

const PASSWORD = "test1234";
// POST /employees validates the tenant password policy; the fixture users bypass it.
const POLICY_PASSWORD = "Test@1234567!";
const MATERIALIZATION_REASON = "Übernahme der Alt-Rolle (#75)";

type AuditRow = {
  id: string;
  userId: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  oldValue: Record<string, unknown> | null;
  newValue: Record<string, unknown> | null;
};

describe("Role bridge: employee form, compat column and fallback materialization (75b-11)", () => {
  let app: FastifyInstance;
  let tenant: Awaited<ReturnType<typeof seedTestData>>;
  let lockTenant: Awaited<ReturnType<typeof seedTestData>>;
  let remoteCounter = 0;

  function nextRemoteAddress(): string {
    const n = remoteCounter++;
    return `10.211.${Math.floor(n / 250) % 250}.${(n % 250) + 1}`;
  }

  async function createPerson(tenantId: string, label: string, role: Role) {
    const s = `${Date.now().toString(36)}${crypto.randomBytes(4).toString("hex")}`;
    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const user = await app.prisma.user.create({
      data: { email: `bridge-${s}@test.de`, passwordHash, role, isActive: true },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId,
        userId: user.id,
        employeeNumber: `BR-${s}`.slice(0, 20),
        firstName: label,
        lastName: "Test",
        hireDate: new Date("2024-01-01"),
      },
    });
    return { user, employee, email: user.email };
  }

  async function login(email: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password: PASSWORD },
      remoteAddress: nextRemoteAddress(),
    });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body) as { accessToken: string; refreshToken: string };
  }

  function claimsOf(token: string): { role: string } {
    return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
  }

  function patchEmployee(token: string, employeeId: string, payload: object) {
    return app.inject({
      method: "PATCH",
      url: `/api/v1/employees/${employeeId}`,
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
  }

  function listEmployees(token: string) {
    return app.inject({
      method: "GET",
      url: "/api/v1/employees",
      headers: { authorization: `Bearer ${token}` },
    });
  }

  /** Every RoleAssignment audit row that names `userId` in its old or new value. */
  async function roleAssignmentAudits(userId: string): Promise<AuditRow[]> {
    const rows = await app.prisma.auditLog.findMany({
      where: {
        entity: "RoleAssignment",
        OR: [
          { newValue: { path: ["userId"], equals: userId } },
          { oldValue: { path: ["userId"], equals: userId } },
        ],
      },
      orderBy: { createdAt: "asc" },
    });
    return rows as unknown as AuditRow[];
  }

  async function newAuditsSince(userId: string, before: AuditRow[]): Promise<AuditRow[]> {
    const seen = new Set(before.map((row) => row.id));
    return (await roleAssignmentAudits(userId)).filter((row) => !seen.has(row.id));
  }

  function storedAssignments(tenantId: string, userId: string) {
    return app.prisma.roleAssignment.findMany({
      where: { tenantId, userId },
      orderBy: { createdAt: "asc" },
    });
  }

  async function columnRole(userId: string): Promise<Role> {
    const user = await app.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return user.role;
  }

  beforeAll(async () => {
    app = await getTestApp();
    tenant = await seedTestData(app, "75b-bridge");
    lockTenant = await seedTestData(app, "75b-bridge-lock");
    // Anchor: the seed admins become STORED Admin holders.
    await executeLegacyRoleMigration(app.prisma);
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenant.tenant.id);
      await cleanupTestData(app, lockTenant.tenant.id);
    } finally {
      await closeTestApp();
    }
  });

  it("MANAGER → EMPLOYEE on a migrated manager: replaced, audited, column rewritten, effective on the next request", async () => {
    const target = await createPerson(tenant.tenant.id, "Wechsel Manager", "MANAGER");
    await executeLegacyRoleMigration(app.prisma);
    const [managerRow] = await storedAssignments(tenant.tenant.id, target.user.id);
    expect(managerRow.accessRoleId).toBe(SYSTEM_ROLE_IDS.MANAGER);

    const tokens = await login(target.email);
    expect((await listEmployees(tokens.accessToken)).statusCode).toBe(200);
    const before = await roleAssignmentAudits(target.user.id);

    const res = await patchEmployee(tenant.adminToken, target.employee.id, { role: "EMPLOYEE" });
    expect(res.statusCode).toBe(200);

    const audits = await newAuditsSince(target.user.id, before);
    expect(audits.map((row) => row.action).sort()).toEqual(["CREATE", "DELETE"]);
    const deleted = audits.find((row) => row.action === "DELETE")!;
    const created = audits.find((row) => row.action === "CREATE")!;
    expect(deleted.entityId).toBe(managerRow.id);
    expect(deleted.oldValue).toMatchObject({
      userId: target.user.id,
      accessRoleId: SYSTEM_ROLE_IDS.MANAGER,
      roleName: "Manager",
      scopeType: "TENANT",
    });
    // D-29: the compat change sits on the LAST row of the change only.
    expect(deleted.newValue).toBeNull();
    expect(created.newValue).toEqual({
      userId: target.user.id,
      accessRoleId: SYSTEM_ROLE_IDS.EMPLOYEE,
      roleName: "Mitarbeiter",
      scopeType: "TENANT",
      salonIds: [],
      employeeIds: [],
      compatRole: { from: "MANAGER", to: "EMPLOYEE" },
    });
    for (const row of audits) expect(row.userId).toBe(tenant.adminUser.id);

    const rows = await storedAssignments(tenant.tenant.id, target.user.id);
    expect(rows.map((row) => [row.accessRoleId, row.scopeType])).toEqual([
      [SYSTEM_ROLE_IDS.EMPLOYEE, "TENANT"],
    ]);
    expect(rows[0].id).toBe(created.entityId);
    expect(await columnRole(target.user.id)).toBe("EMPLOYEE");

    // AC-75-16: the OLD access token loses the right on its very next request.
    const after = await listEmployees(tokens.accessToken);
    expect(after.statusCode).toBe(403);
    expect(JSON.parse(after.body)).toEqual({ error: "Forbidden" });

    const refresh = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken: tokens.refreshToken },
      remoteAddress: nextRemoteAddress(),
    });
    expect(refresh.statusCode).toBe(200);
    expect(claimsOf(JSON.parse(refresh.body).accessToken).role).toBe("EMPLOYEE");
  });

  it("EMPLOYEE → MANAGER on a migrated employee: the old token gains the right on the next request", async () => {
    const target = await createPerson(tenant.tenant.id, "Wechsel Mitarbeiter", "EMPLOYEE");
    await executeLegacyRoleMigration(app.prisma);
    const tokens = await login(target.email);
    expect((await listEmployees(tokens.accessToken)).statusCode).toBe(403);

    const res = await patchEmployee(tenant.adminToken, target.employee.id, { role: "MANAGER" });
    expect(res.statusCode).toBe(200);

    expect((await listEmployees(tokens.accessToken)).statusCode).toBe(200);
    expect(await columnRole(target.user.id)).toBe("MANAGER");
    const rows = await storedAssignments(tenant.tenant.id, target.user.id);
    expect(rows.map((row) => row.accessRoleId)).toEqual([SYSTEM_ROLE_IDS.MANAGER]);
  });

  it("a fallback user is materialized first (D-26): CREATE (origin SYSTEM), DELETE, CREATE", async () => {
    const target = await createPerson(tenant.tenant.id, "Rueckfall Mitarbeiter", "EMPLOYEE");
    expect(await storedAssignments(tenant.tenant.id, target.user.id)).toEqual([]);

    const res = await patchEmployee(tenant.adminToken, target.employee.id, { role: "MANAGER" });
    expect(res.statusCode).toBe(200);

    const audits = await roleAssignmentAudits(target.user.id);
    expect(audits).toHaveLength(3);
    const materialized = audits.find(
      (row) => row.action === "CREATE" && row.newValue?.origin === "SYSTEM",
    )!;
    expect(materialized.newValue).toEqual({
      userId: target.user.id,
      accessRoleId: SYSTEM_ROLE_IDS.EMPLOYEE,
      roleName: "Mitarbeiter",
      scopeType: "TENANT",
      salonIds: [],
      employeeIds: [],
      origin: "SYSTEM",
      reason: MATERIALIZATION_REASON,
      legacyRole: "EMPLOYEE",
    });
    // The materialized row is the one the replacement removes — CREATE before DELETE of one id.
    const deleted = audits.find((row) => row.action === "DELETE")!;
    expect(deleted.entityId).toBe(materialized.entityId);
    expect(deleted.oldValue).toMatchObject({ accessRoleId: SYSTEM_ROLE_IDS.EMPLOYEE });
    expect(deleted.newValue).toBeNull();
    const granted = audits.find(
      (row) => row.action === "CREATE" && row.entityId !== materialized.entityId,
    )!;
    expect(granted.newValue).toMatchObject({
      accessRoleId: SYSTEM_ROLE_IDS.MANAGER,
      roleName: "Manager",
      compatRole: { from: "EMPLOYEE", to: "MANAGER" },
    });

    const rows = await storedAssignments(tenant.tenant.id, target.user.id);
    expect(rows.map((row) => row.id)).toEqual([granted.entityId]);
    expect(await columnRole(target.user.id)).toBe("MANAGER");
  });

  it("an unchanged role writes nothing — neither for a migrated nor for a fallback user", async () => {
    const migrated = await createPerson(tenant.tenant.id, "Gleich Manager", "MANAGER");
    await executeLegacyRoleMigration(app.prisma);
    const fallback = await createPerson(tenant.tenant.id, "Gleich Rueckfall", "MANAGER");
    const migratedRowsBefore = await storedAssignments(tenant.tenant.id, migrated.user.id);
    const migratedAuditsBefore = await roleAssignmentAudits(migrated.user.id);

    for (const person of [migrated, fallback]) {
      const res = await patchEmployee(tenant.adminToken, person.employee.id, {
        role: "MANAGER",
        firstName: "Gleich Geaendert",
      });
      expect(res.statusCode).toBe(200);
      expect(await columnRole(person.user.id)).toBe("MANAGER");
    }

    expect(await storedAssignments(tenant.tenant.id, migrated.user.id)).toEqual(migratedRowsBefore);
    expect(await newAuditsSince(migrated.user.id, migratedAuditsBefore)).toEqual([]);
    expect(await storedAssignments(tenant.tenant.id, fallback.user.id)).toEqual([]);
    expect(await roleAssignmentAudits(fallback.user.id)).toEqual([]);
  });

  it("a customer-role assignment survives a role change untouched", async () => {
    const target = await createPerson(tenant.tenant.id, "Kunde Manager", "MANAGER");
    await executeLegacyRoleMigration(app.prisma);
    const name = `Bruecke Kundenrolle ${crypto.randomBytes(3).toString("hex")}`;
    const customerRole = await app.prisma.accessRole.create({
      data: {
        tenantId: tenant.tenant.id,
        name,
        nameKey: roleNameKey(name),
        permissions: normalizeRolePermissions(["role:read:ZUGEWIESEN"]),
      },
    });
    const customerRow = await app.prisma.roleAssignment.create({
      data: {
        tenantId: tenant.tenant.id,
        userId: target.user.id,
        accessRoleId: customerRole.id,
        scopeType: "TENANT",
        salonIds: [],
        employeeIds: [],
      },
    });
    const before = await roleAssignmentAudits(target.user.id);

    const res = await patchEmployee(tenant.adminToken, target.employee.id, { role: "EMPLOYEE" });
    expect(res.statusCode).toBe(200);

    const rows = await storedAssignments(tenant.tenant.id, target.user.id);
    expect(rows.find((row) => row.id === customerRow.id)).toEqual(customerRow);
    expect(rows.map((row) => row.accessRoleId).sort()).toEqual(
      [customerRole.id, SYSTEM_ROLE_IDS.EMPLOYEE].sort(),
    );
    // The customer role grants a ZUGEWIESEN permission, so the derived compat role stays MANAGER
    // (D-14) — no column change, no compatRole on any row.
    expect(await columnRole(target.user.id)).toBe("MANAGER");
    const audits = await newAuditsSince(target.user.id, before);
    expect(audits.map((row) => row.action).sort()).toEqual(["CREATE", "DELETE"]);
    for (const row of audits) expect(row.newValue?.compatRole).toBeUndefined();
  });

  it("demoting the last stored Admin holder answers 409 and commits nothing — not the field update either (D-31)", async () => {
    const target = await createPerson(lockTenant.tenant.id, "Letzter Admin", "ADMIN");
    await executeLegacyRoleMigration(app.prisma);
    // The seed admin keeps acting through the fallback, so the target is the ONLY stored holder.
    await app.prisma.roleAssignment.deleteMany({
      where: { tenantId: lockTenant.tenant.id, userId: lockTenant.adminUser.id },
    });
    const rowsBefore = await storedAssignments(lockTenant.tenant.id, target.user.id);
    const auditsBefore = await roleAssignmentAudits(target.user.id);
    const employeeBefore = await app.prisma.employee.findUniqueOrThrow({
      where: { id: target.employee.id },
    });
    const employeeAuditsBefore = await app.prisma.auditLog.count({
      where: { entity: "Employee", entityId: target.employee.id },
    });

    const res = await patchEmployee(lockTenant.adminToken, target.employee.id, {
      firstName: "Nicht Gespeichert",
      role: "EMPLOYEE",
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: ROLE_LOCKOUT_MESSAGE });

    expect(
      await app.prisma.employee.findUniqueOrThrow({ where: { id: target.employee.id } }),
    ).toEqual(employeeBefore);
    expect(await storedAssignments(lockTenant.tenant.id, target.user.id)).toEqual(rowsBefore);
    expect(await columnRole(target.user.id)).toBe("ADMIN");
    expect(await newAuditsSince(target.user.id, auditsBefore)).toEqual([]);
    expect(
      await app.prisma.auditLog.count({
        where: { entity: "Employee", entityId: target.employee.id },
      }),
    ).toBe(employeeAuditsBefore);
  });

  it("a caller with employee:update but without role-assignment:manage may not set the role (D-15)", async () => {
    const caller = await createPerson(tenant.tenant.id, "Stammdaten Pflege", "EMPLOYEE");
    const target = await createPerson(tenant.tenant.id, "Stammdaten Ziel", "EMPLOYEE");
    const name = `Bruecke Stammdaten ${crypto.randomBytes(3).toString("hex")}`;
    const updateOnly = await app.prisma.accessRole.create({
      data: {
        tenantId: tenant.tenant.id,
        name,
        nameKey: roleNameKey(name),
        permissions: normalizeRolePermissions(["employee:update:ZUGEWIESEN"]),
      },
    });
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: tenant.tenant.id,
        userId: caller.user.id,
        accessRoleId: updateOnly.id,
        scopeType: "TENANT",
        salonIds: [],
        employeeIds: [],
      },
    });
    const { accessToken } = await login(caller.email);

    const withoutRole = await patchEmployee(accessToken, target.employee.id, {
      firstName: "Stammdaten Neu",
    });
    expect(withoutRole.statusCode).toBe(200);

    const withRole = await patchEmployee(accessToken, target.employee.id, {
      firstName: "Stammdaten Verboten",
      role: "MANAGER",
    });
    expect(withRole.statusCode).toBe(403);
    expect(JSON.parse(withRole.body)).toEqual({ error: "Forbidden" });
    expect(
      (await app.prisma.employee.findUniqueOrThrow({ where: { id: target.employee.id } }))
        .firstName,
    ).toBe("Stammdaten Neu");
    expect(await columnRole(target.user.id)).toBe("EMPLOYEE");
    expect(await storedAssignments(tenant.tenant.id, target.user.id)).toEqual([]);
  });

  it("an admin-scope API key as actor: audit rows carry no userId and name the key (#333 not widened)", async () => {
    const target = await createPerson(tenant.tenant.id, "Schluessel Manager", "MANAGER");
    await executeLegacyRoleMigration(app.prisma);
    const raw = `clk_${randomBytes(24).toString("hex")}`;
    const apiKey = await app.prisma.apiKey.create({
      data: {
        tenantId: tenant.tenant.id,
        name: "Bruecke Admin-Schluessel",
        keyHash: createHash("sha256").update(raw).digest("hex"),
        keyPrefix: raw.slice(0, 8),
        scopes: ["admin"],
        createdBy: tenant.adminUser.id,
      },
    });
    const before = await roleAssignmentAudits(target.user.id);

    const res = await patchEmployee(raw, target.employee.id, { role: "EMPLOYEE" });
    expect(res.statusCode).toBe(200);

    const audits = await newAuditsSince(target.user.id, before);
    expect(audits).toHaveLength(2);
    for (const row of audits) {
      expect(row.userId).toBeNull();
      expect(row.newValue?.actor).toEqual({ type: "API_KEY", apiKeyId: apiKey.id });
    }
    expect(await columnRole(target.user.id)).toBe("EMPLOYEE");
  });

  describe("creation paths and the anonymization (D-15, D-14/D-29)", () => {
    it("POST /employees creates the system-role assignment with one CREATE audit in the user's transaction", async () => {
      const uid = crypto.randomBytes(4).toString("hex");
      const email = `bridge-post-${uid}@test.de`;
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/employees",
        headers: { authorization: `Bearer ${tenant.adminToken}` },
        payload: {
          email,
          firstName: "Anlage",
          lastName: "Manager",
          employeeNumber: `BP-${uid}`,
          hireDate: "2026-01-01T00:00:00.000Z",
          role: "MANAGER",
          password: POLICY_PASSWORD,
        },
      });
      expect(res.statusCode).toBe(201);
      const user = await app.prisma.user.findUniqueOrThrow({ where: { email } });

      const rows = await storedAssignments(tenant.tenant.id, user.id);
      expect(rows.map((row) => [row.accessRoleId, row.scopeType])).toEqual([
        [SYSTEM_ROLE_IDS.MANAGER, "TENANT"],
      ]);
      const audits = await roleAssignmentAudits(user.id);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        action: "CREATE",
        entityId: rows[0].id,
        userId: tenant.adminUser.id,
        newValue: {
          userId: user.id,
          accessRoleId: SYSTEM_ROLE_IDS.MANAGER,
          roleName: "Manager",
          scopeType: "TENANT",
          salonIds: [],
          employeeIds: [],
        },
      });
      // The column already holds the created role — no compat change to record.
      expect(audits[0].newValue?.compatRole).toBeUndefined();
      expect(user.role).toBe("MANAGER");

      const loginRes = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email, password: POLICY_PASSWORD },
        remoteAddress: nextRemoteAddress(),
      });
      expect(loginRes.statusCode).toBe(200);
      const loginBody = JSON.parse(loginRes.body);
      expect(loginBody.user.role).toBe("MANAGER");
      expect(claimsOf(loginBody.accessToken).role).toBe("MANAGER");
    });

    it("the CSV import gives every new user its system-role assignment; a failing row leaves none", async () => {
      const uid = crypto.randomBytes(4).toString("hex");
      const csv = [
        // "Rolle" (capitalised): the importer reads `role` or `Rolle` as the role column.
        "email;vorname;nachname;nr;eintrittsdatum;Rolle;wochenstunden;passwort",
        `bridge-imp1-${uid}@test.de;Import;Eins;BI1-${uid};01.01.2026;EMPLOYEE;40;${PASSWORD}`,
        `bridge-imp2-${uid}@test.de;Import;Zwei;BI2-${uid};01.01.2026;MANAGER;40;${PASSWORD}`,
        // Same employee number as row 1: user.create succeeds, employee.create fails, the row's
        // transaction rolls back — including anything written for its user.
        `bridge-imp3-${uid}@test.de;Import;Drei;BI1-${uid};01.01.2026;ADMIN;40;${PASSWORD}`,
      ].join("\n");
      const adminRoleAssignmentAuditCount = () =>
        app.prisma.auditLog.count({
          where: { entity: "RoleAssignment", userId: tenant.adminUser.id },
        });
      const auditsBefore = await adminRoleAssignmentAuditCount();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/imports/employees",
        headers: { authorization: `Bearer ${tenant.adminToken}` },
        payload: { csv },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({ total: 3, imported: 2, errors: 1 });

      for (const [n, role, roleId, roleName] of [
        [1, "EMPLOYEE", SYSTEM_ROLE_IDS.EMPLOYEE, "Mitarbeiter"],
        [2, "MANAGER", SYSTEM_ROLE_IDS.MANAGER, "Manager"],
      ] as const) {
        const user = await app.prisma.user.findUniqueOrThrow({
          where: { email: `bridge-imp${n}-${uid}@test.de` },
        });
        expect(user.role).toBe(role);
        const rows = await storedAssignments(tenant.tenant.id, user.id);
        expect(rows.map((row) => [row.accessRoleId, row.scopeType])).toEqual([[roleId, "TENANT"]]);
        const audits = await roleAssignmentAudits(user.id);
        expect(audits).toHaveLength(1);
        expect(audits[0]).toMatchObject({
          action: "CREATE",
          entityId: rows[0].id,
          userId: tenant.adminUser.id,
          newValue: { userId: user.id, accessRoleId: roleId, roleName, scopeType: "TENANT" },
        });
      }
      expect(
        await app.prisma.user.findUnique({ where: { email: `bridge-imp3-${uid}@test.de` } }),
      ).toBeNull();
      // Exactly the two successful rows' CREATE audits — the failed row's rolled back with it.
      expect(await adminRoleAssignmentAuditCount()).toBe(auditsBefore + 2);
    });

    it("the anonymization keeps 74b's behaviour and deliberately leaves the column (neutrality, AC-75-11)", async () => {
      // The anonymization removes every stored assignment (74b D-22) but does NOT rewrite
      // `User.role` (D-14 write-back withheld): with no stored row left the column is the fallback
      // a still-valid access token resolves through, and the neutrality recording's cells
      // "ADMIN | DELETE /api/v1/employees/:id | foreign" and the same for FALLBACK_ADMIN require a
      // self-anonymizing admin's live token to keep its rights, as it did before #75.
      const migrated = await createPerson(tenant.tenant.id, "Anonym Manager", "MANAGER");
      await executeLegacyRoleMigration(app.prisma);
      const fallback = await createPerson(tenant.tenant.id, "Anonym Rueckfall", "ADMIN");
      const [managerRow] = await storedAssignments(tenant.tenant.id, migrated.user.id);
      const before = await roleAssignmentAudits(migrated.user.id);

      for (const person of [migrated, fallback]) {
        const res = await app.inject({
          method: "DELETE",
          url: `/api/v1/employees/${person.employee.id}`,
          headers: { authorization: `Bearer ${tenant.adminToken}` },
        });
        expect(res.statusCode).toBe(204);
        expect(await storedAssignments(tenant.tenant.id, person.user.id)).toEqual([]);
      }

      expect(await columnRole(migrated.user.id)).toBe("MANAGER");
      expect(await columnRole(fallback.user.id)).toBe("ADMIN");
      const audits = await newAuditsSince(migrated.user.id, before);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        action: "DELETE",
        entityId: managerRow.id,
        oldValue: { accessRoleId: SYSTEM_ROLE_IDS.MANAGER, roleName: "Manager" },
      });
      expect(audits[0].newValue).toEqual({ reason: "Anonymisierung" });
      expect(await roleAssignmentAudits(fallback.user.id)).toEqual([]);
      expect(
        await app.prisma.auditLog.count({
          where: { entity: "User", entityId: { in: [migrated.user.id, fallback.user.id] } },
        }),
      ).toBe(0);
    });
  });

  describe("the role-assignment API materializes and writes the column back (D-26, D-14/D-29)", () => {
    function assignmentRequest(
      method: "POST" | "PATCH" | "DELETE",
      path: string,
      payload?: object,
    ) {
      return app.inject({
        method,
        url: `/api/v1/role-assignments${path}`,
        headers: { authorization: `Bearer ${tenant.adminToken}` },
        ...(payload !== undefined ? { payload } : {}),
      });
    }

    async function customerRoleWith(permissions: string[]) {
      const name = `Bruecke Zuweisung ${crypto.randomBytes(3).toString("hex")}`;
      return app.prisma.accessRole.create({
        data: {
          tenantId: tenant.tenant.id,
          name,
          nameKey: roleNameKey(name),
          permissions: normalizeRolePermissions(permissions),
        },
      });
    }

    it("a first customer role for a fallback EMPLOYEE keeps the legacy role: materialized row + grant, column MANAGER", async () => {
      const target = await createPerson(tenant.tenant.id, "Erste Kundenrolle", "EMPLOYEE");
      const customerRole = await customerRoleWith(["time-entry:read:ZUGEWIESEN"]);

      const res = await assignmentRequest("POST", "", {
        userId: target.user.id,
        accessRoleId: customerRole.id,
        scope: { type: "TENANT" },
      });
      expect(res.statusCode).toBe(201);
      const grantId = JSON.parse(res.body).id as string;

      const rows = await storedAssignments(tenant.tenant.id, target.user.id);
      expect(rows.map((row) => row.accessRoleId).sort()).toEqual(
        [SYSTEM_ROLE_IDS.EMPLOYEE, customerRole.id].sort(),
      );
      expect(await columnRole(target.user.id)).toBe("MANAGER");

      const audits = await roleAssignmentAudits(target.user.id);
      expect(audits).toHaveLength(2);
      const materialized = audits.find((row) => row.entityId !== grantId)!;
      expect(materialized.newValue).toMatchObject({
        accessRoleId: SYSTEM_ROLE_IDS.EMPLOYEE,
        origin: "SYSTEM",
        reason: MATERIALIZATION_REASON,
        legacyRole: "EMPLOYEE",
      });
      expect(materialized.newValue?.compatRole).toBeUndefined();
      const grant = audits.find((row) => row.entityId === grantId)!;
      expect(grant.newValue).toMatchObject({
        accessRoleId: customerRole.id,
        compatRole: { from: "EMPLOYEE", to: "MANAGER" },
      });
    });

    it("a grant equal to the materialized fallback answers 409 and rolls the materialization back", async () => {
      const target = await createPerson(tenant.tenant.id, "Doppelte Zuweisung", "EMPLOYEE");

      const res = await assignmentRequest("POST", "", {
        userId: target.user.id,
        accessRoleId: SYSTEM_ROLE_IDS.EMPLOYEE,
        scope: { type: "TENANT" },
      });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body)).toEqual({
        error: "Diese Rolle ist dem Nutzer mit diesem Scope-Typ bereits zugewiesen.",
      });
      expect(await storedAssignments(tenant.tenant.id, target.user.id)).toEqual([]);
      expect(await roleAssignmentAudits(target.user.id)).toEqual([]);
      expect(await columnRole(target.user.id)).toBe("EMPLOYEE");
    });

    it("PATCH switching a stored row's role rewrites the column, recorded on the UPDATE row", async () => {
      const target = await createPerson(tenant.tenant.id, "Zuweisung Wechsel", "EMPLOYEE");
      await executeLegacyRoleMigration(app.prisma);
      const [employeeRow] = await storedAssignments(tenant.tenant.id, target.user.id);
      const before = await roleAssignmentAudits(target.user.id);

      const res = await assignmentRequest("PATCH", `/${employeeRow.id}`, {
        accessRoleId: SYSTEM_ROLE_IDS.MANAGER,
      });
      expect(res.statusCode).toBe(200);

      expect(await columnRole(target.user.id)).toBe("MANAGER");
      const audits = await newAuditsSince(target.user.id, before);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        action: "UPDATE",
        entityId: employeeRow.id,
        oldValue: { accessRoleId: SYSTEM_ROLE_IDS.EMPLOYEE },
        newValue: {
          accessRoleId: SYSTEM_ROLE_IDS.MANAGER,
          compatRole: { from: "EMPLOYEE", to: "MANAGER" },
        },
      });
    });

    it("revoking the last assignment writes EMPLOYEE (D-08): the fallback never keeps the old right", async () => {
      const target = await createPerson(tenant.tenant.id, "Letzte Zuweisung", "MANAGER");
      await executeLegacyRoleMigration(app.prisma);
      const [managerRow] = await storedAssignments(tenant.tenant.id, target.user.id);
      const tokens = await login(target.email);
      expect((await listEmployees(tokens.accessToken)).statusCode).toBe(200);
      const before = await roleAssignmentAudits(target.user.id);

      const res = await assignmentRequest("DELETE", `/${managerRow.id}`);
      expect(res.statusCode).toBe(204);

      expect(await storedAssignments(tenant.tenant.id, target.user.id)).toEqual([]);
      expect(await columnRole(target.user.id)).toBe("EMPLOYEE");
      const audits = await newAuditsSince(target.user.id, before);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        action: "DELETE",
        entityId: managerRow.id,
        oldValue: { accessRoleId: SYSTEM_ROLE_IDS.MANAGER },
        newValue: { compatRole: { from: "MANAGER", to: "EMPLOYEE" } },
      });
      expect((await listEmployees(tokens.accessToken)).statusCode).toBe(403);
    });
  });
});
