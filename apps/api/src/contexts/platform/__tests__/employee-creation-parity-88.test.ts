/**
 * Phase 88 plan 10 (D-04a, AC-88-05/06) — employee creation has ONE implementation.
 *
 * (a) Parity: the first admin created by `provisionTenantWithAdmin` and the same admin input posted
 *     to `POST /api/v1/employees` (by the admin of another provisioned tenant) produce the same
 *     rows and the same non-identity field values. Only ids, tenant, timestamps, e-mail, employee
 *     number and the audit actor differ.
 * (b) Usability: a provisioned tenant works immediately — accept the invitation, log in, see
 *     exactly the default salon in `GET /api/v1/me/context`, create an employee.
 *
 * Parity is compared on a tenant WITHOUT a VACATION LeaveType on both sides (a freshly provisioned
 * tenant has none), so the hire-year entitlement row is absent on both; see the plan 10 SUMMARY.
 *
 * Mutation, recorded here, not re-run by CI (Phase 88 plan 10, 2026-10-13), run red then restored
 * from a `cp` backup:
 * - M6: change the invitation lifetime in `employee-creation.ts` from 24 h to 48 h -> red: "(a) the
 *   invitation lifetime is 24 hours on both paths". No pre-existing employee test asserted it; the L3 case (e) in
 *   tenant-provisioning-88.test.ts goes red as well.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, cleanupTestData, seedOperator } from "../../../__tests__/setup";
import { operatorEmployeeCreationAudit, provisionTenantWithAdmin } from "../tenant-provisioning";

const PASSWORD = "Usab1lity-Passw0rd!2026";

function uniqueSlug(label: string): string {
  return `par88-${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Keys that legitimately differ between two employees of two tenants. */
const IDENTITY_KEYS = new Set([
  "id",
  "tenantId",
  "userId",
  "employeeId",
  "salonId",
  "accessRoleId",
  "email",
  "employeeNumber",
  "passwordHash",
  "token",
  "createdAt",
  "updatedAt",
  "lastLoginAt",
  "expiresAt",
  "entityId",
]);

function stripIdentity(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripIdentity);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !IDENTITY_KEYS.has(key))
        .map(([key, v]) => [key, stripIdentity(v)]),
    );
  }
  return value;
}

describe("employee creation: one implementation (Phase 88 plan 10)", () => {
  let app: FastifyInstance;
  let operatorId: string;
  const tenantIds: string[] = [];

  beforeAll(async () => {
    app = await getTestApp();
    operatorId = (await seedOperator(app)).id;
  });

  afterAll(async () => {
    for (const id of tenantIds) await cleanupTestData(app, id);
    await closeTestApp();
  });

  async function provisionAdmin(label: string) {
    const slug = uniqueSlug(label);
    const email = `${slug}@example.invalid`;
    const result = await app.prisma.$transaction((tx) =>
      provisionTenantWithAdmin(
        tx,
        {
          tenant: { name: `Tenant ${slug}`, slug, federalState: "HESSEN" },
          admin: { email, firstName: "Erste", lastName: "Leitung" },
        },
        (tenantId) => operatorEmployeeCreationAudit(app, { operatorId, tenantId }),
      ),
    );
    if (result.status !== "OK") throw new Error(`provisioning failed: ${result.status}`);
    tenantIds.push(result.tenant.id);
    return { ...result, email };
  }

  async function activateAndLogin(email: string, token: string): Promise<string> {
    const accept = await app.inject({
      method: "POST",
      url: "/api/v1/invitations/accept",
      payload: { token, password: PASSWORD },
    });
    expect(accept.statusCode, accept.body).toBe(200);
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password: PASSWORD },
    });
    expect(login.statusCode, login.body).toBe(200);
    return (JSON.parse(login.body) as { accessToken: string }).accessToken;
  }

  /** Everything an employee creation wrote for `employeeId`, minus identity. */
  async function rowsOf(employeeId: string) {
    const employee = await app.prisma.employee.findUniqueOrThrow({
      where: { id: employeeId },
      include: { user: true, workSchedules: true, overtimeAccount: true, invitations: true },
    });
    const roleAssignments = await app.prisma.roleAssignment.findMany({
      where: { userId: employee.userId },
      include: { accessRole: { select: { name: true } } },
    });
    const salonAssignments = await app.prisma.employeeSalonAssignment.findMany({
      where: { employeeId },
    });
    const entitlements = await app.prisma.leaveEntitlement.findMany({ where: { employeeId } });
    const { invitations, ...employeeRow } = employee;
    return {
      employee: stripIdentity(employeeRow),
      invitations: invitations.map((inv) => ({
        acceptedAt: inv.acceptedAt,
        lifetimeMs: inv.expiresAt.getTime() - inv.createdAt.getTime(),
      })),
      roleAssignments: stripIdentity(roleAssignments),
      salonAssignments: stripIdentity(salonAssignments),
      entitlementCount: entitlements.length,
    };
  }

  it("(a) the same admin input via the route and via L3 yields the same rows", async () => {
    const provisioned = await provisionAdmin("parity");
    // Read the L3 rows before the invitation is accepted: accepting activates the user.
    const viaL3 = await rowsOf(provisioned.employee.id);
    const adminToken = await activateAndLogin(provisioned.email, provisioned.invitationToken);

    // The very input L3 builds for its admin, posted to the route by that tenant's admin.
    const hireDate = provisioned.employee.hireDate.toISOString();
    const second = await app.inject({
      method: "POST",
      url: "/api/v1/employees",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        email: `second-${provisioned.email}`,
        firstName: "Erste",
        lastName: "Leitung",
        employeeNumber: "2",
        hireDate,
        role: "ADMIN",
        scheduleType: "MONTHLY_HOURS",
        monthlyHours: null,
        homeSalonId: provisioned.salon.id,
      },
    });
    expect(second.statusCode, second.body).toBe(201);
    const secondId = (JSON.parse(second.body) as { id: string }).id;

    const viaRoute = await rowsOf(secondId);

    // Compared: the Employee row incl. user (role, isActive), every WorkSchedule column,
    // the OvertimeAccount, the RoleAssignment (role name, scope, salons, persons), the Stammsalon
    // assignment (kind, validity), the open invitation (not accepted), the entitlement row count.
    expect(viaRoute.employee).toEqual(viaL3.employee);
    expect(viaRoute.roleAssignments).toEqual(viaL3.roleAssignments);
    expect(viaRoute.salonAssignments).toEqual(viaL3.salonAssignments);
    expect(viaRoute.entitlementCount).toBe(viaL3.entitlementCount);
    expect(viaRoute.invitations.map((i) => i.acceptedAt)).toEqual(
      viaL3.invitations.map((i) => i.acceptedAt),
    );
    // The one-row-per-kind shape, spelled out so an empty projection cannot pass vacuously.
    expect(viaL3.roleAssignments).toHaveLength(1);
    expect(viaL3.salonAssignments).toHaveLength(1);
    expect(viaL3.invitations).toHaveLength(1);
  });

  it("(a) the invitation lifetime is 24 hours on both paths", async () => {
    const provisioned = await provisionAdmin("life");
    const adminToken = await activateAndLogin(provisioned.email, provisioned.invitationToken);
    const second = await app.inject({
      method: "POST",
      url: "/api/v1/employees",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        email: `second-${provisioned.email}`,
        firstName: "Zweite",
        lastName: "Person",
        employeeNumber: "2",
        hireDate: provisioned.employee.hireDate.toISOString(),
        homeSalonId: provisioned.salon.id,
        usualWorkDays: [1, 2, 3, 4, 5],
      },
    });
    expect(second.statusCode, second.body).toBe(201);
    const secondId = (JSON.parse(second.body) as { id: string }).id;

    const day = 24 * 60 * 60 * 1000;
    // L3's invitation was accepted above; its lifetime is still readable from the row.
    for (const employeeId of [provisioned.employee.id, secondId]) {
      const [invitation] = await app.prisma.invitation.findMany({ where: { employeeId } });
      const lifetime = invitation.expiresAt.getTime() - invitation.createdAt.getTime();
      expect(Math.abs(lifetime - day), `employee ${employeeId}`).toBeLessThan(60_000);
    }
  });

  it("(a) the audit rows differ only in the actor: route rows name the tenant user, L3 rows the operator", async () => {
    const provisioned = await provisionAdmin("actor");
    const adminToken = await activateAndLogin(provisioned.email, provisioned.invitationToken);
    const second = await app.inject({
      method: "POST",
      url: "/api/v1/employees",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        email: `second-${provisioned.email}`,
        firstName: "Erste",
        lastName: "Leitung",
        employeeNumber: "2",
        hireDate: provisioned.employee.hireDate.toISOString(),
        role: "ADMIN",
        scheduleType: "MONTHLY_HOURS",
        monthlyHours: null,
        homeSalonId: provisioned.salon.id,
      },
    });
    expect(second.statusCode, second.body).toBe(201);
    const secondBody = JSON.parse(second.body) as { id: string; userId: string };

    async function auditKinds(employeeId: string, userId: string) {
      const home = await app.prisma.employeeSalonAssignment.findFirstOrThrow({
        where: { employeeId },
      });
      const role = await app.prisma.roleAssignment.findFirstOrThrow({ where: { userId } });
      const rows = await app.prisma.auditLog.findMany({
        where: { entityId: { in: [employeeId, home.id, role.id] } },
      });
      return rows;
    }

    const l3Rows = await auditKinds(provisioned.employee.id, provisioned.user.id);
    const routeRows = await auditKinds(secondBody.id, secondBody.userId);
    expect(routeRows.map((r) => `${r.entity}:${r.action}`).sort()).toEqual(
      l3Rows.map((r) => `${r.entity}:${r.action}`).sort(),
    );
    for (const row of routeRows) expect(row.userId).toBe(provisioned.user.id);
    for (const row of l3Rows) expect(row.userId).toBeNull();
  });

  it("(b) a provisioned tenant is immediately usable: accept, login, one salon, create an employee", async () => {
    const provisioned = await provisionAdmin("usable");
    const adminToken = await activateAndLogin(provisioned.email, provisioned.invitationToken);

    const context = await app.inject({
      method: "GET",
      url: "/api/v1/me/context",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(context.statusCode, context.body).toBe(200);
    const body = JSON.parse(context.body) as {
      tenant: { id: string };
      salons: { id: string }[];
    };
    expect(body.tenant.id).toBe(provisioned.tenant.id);
    expect(body.salons.map((s) => s.id)).toEqual([provisioned.salon.id]);

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/employees",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        email: `new-hire-${provisioned.email}`,
        firstName: "Neu",
        lastName: "Eingestellt",
        employeeNumber: "2",
        hireDate: new Date().toISOString(),
        usualWorkDays: [1, 2, 3, 4, 5],
      },
    });
    expect(created.statusCode, created.body).toBe(201);
  });
});
