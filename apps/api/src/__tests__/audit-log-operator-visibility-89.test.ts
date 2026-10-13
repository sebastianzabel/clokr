/**
 * Phase 89 (#89, D-09a, T-89-23) — a tenant admin's audit log shows the operator rows stamped with
 * that tenant, and never another tenant's.
 *
 * Operator-written rows have no user, so the tenant reader finds them only through the stamp
 * `newValue.actor.tenantId` written by `operator-tenant-audit.ts`. Rows written by Phase 88
 * (before the stamp existed) stay invisible by design — they are inserted directly below to pin
 * that. AuditLog rows are append-only and never deleted here; only tenant fixtures are cleaned up.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, seedOperator, cleanupTestData } from "./setup";
import { operatorTenantAudit } from "../contexts/platform/operator-tenant-audit";
import { signOperatorToken } from "../contexts/platform/operator-auth";

const PASSWORD = "Usab1lity-Passw0rd!2026";

let app: FastifyInstance;
let tenantA: Awaited<ReturnType<typeof seedTestData>>;
let tenantB: Awaited<ReturnType<typeof seedTestData>>;
let operatorId: string;
let operatorToken: string;
let addressCounter = 0;
const createdTenantIds: string[] = [];
let mailSpy: ReturnType<typeof vi.spyOn>;
let mails: { to: string; token: string }[] = [];

// One entity id per fixture row, so every assertion can find "its" row without a magic string.
const stampedA = { entityId: randomUUID(), entity: "Salon", action: "CREATE" };
const stampedB = { entityId: randomUUID(), entity: "Salon", action: "CREATE" };
const unstamped = { entityId: randomUUID(), entity: "Salon", action: "CREATE" };
const stampedAOther = { entityId: randomUUID(), entity: "Tenant", action: "UPDATE" };
let stampedAId: string;
let stampedBId: string;
let unstampedId: string;

function uniqueAddress(): string {
  const n = addressCounter++;
  return `10.90.${Math.floor(n / 250) % 250}.${(n % 250) + 1}`;
}

function get(url: string, token: string) {
  return app.inject({
    method: "GET",
    url,
    headers: { authorization: `Bearer ${token}` },
    remoteAddress: uniqueAddress(),
  });
}

type LogRow = {
  id: string;
  action: string;
  entity: string;
  entityId: string | null;
  userId: string | null;
  user: { email: string } | null;
  newValue: { actor?: { type: string; operatorId: string; tenantId: string } } | null;
};

async function list(token: string, query = ""): Promise<{ logs: LogRow[]; total: number }> {
  const res = await get(`/api/v1/audit-logs?limit=200${query}`, token);
  expect(res.statusCode, res.body).toBe(200);
  return JSON.parse(res.body);
}

beforeAll(async () => {
  app = await getTestApp();
  tenantA = await seedTestData(app, "alv89a");
  tenantB = await seedTestData(app, "alv89b");
  const operator = await seedOperator(app);
  operatorId = operator.id;
  operatorToken = signOperatorToken(app, operatorId, "access", operator.tokenVersion);
  mailSpy = vi.spyOn(app.mailer, "sendInvitation").mockImplementation(async (params) => {
    mails.push(params);
  });

  await operatorTenantAudit(app, { operatorId, tenantId: tenantA.tenant.id })({
    ...stampedA,
    newValue: { name: "Fixture A" },
  });
  await operatorTenantAudit(app, { operatorId, tenantId: tenantA.tenant.id })({
    ...stampedAOther,
    newValue: { name: "Fixture A2" },
  });
  await operatorTenantAudit(app, { operatorId, tenantId: tenantB.tenant.id })({
    ...stampedB,
    newValue: { name: "Fixture B" },
  });
  // The shape Phase 88 wrote: operator actor, no tenant stamp.
  await app.prisma.auditLog.create({
    data: {
      action: unstamped.action,
      entity: unstamped.entity,
      entityId: unstamped.entityId,
      newValue: { name: "Pre-89", actor: { type: "OPERATOR", operatorId } },
    },
  });

  stampedAId = (
    await app.prisma.auditLog.findFirstOrThrow({ where: { entityId: stampedA.entityId } })
  ).id;
  stampedBId = (
    await app.prisma.auditLog.findFirstOrThrow({ where: { entityId: stampedB.entityId } })
  ).id;
  unstampedId = (
    await app.prisma.auditLog.findFirstOrThrow({ where: { entityId: unstamped.entityId } })
  ).id;
});

afterEach(() => {
  mailSpy.mockClear();
});

afterAll(async () => {
  mailSpy.mockRestore();
  for (const id of createdTenantIds) await cleanupTestData(app, id);
  await cleanupTestData(app, tenantA.tenant.id);
  await cleanupTestData(app, tenantB.tenant.id);
  await closeTestApp();
});

describe("GET /api/v1/audit-logs — operator rows (D-09a)", () => {
  it("shows the tenant its own stamped operator rows next to its user rows", async () => {
    // A user row of tenant A, so both branches of the scope are exercised.
    await app.audit({
      userId: tenantA.adminUser.id,
      action: "UPDATE",
      entity: "Employee",
      entityId: tenantA.adminEmployee.id,
      newValue: { fixture: true },
    });

    const { logs } = await list(tenantA.adminToken);
    const stamped = logs.find((l) => l.entityId === stampedA.entityId);
    expect(stamped, "A's stamped operator row must be visible").toBeDefined();
    expect(stamped?.userId).toBeNull();
    expect(stamped?.user).toBeNull();
    expect(stamped?.newValue?.actor).toEqual({
      type: "OPERATOR",
      operatorId,
      tenantId: tenantA.tenant.id,
    });
    expect(logs.some((l) => l.userId === tenantA.adminUser.id)).toBe(true);
  });

  it("never shows another tenant's stamped row, nor a row written before the stamp existed", async () => {
    const { logs } = await list(tenantA.adminToken);
    const ids = logs.map((l) => l.id);
    expect(ids).not.toContain(stampedBId);
    expect(ids).not.toContain(unstampedId);
    // Every visible operator row carries A's stamp.
    for (const row of logs.filter((l) => l.userId === null)) {
      expect(row.newValue?.actor?.tenantId).toBe(tenantA.tenant.id);
    }
  });

  it("counts the visible rows in total", async () => {
    const { logs, total } = await list(tenantA.adminToken);
    expect(total).toBe(logs.length);
    const operatorRows = logs.filter((l) => l.userId === null).map((l) => l.entityId);
    expect(operatorRows).toEqual(
      expect.arrayContaining([stampedA.entityId, stampedAOther.entityId]),
    );
    const other = await list(tenantB.adminToken);
    expect(other.logs.map((l) => l.id)).toContain(stampedBId);
    expect(other.logs.map((l) => l.id)).not.toContain(stampedAId);
  });

  it("keeps the entity and action filters applicable to operator rows", async () => {
    const byEntity = await list(tenantA.adminToken, "&entity=Tenant");
    expect(byEntity.logs.map((l) => l.entityId)).toContain(stampedAOther.entityId);
    expect(byEntity.logs.map((l) => l.entityId)).not.toContain(stampedA.entityId);

    const byAction = await list(tenantA.adminToken, "&action=UPDATE&entity=Tenant");
    expect(byAction.logs.map((l) => l.entityId)).toContain(stampedAOther.entityId);
    for (const row of byAction.logs) {
      expect(row.action).toBe("UPDATE");
      expect(row.entity).toBe("Tenant");
    }
  });

  it("excludes operator rows when filtering by a user, and never widens the set", async () => {
    const { logs } = await list(tenantA.adminToken, `&userId=${tenantA.adminUser.id}`);
    expect(logs.length).toBeGreaterThan(0);
    for (const row of logs) expect(row.userId).toBe(tenantA.adminUser.id);

    // A foreign user id yields nothing — not tenant B's rows, not B's stamped rows.
    const foreign = await list(tenantA.adminToken, `&userId=${tenantB.adminUser.id}`);
    expect(foreign.logs).toEqual([]);
    expect(foreign.total).toBe(0);
  });
});

describe("GET /api/v1/audit-logs/:id — operator rows (D-09a, T-100-09)", () => {
  it("returns the tenant's own stamped operator row", async () => {
    const res = await get(`/api/v1/audit-logs/${stampedAId}`, tenantA.adminToken);
    expect(res.statusCode, res.body).toBe(200);
    expect(JSON.parse(res.body).entityId).toBe(stampedA.entityId);
  });

  it("answers a foreign tenant's stamped row, an unstamped row and an unknown id with the identical 404", async () => {
    const foreign = await get(`/api/v1/audit-logs/${stampedBId}`, tenantA.adminToken);
    const old = await get(`/api/v1/audit-logs/${unstampedId}`, tenantA.adminToken);
    const unknown = await get(`/api/v1/audit-logs/${randomUUID()}`, tenantA.adminToken);
    expect(foreign.statusCode).toBe(404);
    expect(old.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    expect(foreign.body).toBe(unknown.body);
    expect(old.body).toBe(unknown.body);
    expect(JSON.parse(unknown.body)).toEqual({ error: "Audit-Eintrag nicht gefunden" });
  });

  it("still answers a foreign tenant's USER row with the same 404", async () => {
    await app.audit({
      userId: tenantB.adminUser.id,
      action: "UPDATE",
      entity: "Employee",
      entityId: tenantB.adminEmployee.id,
      newValue: { fixture: true },
    });
    const row = await app.prisma.auditLog.findFirstOrThrow({
      where: { userId: tenantB.adminUser.id },
    });
    const res = await get(`/api/v1/audit-logs/${row.id}`, tenantA.adminToken);
    const unknown = await get(`/api/v1/audit-logs/${randomUUID()}`, tenantA.adminToken);
    expect(res.statusCode).toBe(404);
    expect(res.body).toBe(unknown.body);
  });
});

describe("first-admin rows of an operator-created tenant (revision R-1)", () => {
  it("are visible to that tenant's admin and to nobody else", async () => {
    mails = [];
    const slug = `t89-alv-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const email = `${slug}@example.invalid`;
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/operator/tenants",
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: {
        name: `Mandant ${slug}`,
        slug,
        federalState: "SACHSEN",
        admin: { email, firstName: "Erste", lastName: "Leitung" },
      },
      remoteAddress: uniqueAddress(),
    });
    expect(created.statusCode, created.body).toBe(201);
    const tenantC = (JSON.parse(created.body) as { tenant: { id: string } }).tenant.id;
    createdTenantIds.push(tenantC);

    const accept = await app.inject({
      method: "POST",
      url: "/api/v1/invitations/accept",
      payload: { token: mails[mails.length - 1].token, password: PASSWORD },
      remoteAddress: uniqueAddress(),
    });
    expect(accept.statusCode, accept.body).toBe(200);
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password: PASSWORD },
      remoteAddress: uniqueAddress(),
    });
    expect(login.statusCode, login.body).toBe(200);
    const tokenC = (JSON.parse(login.body) as { accessToken: string }).accessToken;

    const { logs } = await list(tokenC);
    const operatorRows = logs.filter((l) => l.userId === null);
    const kinds = operatorRows.map((l) => l.entity).sort();
    expect(kinds).toEqual(
      expect.arrayContaining(["Employee", "EmployeeSalonAssignment", "RoleAssignment"]),
    );
    for (const row of operatorRows) {
      expect(row.newValue?.actor).toEqual({ type: "OPERATOR", operatorId, tenantId: tenantC });
    }

    // Tenant A's admin sees none of them, by list and by id (identical 404).
    const seenByA = await list(tenantA.adminToken);
    const cIds = new Set(operatorRows.map((r) => r.id));
    expect(seenByA.logs.filter((l) => cIds.has(l.id))).toEqual([]);
    const unknown = await get(`/api/v1/audit-logs/${randomUUID()}`, tenantA.adminToken);
    for (const id of cIds) {
      const res = await get(`/api/v1/audit-logs/${id}`, tenantA.adminToken);
      expect(res.statusCode).toBe(404);
      expect(res.body).toBe(unknown.body);
    }
  });
});
