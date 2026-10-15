/**
 * Issue #93 (Phase 93b-06, D-08, D-14, D-15, D-27, D-29) — the controller's side of a support access:
 * the tenant lists every access of its own tenant with the operator's display name, the reason, the
 * window and the number of reads, opens one access with each read, ends a running access at once, and is
 * told in-app when an access starts.
 *
 * Grants are created through the operator API and reads are made through the operator API as well, so the
 * read counts and the read rows are the ones production writes. Operator accounts are never deleted by
 * tests (audit rows reference them with onDelete Restrict), so each case that needs a fresh principal
 * seeds a fresh synthetic one. Tenants are cleaned up in `afterAll`, which also removes their grants.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  closeTestApp,
  seedGrundversionTenant,
  seedOperator,
  seedSupportAccess,
  soleAuditRow,
  cleanupTestData,
  tokenWithoutSignIn,
} from "./setup";
import { signOperatorToken } from "../contexts/platform/operator-auth";
import { normalizeRolePermissions, roleNameKey } from "../contexts/platform";

// The transporter is built inline in notify.ts through a dynamic `import("nodemailer")`; mocking
// createTransport captures every mail without a real SMTP server (same idiom as
// notification-email.test.ts).
const { sendMailMock } = vi.hoisted(() => ({ sendMailMock: vi.fn() }));

vi.mock("nodemailer", () => {
  const createTransport = vi.fn(() => ({ sendMail: sendMailMock }));
  return { default: { createTransport }, createTransport };
});

type Fixture = Awaited<ReturnType<typeof seedGrundversionTenant>>;
type Principal = { id: string; token: string; displayName: string; email: string };

const REASON = "Support ticket: saldo of one employee looks wrong";
const PASSWORD = "test1234";
const ITEM_KEYS = [
  "endedAt",
  "endedBy",
  "expiresAt",
  "id",
  "operatorName",
  "readCount",
  "reason",
  "startedAt",
  "status",
];
const READ_KEYS = ["at", "category", "employee", "filters", "month"];
const byKey = (a: string, b: string) => a.localeCompare(b);

let app: FastifyInstance;
let addressCounter = 0;
const tenants: Fixture[] = [];
const customRoleTenantIds = new Set<string>();

/** Every request carries its own remote address so the per-route rate limits never interfere. */
function uniqueAddress(): string {
  const n = addressCounter++;
  return `10.94.${Math.floor(n / 250) % 250}.${(n % 250) + 1}`;
}

async function newTenant(label: string): Promise<Fixture> {
  const fixture = await seedGrundversionTenant(app, `t93-${label}`);
  tenants.push(fixture);
  return fixture;
}

async function newPrincipal(displayName = "Support Operator"): Promise<Principal> {
  const operator = await seedOperator(app, { displayName });
  return {
    id: operator.id,
    token: signOperatorToken(app, operator.id, "access", operator.tokenVersion),
    displayName,
    email: operator.email,
  };
}

function operatorRequest(
  method: "GET" | "POST",
  url: string,
  token: string,
  payload?: Record<string, unknown>,
) {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}`, "user-agent": "vitest-support-tenant" },
    payload,
    remoteAddress: uniqueAddress(),
  });
}

async function requestGrant(tenantId: string, operator: Principal, durationHours = 1) {
  const res = await operatorRequest(
    "POST",
    `/api/v1/operator/tenants/${tenantId}/support-access`,
    operator.token,
    { reason: REASON, durationHours },
  );
  expect(res.statusCode, res.body).toBe(201);
  return (JSON.parse(res.body) as { access: { id: string } }).access;
}

function readEmployees(tenantId: string, token: string) {
  return operatorRequest("GET", `/api/v1/operator/tenants/${tenantId}/support/employees`, token);
}

function readMonth(tenantId: string, employeeId: string, month: string, token: string) {
  return operatorRequest(
    "GET",
    `/api/v1/operator/tenants/${tenantId}/support/employees/${employeeId}/month?month=${month}`,
    token,
  );
}

function tenantGet(url: string, token: string) {
  return app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
}

function tenantEnd(id: string, token: string) {
  return app.inject({
    method: "POST",
    url: `/api/v1/support-accesses/${id}/end`,
    headers: { authorization: `Bearer ${token}`, "user-agent": "vitest-tenant-end" },
  });
}

/** A tenant user whose only role carries exactly `permissions`, assigned with the given scope. */
async function createUserWithRole(
  fixture: Fixture,
  label: string,
  permissions: string[],
  scope: { scopeType: "TENANT" | "SALONS"; salonIds?: string[] } = { scopeType: "TENANT" },
) {
  const s = `${label}-${randomBytes(4).toString("hex")}`;
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const user = await app.prisma.user.create({
    data: { email: `${s}@example.invalid`, passwordHash, role: "EMPLOYEE", isActive: true },
  });
  const employee = await app.prisma.employee.create({
    data: {
      tenantId: fixture.tenant.id,
      userId: user.id,
      employeeNumber: s.toUpperCase().slice(0, 20),
      firstName: label,
      lastName: "T93",
      hireDate: new Date("2024-01-01"),
    },
  });
  const name = `T93 ${s}`;
  const role = await app.prisma.accessRole.create({
    data: {
      tenantId: fixture.tenant.id,
      name,
      nameKey: roleNameKey(name),
      permissions: normalizeRolePermissions(permissions),
    },
  });
  await app.prisma.roleAssignment.create({
    data: {
      tenantId: fixture.tenant.id,
      userId: user.id,
      accessRoleId: role.id,
      scopeType: scope.scopeType,
      salonIds: scope.salonIds ?? [],
      employeeIds: [],
    },
  });
  customRoleTenantIds.add(fixture.tenant.id);
  if (scope.scopeType === "SALONS") {
    // Both keys are whole-tenant (MANDANT relation): a SALONS assignment holds nothing and, since
    // #539 (D-14), such an account cannot sign in. The token is signed directly; the routes must
    // still answer 403.
    return { user, employee, token: await tokenWithoutSignIn(app, user.email) };
  }
  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: user.email, password: PASSWORD },
  });
  expect(login.statusCode, login.body).toBe(200);
  return { user, employee, token: (JSON.parse(login.body) as { accessToken: string }).accessToken };
}

beforeAll(async () => {
  app = await getTestApp();
});

afterAll(async () => {
  for (const t of tenants) {
    try {
      if (customRoleTenantIds.has(t.tenant.id)) {
        // RoleAssignment.accessRole is Restrict: assignments go first.
        await app.prisma.roleAssignment.deleteMany({ where: { tenantId: t.tenant.id } });
        await app.prisma.accessRole.deleteMany({ where: { tenantId: t.tenant.id } });
      }
      await cleanupTestData(app, t.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
  }
  await closeTestApp();
});

describe("GET /api/v1/support-accesses", () => {
  it("lists the own tenant's accesses newest first with name, window, status and read count", async () => {
    const a = await newTenant("list-a");
    const b = await newTenant("list-b");
    const operator = await newPrincipal("Operator Eins");
    const other = await newPrincipal("Operator Zwei");
    const now = Date.now();

    // Older rows, seeded directly: an expired one and one the operator ended early.
    const expired = await seedSupportAccess(app, {
      tenantId: a.tenant.id,
      operatorId: other.id,
      reason: "Support ticket: expired fixture grant",
      startedAt: new Date(now - 5 * 3_600_000),
      expiresAt: new Date(now - 4 * 3_600_000),
    });
    const ended = await seedSupportAccess(app, {
      tenantId: a.tenant.id,
      operatorId: other.id,
      reason: "Support ticket: ended fixture grant",
      startedAt: new Date(now - 3 * 3_600_000),
      expiresAt: new Date(now - 2 * 3_600_000),
      endedAt: new Date(now - 150 * 60_000),
      endedBy: "OPERATOR",
    });
    // Tenant B has an access with one read of its own that must never show up for tenant A.
    const foreignGrant = await requestGrant(b.tenant.id, other);
    expect((await readEmployees(b.tenant.id, other.token)).statusCode).toBe(200);

    const running = await requestGrant(a.tenant.id, operator);
    expect((await readEmployees(a.tenant.id, operator.token)).statusCode).toBe(200);
    expect(
      (await readMonth(a.tenant.id, a.employee.id, "2026-03", operator.token)).statusCode,
    ).toBe(200);
    expect(
      (await readMonth(a.tenant.id, a.adminEmployee.id, "2026-03", operator.token)).statusCode,
    ).toBe(200);

    const res = await tenantGet("/api/v1/support-accesses", a.adminToken);
    expect(res.statusCode, res.body).toBe(200);
    const body = JSON.parse(res.body) as {
      items: Record<string, unknown>[];
      total: number;
      page: number;
      limit: number;
      timezone: string;
    };
    expect(Object.keys(body).sort(byKey)).toEqual(["items", "limit", "page", "timezone", "total"]);
    expect(body.total).toBe(3);
    expect(body.page).toBe(1);
    expect(typeof body.timezone).toBe("string");
    expect(body.items.map((item) => item.id)).toEqual([running.id, ended.id, expired.id]);
    for (const item of body.items) {
      expect(Object.keys(item).sort(byKey)).toEqual(ITEM_KEYS);
    }

    const [first, second, third] = body.items;
    expect(first).toMatchObject({
      operatorName: "Operator Eins",
      reason: REASON,
      status: "ACTIVE",
      endedAt: null,
      endedBy: null,
      readCount: 3,
    });
    expect(second).toMatchObject({
      operatorName: "Operator Zwei",
      status: "ENDED",
      endedBy: "OPERATOR",
      readCount: 0,
    });
    expect(third).toMatchObject({ status: "EXPIRED", endedAt: null, readCount: 0 });

    // Data minimisation (D-29): the operator's e-mail and any client address never reach the tenant.
    expect(res.body).not.toContain(operator.email);
    expect(res.body).not.toContain(other.email);
    expect(res.body).not.toContain("ipAddress");
    expect(res.body).not.toContain("userAgent");
    expect(res.body).not.toContain("10.94.");

    // Tenant isolation: tenant B's access is absent and tenant B sees only its own.
    expect(res.body).not.toContain(foreignGrant.id);
    const resB = await tenantGet("/api/v1/support-accesses", b.adminToken);
    const bodyB = JSON.parse(resB.body) as { items: { id: string; readCount: number }[] };
    expect(bodyB.items.map((item) => item.id)).toEqual([foreignGrant.id]);
    expect(bodyB.items[0].readCount).toBe(1);
  });

  it("pages the list, clamps the page size and rejects a malformed query", async () => {
    const t = await newTenant("paging");
    const operator = await newPrincipal();
    const now = Date.now();
    for (let i = 0; i < 3; i += 1) {
      await seedSupportAccess(app, {
        tenantId: t.tenant.id,
        operatorId: operator.id,
        startedAt: new Date(now - (i + 2) * 3_600_000),
        expiresAt: new Date(now - (i + 1) * 3_600_000 - 1_800_000),
      });
    }
    const first = await tenantGet("/api/v1/support-accesses?limit=2", t.adminToken);
    const secondPage = await tenantGet("/api/v1/support-accesses?limit=2&page=2", t.adminToken);
    const one = JSON.parse(first.body) as { items: { id: string }[]; total: number };
    const two = JSON.parse(secondPage.body) as { items: { id: string }[]; page: number };
    expect(one.total).toBe(3);
    expect(one.items).toHaveLength(2);
    expect(two.items).toHaveLength(1);
    expect(two.page).toBe(2);
    expect(one.items.map((i) => i.id)).not.toContain(two.items[0].id);

    for (const query of ["page=0", "limit=0", "page=abc", "unknown=1"]) {
      const res = await tenantGet(`/api/v1/support-accesses?${query}`, t.adminToken);
      expect(res.statusCode, query).toBe(400);
    }
    // A page size above the maximum is clamped, never honoured.
    const clamped = await tenantGet("/api/v1/support-accesses?limit=9999", t.adminToken);
    expect(clamped.statusCode).toBe(200);
    expect((JSON.parse(clamped.body) as { limit: number }).limit).toBe(100);
  });
});

describe("GET /api/v1/support-accesses/:id", () => {
  it("shows every read in time order with the employee name, and a null name for an anonymised employee", async () => {
    const t = await newTenant("detail");
    const operator = await newPrincipal("Operator Detail");
    const grant = await requestGrant(t.tenant.id, operator);

    expect((await readEmployees(t.tenant.id, operator.token)).statusCode).toBe(200);
    expect(
      (await readMonth(t.tenant.id, t.employee.id, "2026-03", operator.token)).statusCode,
    ).toBe(200);
    expect(
      (await readMonth(t.tenant.id, t.adminEmployee.id, "2026-04", operator.token)).statusCode,
    ).toBe(200);
    const contracts = await operatorRequest(
      "GET",
      `/api/v1/operator/tenants/${t.tenant.id}/support/employees/${t.employee.id}/contracts`,
      operator.token,
    );
    expect(contracts.statusCode, contracts.body).toBe(200);

    // The DSGVO anonymisation sentinel, applied AFTER the read: the stored row names the id only.
    await app.prisma.employee.update({
      where: { id: t.adminEmployee.id },
      data: { firstName: "Gelöscht", lastName: `GELÖSCHT-${randomBytes(3).toString("hex")}` },
    });

    const res = await tenantGet(`/api/v1/support-accesses/${grant.id}`, t.adminToken);
    expect(res.statusCode, res.body).toBe(200);
    const body = JSON.parse(res.body) as {
      access: Record<string, unknown>;
      reads: {
        at: string;
        category: string;
        employee: { id: string; name: string | null; anonymized: boolean } | null;
        month: string | null;
        filters: unknown;
      }[];
      timezone: string;
    };
    expect(Object.keys(body).sort(byKey)).toEqual(["access", "reads", "timezone"]);
    expect(Object.keys(body.access).sort(byKey)).toEqual(ITEM_KEYS);
    expect(body.access).toMatchObject({
      operatorName: "Operator Detail",
      reason: REASON,
      status: "ACTIVE",
      readCount: 4,
    });
    expect(body.reads).toHaveLength(4);
    for (const read of body.reads) expect(Object.keys(read).sort(byKey)).toEqual(READ_KEYS);

    expect(body.reads.map((read) => read.category)).toEqual([
      "EMPLOYEES",
      "EMPLOYEE_MONTH",
      "EMPLOYEE_MONTH",
      "CONTRACTS",
    ]);
    const times = body.reads.map((read) => Date.parse(read.at));
    expect(times).toEqual([...times].sort((x, y) => x - y));

    expect(body.reads[0].employee).toBeNull();
    expect(body.reads[0].month).toBeNull();
    expect(body.reads[1]).toMatchObject({
      employee: {
        id: t.employee.id,
        name: `${t.employee.firstName} ${t.employee.lastName}`,
        anonymized: false,
      },
      month: "2026-03",
    });
    expect(body.reads[2]).toMatchObject({
      employee: { id: t.adminEmployee.id, name: null, anonymized: true },
      month: "2026-04",
    });
    expect(body.reads[3].employee).toMatchObject({ id: t.employee.id, anonymized: false });

    expect(res.body).not.toContain("ipAddress");
    expect(res.body).not.toContain(operator.email);
  });

  it("answers a foreign tenant's access and an unknown id with the identical 404", async () => {
    const a = await newTenant("oracle-a");
    const b = await newTenant("oracle-b");
    const operator = await newPrincipal();
    const foreign = await requestGrant(b.tenant.id, operator);

    const foreignRes = await tenantGet(`/api/v1/support-accesses/${foreign.id}`, a.adminToken);
    const unknownRes = await tenantGet(`/api/v1/support-accesses/${randomUUID()}`, a.adminToken);
    expect(foreignRes.statusCode).toBe(404);
    expect(unknownRes.statusCode).toBe(404);
    expect(foreignRes.body).toBe(unknownRes.body);

    // A malformed id is a validation error for every caller alike, never a membership signal.
    const malformed = await tenantGet("/api/v1/support-accesses/not-a-uuid", a.adminToken);
    expect(malformed.statusCode).toBe(400);
  });
});

describe("POST /api/v1/support-accesses/:id/end", () => {
  it("ends a running access at once, logs the end in both protocols and refuses the operator's next read", async () => {
    const t = await newTenant("end");
    const operator = await newPrincipal("Operator Ende");
    const grant = await requestGrant(t.tenant.id, operator, 4);
    expect((await readEmployees(t.tenant.id, operator.token)).statusCode).toBe(200);

    const res = await tenantEnd(grant.id, t.adminToken);
    expect(res.statusCode, res.body).toBe(200);
    const body = JSON.parse(res.body) as { access: Record<string, unknown> };
    expect(Object.keys(body)).toEqual(["access"]);
    expect(Object.keys(body.access).sort(byKey)).toEqual(ITEM_KEYS);
    expect(body.access).toMatchObject({
      id: grant.id,
      status: "ENDED",
      endedBy: "TENANT",
      operatorName: "Operator Ende",
      readCount: 1,
    });
    expect(body.access.endedAt).not.toBeNull();

    const row = await app.prisma.supportAccess.findUniqueOrThrow({ where: { id: grant.id } });
    expect(row.endedBy).toBe("TENANT");
    expect(row.endedByUserId).toBe(t.adminUser.id);
    expect(row.endedAt).not.toBeNull();

    // Tenant protocol: written by the acting user.
    const tenantRow = await soleAuditRow(app.prisma, {
      where: { entity: "SupportAccess", entityId: grant.id, action: "SUPPORT_ACCESS_ENDED" },
    });
    expect(tenantRow.userId).toBe(t.adminUser.id);
    expect(tenantRow.newValue).toMatchObject({ endedBy: "TENANT" });

    // Operator protocol: the tenant acted, so the operator column is null and the grant's operator and
    // the acting user are named in the value (D-27).
    const operatorRows = await app.prisma.operatorAuditLog.findMany({
      where: { entity: "SupportAccess", entityId: grant.id, action: "SUPPORT_ACCESS_ENDED" },
    });
    expect(operatorRows).toHaveLength(1);
    expect(operatorRows[0].operatorId).toBeNull();
    expect(operatorRows[0].subjectTenantId).toBe(t.tenant.id);
    expect(operatorRows[0].newValue).toMatchObject({
      endedBy: "TENANT",
      endedByUserId: t.adminUser.id,
      grantOperatorId: operator.id,
    });

    const next = await readEmployees(t.tenant.id, operator.token);
    expect(next.statusCode).toBe(403);
    expect(JSON.parse(next.body).code).toBe("SUPPORT_ACCESS_REQUIRED");

    // The tenant's own audit-log view carries the end row for the tenant.
    const log = await tenantGet("/api/v1/audit-logs?entity=SupportAccess", t.adminToken);
    expect(log.statusCode).toBe(200);
    expect(
      (JSON.parse(log.body) as { logs: { action: string }[] }).logs.map((l) => l.action),
    ).toContain("SUPPORT_ACCESS_ENDED");
  });

  it("answers 409 SUPPORT_ACCESS_NOT_ACTIVE for a second end, an operator-ended and an expired access", async () => {
    const t = await newTenant("end-409");
    const operator = await newPrincipal();
    const grant = await requestGrant(t.tenant.id, operator);
    expect((await tenantEnd(grant.id, t.adminToken)).statusCode).toBe(200);

    const again = await tenantEnd(grant.id, t.adminToken);
    expect(again.statusCode).toBe(409);
    expect(JSON.parse(again.body).code).toBe("SUPPORT_ACCESS_NOT_ACTIVE");

    const now = Date.now();
    const expired = await seedSupportAccess(app, {
      tenantId: t.tenant.id,
      operatorId: operator.id,
      startedAt: new Date(now - 3 * 3_600_000),
      expiresAt: new Date(now - 2 * 3_600_000),
    });
    const operatorEnded = await seedSupportAccess(app, {
      tenantId: t.tenant.id,
      operatorId: operator.id,
      startedAt: new Date(now - 3 * 3_600_000),
      expiresAt: new Date(now + 3_600_000),
      endedAt: new Date(now - 3_600_000),
      endedBy: "OPERATOR",
    });
    for (const row of [expired, operatorEnded]) {
      const res = await tenantEnd(row.id, t.adminToken);
      expect(res.statusCode, row.id).toBe(409);
      expect(JSON.parse(res.body).code).toBe("SUPPORT_ACCESS_NOT_ACTIVE");
      const after = await app.prisma.supportAccess.findUniqueOrThrow({ where: { id: row.id } });
      expect(after.endedBy).toBe(row.endedBy);
      expect(after.endedByUserId).toBeNull();
    }
    // Only the one successful end wrote end rows.
    expect(
      await app.prisma.auditLog.count({
        where: { entity: "SupportAccess", action: "SUPPORT_ACCESS_ENDED", userId: t.adminUser.id },
      }),
    ).toBe(1);
  });

  it("answers a foreign tenant's access and an unknown id with the identical 404 and ends nothing", async () => {
    const a = await newTenant("end-oracle-a");
    const b = await newTenant("end-oracle-b");
    const operator = await newPrincipal();
    const foreign = await requestGrant(b.tenant.id, operator);

    const foreignRes = await tenantEnd(foreign.id, a.adminToken);
    const unknownRes = await tenantEnd(randomUUID(), a.adminToken);
    expect(foreignRes.statusCode).toBe(404);
    expect(unknownRes.statusCode).toBe(404);
    expect(foreignRes.body).toBe(unknownRes.body);

    const untouched = await app.prisma.supportAccess.findUniqueOrThrow({
      where: { id: foreign.id },
    });
    expect(untouched.endedAt).toBeNull();
    expect(untouched.endedBy).toBeNull();
    expect((await readEmployees(b.tenant.id, operator.token)).statusCode).toBe(200);
  });
});

describe("who may reach the tenant routes", () => {
  it("refuses an EMPLOYEE token and an operator token on all three routes with 403", async () => {
    const t = await newTenant("principals");
    const operator = await newPrincipal();
    const grant = await requestGrant(t.tenant.id, operator);

    const calls: [string, string][] = [
      ["GET", "/api/v1/support-accesses"],
      ["GET", `/api/v1/support-accesses/${grant.id}`],
      ["POST", `/api/v1/support-accesses/${grant.id}/end`],
    ];
    for (const token of [t.empToken, operator.token]) {
      for (const [method, url] of calls) {
        const res = await app.inject({
          method: method as "GET" | "POST",
          url,
          headers: { authorization: `Bearer ${token}` },
          remoteAddress: uniqueAddress(),
        });
        expect(res.statusCode, `${method} ${url}`).toBe(403);
        expect(res.body).not.toContain(REASON);
      }
    }
    // Nothing was ended by the refused calls.
    const row = await app.prisma.supportAccess.findUniqueOrThrow({ where: { id: grant.id } });
    expect(row.endedAt).toBeNull();
  });

  it("answers 401 without a token", async () => {
    for (const [method, url] of [
      ["GET", "/api/v1/support-accesses"],
      ["GET", `/api/v1/support-accesses/${randomUUID()}`],
      ["POST", `/api/v1/support-accesses/${randomUUID()}/end`],
    ] as const) {
      const res = await app.inject({ method, url });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it("gives a salon-scoped holder of both permissions nothing: both keys need the whole tenant", async () => {
    const t = await newTenant("salon-scope");
    const operator = await newPrincipal();
    const grant = await requestGrant(t.tenant.id, operator);
    const scoped = await createUserWithRole(
      t,
      "salonScoped",
      ["audit-log:read:ZUGEWIESEN", "tenant-settings:update:ZUGEWIESEN"],
      { scopeType: "SALONS", salonIds: [t.salonId] },
    );

    expect((await tenantGet("/api/v1/support-accesses", scoped.token)).statusCode).toBe(403);
    expect((await tenantGet(`/api/v1/support-accesses/${grant.id}`, scoped.token)).statusCode).toBe(
      403,
    );
    expect((await tenantEnd(grant.id, scoped.token)).statusCode).toBe(403);
    const row = await app.prisma.supportAccess.findUniqueOrThrow({ where: { id: grant.id } });
    expect(row.endedAt).toBeNull();
  });

  it("separates the two permissions: audit-log:read reads but cannot end, tenant-settings:update ends but cannot read", async () => {
    const t = await newTenant("split");
    const operator = await newPrincipal();
    const grant = await requestGrant(t.tenant.id, operator);
    const reader = await createUserWithRole(t, "reader", ["audit-log:read:ZUGEWIESEN"]);
    const ender = await createUserWithRole(t, "ender", ["tenant-settings:update:ZUGEWIESEN"]);

    expect((await tenantGet("/api/v1/support-accesses", reader.token)).statusCode).toBe(200);
    expect((await tenantEnd(grant.id, reader.token)).statusCode).toBe(403);
    expect((await tenantGet("/api/v1/support-accesses", ender.token)).statusCode).toBe(403);

    const res = await tenantEnd(grant.id, ender.token);
    expect(res.statusCode, res.body).toBe(200);
    const row = await app.prisma.supportAccess.findUniqueOrThrow({ where: { id: grant.id } });
    expect(row.endedByUserId).toBe(ender.user.id);
  });
});

describe("no tenant write path on the access or the logs (AC-93-6)", () => {
  it("registers no PUT, PATCH or DELETE on the support-access routes", () => {
    for (const method of ["PUT", "PATCH", "DELETE"] as const) {
      for (const url of [
        "/api/v1/support-accesses",
        "/api/v1/support-accesses/:id",
        "/api/v1/support-accesses/:id/end",
      ]) {
        expect(app.hasRoute({ method, url }), `${method} ${url}`).toBe(false);
      }
    }
    expect(app.hasRoute({ method: "POST", url: "/api/v1/support-accesses" })).toBe(false);
  });
});

// ── In-app notification (D-08, D-14) ──────────────────────────────────────────────────────────────

const SMTP_CONFIGURED = {
  smtpHost: "smtp.test.local",
  smtpPort: 587,
  smtpUser: "smtp-user",
  smtpPassword: "smtp-pass",
  smtpFromEmail: "noreply@test.local",
  smtpFromName: "Clokr Test",
  smtpSecure: false,
};

/** Every start notice of one access, oldest first. */
function noticesFor(accessId: string) {
  return app.prisma.notification.findMany({
    where: { type: "SUPPORT_ACCESS_STARTED", relatedType: "SupportAccess", relatedId: accessId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

const idsOf = (rows: { userId: string }[]) => rows.map((row) => row.userId).sort(byKey);

describe("the tenant is told in-app when an access starts", () => {
  beforeEach(() => {
    sendMailMock.mockReset();
    sendMailMock.mockResolvedValue({ messageId: "test-message-id" });
  });

  it("notifies exactly the whole-tenant tenant-settings:update holders, with the link only for audit-log:read holders", async () => {
    const t = await newTenant("notify");
    const other = await newTenant("notify-other");
    const operator = await newPrincipal();

    const settingsOnly = await createUserWithRole(t, "settingsOnly", [
      "tenant-settings:update:ZUGEWIESEN",
    ]);
    const auditOnly = await createUserWithRole(t, "auditOnly", ["audit-log:read:ZUGEWIESEN"]);
    const salonScoped = await createUserWithRole(
      t,
      "salonSettings",
      ["tenant-settings:update:ZUGEWIESEN"],
      { scopeType: "SALONS", salonIds: [t.salonId] },
    );
    const inactive = await createUserWithRole(t, "inactiveAdmin", [
      "tenant-settings:update:ZUGEWIESEN",
    ]);
    await app.prisma.user.update({ where: { id: inactive.user.id }, data: { isActive: false } });

    const grant = await requestGrant(t.tenant.id, operator, 4);
    const row = await app.prisma.supportAccess.findUniqueOrThrow({ where: { id: grant.id } });

    const notices = await noticesFor(grant.id);
    // The seeded admin (stored ADMIN row) and the tenant-settings:update-only user; never the
    // EMPLOYEE, the audit-log:read-only user, a salon-scoped holder, an inactive user or tenant B's admin.
    expect(idsOf(notices)).toEqual([t.adminUser.id, settingsOnly.user.id].sort(byKey));
    for (const excluded of [
      t.empUser.id,
      auditOnly.user.id,
      salonScoped.user.id,
      inactive.user.id,
      other.adminUser.id,
    ]) {
      expect(notices.map((n) => n.userId)).not.toContain(excluded);
    }
    // No notice anywhere else for this access.
    expect(await app.prisma.notification.count({ where: { relatedId: grant.id } })).toBe(2);

    // The link follows the target page's guard: only the admin also holds audit-log:read.
    const withLink = notices.filter((n) => n.link !== null).map((n) => n.userId);
    expect(withLink).toEqual([t.adminUser.id]);
    const admin = notices.find((n) => n.userId === t.adminUser.id);
    expect(admin?.link).toBe(`/admin/support-access/${grant.id}`);

    const config = await app.prisma.tenantConfig.findUniqueOrThrow({
      where: { tenantId: t.tenant.id },
      select: { timezone: true },
    });
    const endsAt = new Intl.DateTimeFormat("de-DE", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: config.timezone,
    }).format(row.expiresAt);
    for (const notice of notices) {
      expect(notice.title).toBe("Support-Zugriff gestartet");
      expect(notice.message).toContain(REASON);
      expect(notice.message).toContain(endsAt);
      expect(notice.relatedType).toBe("SupportAccess");
      expect(notice.relatedId).toBe(grant.id);
      expect(notice.dismissedAt).toBeNull();
    }
    // Same text for every recipient: only the link differs.
    expect(new Set(notices.map((n) => n.message)).size).toBe(1);

    // Tenant B learned nothing about tenant A's access.
    expect(await app.prisma.notification.count({ where: { userId: other.adminUser.id } })).toBe(0);
  });

  it("never undoes the grant when the notification layer fails", async () => {
    const t = await newTenant("notify-fail");
    const operator = await newPrincipal();
    const spy = vi.spyOn(app, "notify").mockRejectedValue(new Error("notify exploded"));
    try {
      const res = await operatorRequest(
        "POST",
        `/api/v1/operator/tenants/${t.tenant.id}/support-access`,
        operator.token,
        { reason: REASON },
      );
      expect(res.statusCode, res.body).toBe(201);
      const id = (JSON.parse(res.body) as { access: { id: string } }).access.id;
      expect(spy).toHaveBeenCalled();
      const row = await app.prisma.supportAccess.findUniqueOrThrow({ where: { id } });
      expect(row.endedAt).toBeNull();
      expect(await noticesFor(id)).toHaveLength(0);
      // The grant works: the operator can read under it.
      expect((await readEmployees(t.tenant.id, operator.token)).statusCode).toBe(200);
    } finally {
      spy.mockRestore();
    }
  });

  it("dismisses the start notices when the tenant ends the access", async () => {
    const t = await newTenant("dismiss-tenant");
    const operator = await newPrincipal();
    const grant = await requestGrant(t.tenant.id, operator);
    const before = await noticesFor(grant.id);
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((n) => n.dismissedAt === null)).toBe(true);

    expect((await tenantEnd(grant.id, t.adminToken)).statusCode).toBe(200);
    const after = await noticesFor(grant.id);
    expect(after).toHaveLength(before.length);
    expect(after.every((n) => n.dismissedAt !== null)).toBe(true);
  });

  it("dismisses the start notices when the operator ends the access", async () => {
    const t = await newTenant("dismiss-operator");
    const operator = await newPrincipal();
    const grant = await requestGrant(t.tenant.id, operator);
    expect((await noticesFor(grant.id)).every((n) => n.dismissedAt === null)).toBe(true);

    const res = await operatorRequest(
      "POST",
      `/api/v1/operator/tenants/${t.tenant.id}/support-access/${grant.id}/end`,
      operator.token,
    );
    expect(res.statusCode, res.body).toBe(200);
    const after = await noticesFor(grant.id);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((n) => n.dismissedAt !== null)).toBe(true);
  });

  it("never sends a mail for it, while a mailed type still goes out under the same configuration", async () => {
    const t = await newTenant("no-mail");
    const operator = await newPrincipal();
    await app.prisma.tenantConfig.update({
      where: { tenantId: t.tenant.id },
      data: { ...SMTP_CONFIGURED, emailNotificationsEnabled: true, emailOnLeaveRequest: true },
    });

    // Control: the same configuration does mail a type whose policy allows it, so the silence
    // below proves the policy and not a broken mail path.
    await app.notify({
      userId: t.adminUser.id,
      type: "LEAVE_REQUEST",
      title: "Neuer Urlaubsantrag",
      message: "Ein Urlaubsantrag wurde gestellt.",
      tenantId: t.tenant.id,
    });
    await vi.waitFor(() => expect(sendMailMock).toHaveBeenCalledTimes(1));
    sendMailMock.mockClear();

    const grant = await requestGrant(t.tenant.id, operator);
    expect((await noticesFor(grant.id)).length).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(sendMailMock).not.toHaveBeenCalled();
  });
});
